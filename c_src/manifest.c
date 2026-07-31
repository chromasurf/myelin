#include "manifest.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "json.h"
#include "log.h"

#define MAX_MANIFEST_BYTES (256 * 1024)

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

static char *dup_range(const char *start, size_t len)
{
    char *out = malloc(len + 1);

    if (!out)
        return NULL;

    memcpy(out, start, len);
    out[len] = '\0';
    return out;
}

static char *dup_str(const char *s)
{
    return dup_range(s, strlen(s));
}

static char *join_path(const char *dir, const char *name)
{
    size_t dir_len = strlen(dir);
    bool needs_sep = dir_len > 0 && dir[dir_len - 1] != '/';
    size_t len = dir_len + (needs_sep ? 1 : 0) + strlen(name);
    char *out = malloc(len + 1);

    if (!out)
        return NULL;

    snprintf(out, len + 1, "%s%s%s", dir, needs_sep ? "/" : "", name);
    return out;
}

static void strv_free_n(char **strv, size_t n)
{
    if (!strv)
        return;

    for (size_t i = 0; i < n; i++)
        free(strv[i]);

    free(strv);
}

void myl_strv_free(char **strv)
{
    if (!strv)
        return;

    for (char **p = strv; *p; p++)
        free(*p);

    free(strv);
}

bool myl_relative_path_ok(const char *name)
{
    const char *segment = name;

    if (!name || !*name || *name == '/' || strchr(name, '\\'))
        return false;

    /* Walk the segments rather than searching for "..": a plain strstr would
     * reject "a..b" and accept "a/../../etc". */
    for (;;) {
        const char *slash = strchr(segment, '/');
        size_t len = slash ? (size_t)(slash - segment) : strlen(segment);

        if (len == 0)
            return false; /* empty segment: leading, trailing or doubled slash */
        if (len == 1 && segment[0] == '.')
            return false;
        if (len == 2 && segment[0] == '.' && segment[1] == '.')
            return false;

        if (!slash)
            return true;
        segment = slash + 1;
    }
}

/* Collects an array of JSON strings. Non-string members are skipped with a
 * warning rather than failing the whole manifest. */
static char **parse_string_array(const char *json, const jsmntok_t *tokens, int index,
                                 size_t *count_out, const char *context)
{
    int n = tokens[index].size;
    char **out;
    size_t written = 0;
    int i = index + 1;

    *count_out = 0;

    if (tokens[index].type != JSMN_ARRAY) {
        myl_warn("%s: expected an array, ignoring", context);
        return NULL;
    }

    if (n == 0)
        return NULL;

    out = calloc((size_t)n, sizeof(*out));
    if (!out)
        return NULL;

    for (int k = 0; k < n; k++) {
        if (tokens[i].type == JSMN_STRING) {
            char *value = myl_json_dup(json, &tokens[i]);

            if (value)
                out[written++] = value;
        } else {
            myl_warn("%s: entry %d is not a string, ignoring", context, k);
        }
        i = myl_json_skip(tokens, i);
    }

    if (written == 0) {
        free(out);
        return NULL;
    }

    *count_out = written;
    return out;
}

/* Like parse_string_array, but for names that will be opened relative to the
 * script's directory. A name that could escape it drops out here, with one
 * warning at load time rather than one per page. */
static char **parse_file_array(const char *json, const jsmntok_t *tokens, int index,
                               size_t *count_out, const char *context)
{
    size_t n = 0;
    char **out = parse_string_array(json, tokens, index, &n, context);
    size_t kept = 0;

    *count_out = 0;

    if (!out)
        return NULL;

    for (size_t i = 0; i < n; i++) {
        if (myl_relative_path_ok(out[i])) {
            out[kept++] = out[i];
            continue;
        }

        myl_warn("%s: file name \"%s\" must stay inside the script directory, ignoring",
                 context, out[i]);
        free(out[i]);
    }

    if (kept == 0) {
        free(out);
        return NULL;
    }

    *count_out = kept;
    return out;
}

static MylMatchPattern *parse_pattern_array(const char *json, const jsmntok_t *tokens,
                                            int index, size_t *count_out,
                                            const char *context)
{
    size_t n_strings = 0;
    char **strings = parse_string_array(json, tokens, index, &n_strings, context);
    MylMatchPattern *out;
    size_t written = 0;

    *count_out = 0;

    if (!strings)
        return NULL;

    out = calloc(n_strings, sizeof(*out));
    if (!out) {
        strv_free_n(strings, n_strings);
        return NULL;
    }

    for (size_t i = 0; i < n_strings; i++) {
        if (myl_match_pattern_parse(strings[i], &out[written]))
            written++;
        else
            myl_warn("%s: malformed match pattern \"%s\", ignoring", context, strings[i]);
    }

    strv_free_n(strings, n_strings);

    if (written == 0) {
        free(out);
        return NULL;
    }

    *count_out = written;
    return out;
}

/* ------------------------------------------------------------------ *
 * content_scripts
 * ------------------------------------------------------------------ */

static void content_script_clear(MylContentScript *script)
{
    for (size_t i = 0; i < script->n_matches; i++)
        myl_match_pattern_clear(&script->matches[i]);
    free(script->matches);

    for (size_t i = 0; i < script->n_excludes; i++)
        myl_match_pattern_clear(&script->excludes[i]);
    free(script->excludes);

    strv_free_n(script->js, script->n_js);
    strv_free_n(script->css, script->n_css);
    strv_free_n(script->shadow_css, script->n_shadow_css);
    memset(script, 0, sizeof(*script));
}

static bool parse_run_at(const char *value, MylRunAt *out, const char *context)
{
    if (strcmp(value, "document_start") == 0)
        *out = MYL_RUN_AT_DOCUMENT_START;
    else if (strcmp(value, "document_end") == 0)
        *out = MYL_RUN_AT_DOCUMENT_END;
    else if (strcmp(value, "document_idle") == 0)
        *out = MYL_RUN_AT_DOCUMENT_IDLE;
    else {
        myl_warn("%s: unknown run_at \"%s\", falling back to document_end", context,
                 value);
        *out = MYL_RUN_AT_DOCUMENT_END;
        return false;
    }

    return true;
}

/* Parses one content_scripts entry. Returns the index just past it. */
static int parse_content_script(const char *json, const jsmntok_t *tokens, int index,
                                MylContentScript *script, const char *id)
{
    int n_keys;
    int i;

    memset(script, 0, sizeof(*script));
    script->run_at = MYL_RUN_AT_DOCUMENT_END;

    if (tokens[index].type != JSMN_OBJECT) {
        myl_warn("%s: content_scripts entry is not an object, ignoring", id);
        return myl_json_skip(tokens, index);
    }

    n_keys = tokens[index].size;
    i = index + 1;

    for (int k = 0; k < n_keys; k++) {
        const jsmntok_t *key = &tokens[i];
        int value = i + 1;

        if (myl_json_eq(json, key, "matches")) {
            script->matches =
                parse_pattern_array(json, tokens, value, &script->n_matches, id);
        } else if (myl_json_eq(json, key, "exclude_matches")) {
            script->excludes =
                parse_pattern_array(json, tokens, value, &script->n_excludes, id);
        } else if (myl_json_eq(json, key, "js")) {
            script->js = parse_file_array(json, tokens, value, &script->n_js, id);
        } else if (myl_json_eq(json, key, "css")) {
            script->css = parse_file_array(json, tokens, value, &script->n_css, id);
        } else if (myl_json_eq(json, key, "shadow_css")) {
            script->shadow_css =
                parse_file_array(json, tokens, value, &script->n_shadow_css, id);
        } else if (myl_json_eq(json, key, "run_at")) {
            if (tokens[value].type == JSMN_STRING) {
                char *text = myl_json_dup(json, &tokens[value]);

                if (text) {
                    parse_run_at(text, &script->run_at, id);
                    free(text);
                }
            } else {
                myl_warn("%s: run_at is not a string, using document_end", id);
            }
        } else if (myl_json_eq(json, key, "all_frames")) {
            script->all_frames = myl_json_is_true(json, &tokens[value]);
        } else {
            char *name = myl_json_dup(json, key);

            myl_warn("%s: content_scripts key \"%s\" is not supported, ignoring",
                     id, name ? name : "?");
            free(name);
        }

        i = myl_json_skip(tokens, value);
    }

    if (script->n_matches == 0)
        myl_warn("%s: content_scripts entry has no usable \"matches\", it will never run",
                 id);

    if (script->n_js == 0 && script->n_css == 0 && script->n_shadow_css == 0)
        myl_warn("%s: content_scripts entry lists neither \"js\" nor \"css\"", id);

    return i;
}

/* ------------------------------------------------------------------ *
 * manifest
 * ------------------------------------------------------------------ */

/* Takes the raw text of the "config" object, braces included. It is not parsed
 * into a structure — the contents belong to the script — but it does end up
 * inside JS source, so it must be an object and it must survive
 * myl_json_slice_ok(), which is stricter about primitives than jsmn is. */
static char *parse_config_slice(const char *json, const jsmntok_t *tokens, int index,
                                const char *id)
{
    const jsmntok_t *tok = &tokens[index];

    if (tok->type != JSMN_OBJECT) {
        myl_warn("%s: \"config\" must be an object, ignoring", id);
        return NULL;
    }

    if (!myl_json_slice_ok(json, tokens, index)) {
        myl_warn("%s: \"config\" is not JSON that can be passed on verbatim, ignoring",
                 id);
        return NULL;
    }

    return dup_range(json + tok->start, (size_t)(tok->end - tok->start));
}

/* Frees everything a manifest owns, but not the manifest itself: the list holds
 * them by value while myl_manifest_free() holds one by pointer. In one place, so a
 * new field is only forgotten once. */
static void manifest_clear(MylManifest *manifest)
{
    for (size_t i = 0; i < manifest->n_scripts; i++)
        content_script_clear(&manifest->scripts[i]);

    free(manifest->scripts);
    free(manifest->id);
    free(manifest->dir);
    free(manifest->name);
    free(manifest->config);
}

void myl_manifest_free(MylManifest *manifest)
{
    if (!manifest)
        return;

    manifest_clear(manifest);
    free(manifest);
}

MylManifest *myl_manifest_parse(const char *json, size_t len, const char *id,
                                const char *dir)
{
    jsmn_parser parser;
    jsmntok_t *tokens = NULL;
    MylManifest *manifest = NULL;
    int n_tokens;
    int n_keys;
    int i;

    jsmn_init(&parser);
    n_tokens = jsmn_parse(&parser, json, len, NULL, 0);

    if (n_tokens < 0) {
        myl_warn("%s: manifest.json is not valid JSON (jsmn error %d)", id, n_tokens);
        return NULL;
    }

    if (n_tokens == 0) {
        myl_warn("%s: manifest.json is empty", id);
        return NULL;
    }

    tokens = calloc((size_t)n_tokens, sizeof(*tokens));
    if (!tokens)
        return NULL;

    jsmn_init(&parser);
    if (jsmn_parse(&parser, json, len, tokens, (unsigned int)n_tokens) < 0) {
        myl_warn("%s: manifest.json is not valid JSON", id);
        free(tokens);
        return NULL;
    }

    if (tokens[0].type != JSMN_OBJECT) {
        myl_warn("%s: manifest.json must contain an object at the top level", id);
        free(tokens);
        return NULL;
    }

    manifest = calloc(1, sizeof(*manifest));
    if (!manifest) {
        free(tokens);
        return NULL;
    }

    /* Nothing runs unless it is asked for. A script whose manifest says nothing is
     * dormant, which is also what a script somebody wrote themselves should be
     * before they have said where it belongs. */
    manifest->enabled = false;
    manifest->id = dup_str(id);
    manifest->dir = dup_str(dir);

    if (!manifest->id || !manifest->dir)
        goto fail;

    n_keys = tokens[0].size;
    i = 1;

    for (int k = 0; k < n_keys; k++) {
        const jsmntok_t *key = &tokens[i];
        int value = i + 1;

        if (myl_json_eq(json, key, "name")) {
            free(manifest->name);
            manifest->name = myl_json_dup(json, &tokens[value]);
        } else if (myl_json_eq(json, key, "enabled")) {
            manifest->enabled = !myl_json_is_false(json, &tokens[value]);
        } else if (myl_json_eq(json, key, "config")) {
            free(manifest->config);
            manifest->config = parse_config_slice(json, tokens, value, id);
        } else if (myl_json_eq(json, key, "content_scripts")) {
            int n_entries = tokens[value].size;

            if (tokens[value].type != JSMN_ARRAY) {
                myl_warn("%s: content_scripts must be an array", id);
            } else if (n_entries > 0) {
                int entry = value + 1;

                /* A manifest that names content_scripts twice gets both arrays
                 * handed to this loop. Allocating for the second while the first
                 * one's count still stood wrote past the end of the new array, so
                 * the previous pass is released here first — last one wins, as it
                 * does for "name" and "config" just above. */
                for (size_t s = 0; s < manifest->n_scripts; s++)
                    content_script_clear(&manifest->scripts[s]);
                free(manifest->scripts);
                manifest->n_scripts = 0;

                manifest->scripts = calloc((size_t)n_entries, sizeof(*manifest->scripts));
                if (!manifest->scripts)
                    goto fail;

                for (int e = 0; e < n_entries; e++) {
                    entry = parse_content_script(json, tokens, entry,
                                                 &manifest->scripts[manifest->n_scripts],
                                                 id);
                    manifest->n_scripts++;
                }
            }
        } else if (myl_json_eq(json, key, "manifest_version") ||
                   myl_json_eq(json, key, "version") ||
                   myl_json_eq(json, key, "description")) {
            /* Accepted and ignored: informational only. */
        } else {
            char *name = myl_json_dup(json, key);

            myl_warn("%s: manifest key \"%s\" is not supported, ignoring", id,
                     name ? name : "?");
            free(name);
        }

        i = myl_json_skip(tokens, value);
    }

    if (!manifest->name)
        manifest->name = dup_str(id);

    free(tokens);
    return manifest;

fail:
    free(tokens);
    myl_manifest_free(manifest);
    return NULL;
}

MylManifest *myl_manifest_load_dir(const char *dir, const char *id)
{
    char *path = join_path(dir, "manifest.json");
    FILE *file;
    long size;
    char *buffer;
    size_t read_bytes;
    MylManifest *manifest;

    if (!path)
        return NULL;

    file = fopen(path, "rb");
    if (!file) {
        free(path);
        return NULL;
    }

    if (fseek(file, 0, SEEK_END) != 0 || (size = ftell(file)) < 0 ||
        fseek(file, 0, SEEK_SET) != 0) {
        myl_warn("%s: cannot determine the size of %s", id, path);
        fclose(file);
        free(path);
        return NULL;
    }

    if (size > MAX_MANIFEST_BYTES) {
        myl_warn("%s: manifest.json is larger than %d bytes, refusing to read", id,
                 MAX_MANIFEST_BYTES);
        fclose(file);
        free(path);
        return NULL;
    }

    buffer = malloc((size_t)size + 1);
    if (!buffer) {
        fclose(file);
        free(path);
        return NULL;
    }

    read_bytes = fread(buffer, 1, (size_t)size, file);
    fclose(file);
    buffer[read_bytes] = '\0';

    manifest = myl_manifest_parse(buffer, read_bytes, id, dir);

    free(buffer);
    free(path);
    return manifest;
}

/* ------------------------------------------------------------------ *
 * search path
 * ------------------------------------------------------------------ */

char **myl_split_search_path(const char *value)
{
    size_t count = 1;
    char **out;
    size_t written = 0;
    const char *cursor = value;

    if (!value || !*value)
        return NULL;

    for (const char *c = value; *c; c++) {
        if (*c == ':')
            count++;
    }

    out = calloc(count + 1, sizeof(*out));
    if (!out)
        return NULL;

    while (*cursor) {
        const char *sep = strchr(cursor, ':');
        size_t len = sep ? (size_t)(sep - cursor) : strlen(cursor);

        if (len > 0) {
            out[written] = dup_range(cursor, len);
            if (!out[written]) {
                myl_strv_free(out);
                return NULL;
            }
            written++;
        }

        if (!sep)
            break;
        cursor = sep + 1;
    }

    if (written == 0) {
        myl_strv_free(out);
        return NULL;
    }

    return out;
}

static int compare_names(const void *a, const void *b)
{
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

/* Reads the sorted list of subdirectory names in `dir`. Sorting keeps the
 * injection order deterministic, since readdir() order is not. */
static char **list_subdirectories(const char *dir, size_t *count_out)
{
    DIR *handle = opendir(dir);
    struct dirent *entry;
    char **names = NULL;
    size_t count = 0;
    size_t capacity = 0;

    *count_out = 0;

    if (!handle)
        return NULL;

    while ((entry = readdir(handle)) != NULL) {
        char *path;
        struct stat info;

        if (entry->d_name[0] == '.')
            continue;

        path = join_path(dir, entry->d_name);
        if (!path)
            continue;

        if (stat(path, &info) != 0 || !S_ISDIR(info.st_mode)) {
            free(path);
            continue;
        }
        free(path);

        if (count == capacity) {
            size_t next = capacity ? capacity * 2 : 8;
            char **grown = realloc(names, next * sizeof(*names));

            if (!grown)
                break;

            names = grown;
            capacity = next;
        }

        names[count] = dup_str(entry->d_name);
        if (!names[count])
            break;
        count++;
    }

    closedir(handle);

    if (count == 0) {
        free(names);
        return NULL;
    }

    qsort(names, count, sizeof(*names), compare_names);
    *count_out = count;
    return names;
}

static int find_manifest(const MylManifestList *list, const char *id)
{
    for (size_t i = 0; i < list->n_items; i++) {
        if (strcmp(list->items[i].id, id) == 0)
            return (int)i;
    }

    return -1;
}

void myl_manifest_list_free(MylManifestList *list)
{
    if (!list)
        return;

    for (size_t i = 0; i < list->n_items; i++)
        manifest_clear(&list->items[i]);

    free(list->items);
    free(list);
}

MylManifestList *myl_manifest_load_path(const char *const *search_path,
                                        size_t n_entries)
{
    MylManifestList *list = calloc(1, sizeof(*list));
    size_t capacity = 0;

    if (!list)
        return NULL;

    for (size_t e = 0; e < n_entries; e++) {
        size_t n_names = 0;
        char **names = list_subdirectories(search_path[e], &n_names);

        if (!names) {
            myl_debug("no scripts in %s", search_path[e]);
            continue;
        }

        for (size_t n = 0; n < n_names; n++) {
            char *dir = join_path(search_path[e], names[n]);
            MylManifest *manifest;
            int existing;

            if (!dir)
                continue;

            manifest = myl_manifest_load_dir(dir, names[n]);
            free(dir);

            if (!manifest)
                continue;

            existing = find_manifest(list, manifest->id);

            if (existing >= 0) {
                /* Later search-path entries win outright. */
                MylManifest *slot = &list->items[existing];

                myl_debug("%s: overridden by %s", slot->id, manifest->dir);

                manifest_clear(slot);
                *slot = *manifest;
                free(manifest); /* contents moved into the slot */
                continue;
            }

            if (list->n_items == capacity) {
                size_t next = capacity ? capacity * 2 : 8;
                MylManifest *grown = realloc(list->items, next * sizeof(*grown));

                if (!grown) {
                    myl_manifest_free(manifest);
                    break;
                }

                list->items = grown;
                capacity = next;
            }

            list->items[list->n_items++] = *manifest;
            free(manifest); /* contents moved into the list */
        }

        strv_free_n(names, n_names);
    }

    /* "enabled": false does not drop a manifest here. It is a default state, and
     * the device configuration or a trusted page can override it — so the decision
     * belongs per page, in myl_script_enabled(), not to this scan. */
    return list;
}

bool myl_content_script_matches(const MylContentScript *script, const char *url)
{
    bool included = false;

    if (!script || !url)
        return false;

    for (size_t i = 0; i < script->n_matches; i++) {
        if (myl_match_pattern_matches(&script->matches[i], url)) {
            included = true;
            break;
        }
    }

    if (!included)
        return false;

    for (size_t i = 0; i < script->n_excludes; i++) {
        if (myl_match_pattern_matches(&script->excludes[i], url))
            return false;
    }

    return true;
}
