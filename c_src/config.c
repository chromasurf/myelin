#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "json.h"
#include "log.h"
#include "match_pattern.h"

/* A device configuration is small — a handful of origins and a setting or two
 * per script. Anything past this is a mistake, not a configuration. */
#define MAX_CONFIG_BYTES (256 * 1024)

/* Own duplicator, as in match_pattern.c and manifest.c: it keeps each file free
 * of feature-test macro juggling around strdup across the host and cross
 * toolchains, at the price of three eight-line copies. */
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

/* ------------------------------------------------------------------ *
 * growing text buffer
 * ------------------------------------------------------------------ */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
    bool failed;
} Buf;

static void buf_add(Buf *buf, const char *text, size_t len)
{
    if (buf->failed)
        return;

    if (buf->len + len + 1 > buf->cap) {
        size_t next = buf->cap ? buf->cap * 2 : 128;
        char *grown;

        while (next < buf->len + len + 1)
            next *= 2;

        grown = realloc(buf->data, next);
        if (!grown) {
            buf->failed = true;
            return;
        }

        buf->data = grown;
        buf->cap = next;
    }

    memcpy(buf->data + buf->len, text, len);
    buf->len += len;
    buf->data[buf->len] = '\0';
}

static void buf_add_str(Buf *buf, const char *text)
{
    buf_add(buf, text, strlen(text));
}

/* Hands the buffer's text to the caller and empties the buffer. */
static char *buf_take(Buf *buf)
{
    char *out = buf->failed ? NULL : buf->data;

    if (buf->failed)
        free(buf->data);

    buf->data = NULL;
    buf->len = 0;
    buf->cap = 0;
    return out;
}

/* ------------------------------------------------------------------ *
 * parsed document
 * ------------------------------------------------------------------ */

typedef struct {
    const char *json; /* not owned */
    jsmntok_t *tokens;
    int n_tokens;
} Doc;

static void doc_free(Doc *doc)
{
    free(doc->tokens);
    doc->tokens = NULL;
    doc->n_tokens = 0;
}

/* Parses `json` and requires an object at the top level. */
static bool doc_parse_object(Doc *doc, const char *json)
{
    jsmn_parser parser;
    size_t len = strlen(json);
    int n;

    doc->json = json;
    doc->tokens = NULL;
    doc->n_tokens = 0;

    jsmn_init(&parser);
    n = jsmn_parse(&parser, json, len, NULL, 0);

    if (n <= 0)
        return false;

    doc->tokens = calloc((size_t)n, sizeof(*doc->tokens));
    if (!doc->tokens)
        return false;

    jsmn_init(&parser);
    if (jsmn_parse(&parser, json, len, doc->tokens, (unsigned int)n) < 0 ||
        doc->tokens[0].type != JSMN_OBJECT) {
        doc_free(doc);
        return false;
    }

    doc->n_tokens = n;
    return true;
}

/* ------------------------------------------------------------------ *
 * raw JSON emission
 * ------------------------------------------------------------------ */

/* Appends a token's JSON text verbatim. jsmn reports string tokens *without*
 * their quotes, so those go back on — every other type carries its own
 * delimiters. The text was validated by myl_json_slice_ok() before it got here,
 * so escapes inside strings can be copied as they are. */
static void buf_add_token(Buf *buf, const Doc *doc, int index)
{
    const jsmntok_t *tok = &doc->tokens[index];
    size_t len = (size_t)(tok->end - tok->start);

    if (tok->type == JSMN_STRING) {
        buf_add_str(buf, "\"");
        buf_add(buf, doc->json + tok->start, len);
        buf_add_str(buf, "\"");
        return;
    }

    buf_add(buf, doc->json + tok->start, len);
}

/* True when the object at `index` has a key equal to `key` after decoding both.
 * Decoding matters: "a" and "a" are the same key to a JS engine, and a
 * merge that treated them as two would emit a duplicate. */
static bool object_has_key(const Doc *doc, int index, const char *key)
{
    int n = doc->tokens[index].size;
    int i = index + 1;

    for (int k = 0; k < n; k++) {
        char *text = myl_json_dup(doc->json, &doc->tokens[i]);
        bool same = text && strcmp(text, key) == 0;

        free(text);
        if (same)
            return true;

        i = myl_json_skip(doc->tokens, i + 1);
    }

    return false;
}

/* ------------------------------------------------------------------ *
 * flat merge
 * ------------------------------------------------------------------ */

/* Appends every pair of the object at `index`, skipping keys that `skip_doc`
 * already has. `first` tracks whether a comma is needed. */
static void buf_add_pairs(Buf *buf, const Doc *doc, int index, const Doc *skip_doc,
                          bool *first)
{
    int n = doc->tokens[index].size;
    int i = index + 1;

    for (int k = 0; k < n; k++) {
        int value = i + 1;

        if (skip_doc) {
            char *key = myl_json_dup(doc->json, &doc->tokens[i]);
            bool covered = key && object_has_key(skip_doc, 0, key);

            free(key);
            if (covered) {
                i = myl_json_skip(doc->tokens, value);
                continue;
            }
        }

        if (!*first)
            buf_add_str(buf, ",");
        *first = false;

        buf_add_token(buf, doc, i);
        buf_add_str(buf, ":");
        buf_add_token(buf, doc, value);

        i = myl_json_skip(doc->tokens, value);
    }
}

/* Merges two JSON object texts, key by key, with `over` winning. Returns fresh
 * text, or NULL if either side will not parse. Only the top level is merged:
 * a nested object in `over` replaces the one in `base` rather than blending
 * with it, which is the behaviour that can be explained in one sentence. */
static char *merge_objects(const char *base, const char *over)
{
    Doc base_doc = { 0 };
    Doc over_doc = { 0 };
    Buf buf = { 0 };
    bool first = true;

    if (!doc_parse_object(&base_doc, base))
        return NULL;

    if (!doc_parse_object(&over_doc, over)) {
        doc_free(&base_doc);
        return NULL;
    }

    buf_add_str(&buf, "{");
    buf_add_pairs(&buf, &base_doc, 0, &over_doc, &first);
    buf_add_pairs(&buf, &over_doc, 0, NULL, &first);
    buf_add_str(&buf, "}");

    doc_free(&base_doc);
    doc_free(&over_doc);
    return buf_take(&buf);
}

/* ------------------------------------------------------------------ *
 * the configuration itself
 * ------------------------------------------------------------------ */

typedef struct {
    char *id;
    char *json; /* raw object text, braces included */
} ScriptConfig;

struct MylConfig {
    char **trusted_origins;
    size_t n_trusted_origins;
    ScriptConfig *scripts;
    size_t n_scripts;
};

/* Both clear functions exist because a repeated top-level key gets both
 * occurrences handed to the parse loop below, and the second pass has to start
 * from an empty array: allocating a fresh one while the old count still stood
 * wrote past the end of it. Last usable occurrence wins, which is how "name"
 * and "config" already behave in manifest.c. */
static void clear_trusted_origins(MylConfig *config)
{
    for (size_t i = 0; i < config->n_trusted_origins; i++)
        free(config->trusted_origins[i]);

    free(config->trusted_origins);
    config->trusted_origins = NULL;
    config->n_trusted_origins = 0;
}

static void clear_scripts(MylConfig *config)
{
    for (size_t i = 0; i < config->n_scripts; i++) {
        free(config->scripts[i].id);
        free(config->scripts[i].json);
    }

    free(config->scripts);
    config->scripts = NULL;
    config->n_scripts = 0;
}

void myl_config_free(MylConfig *config)
{
    if (!config)
        return;

    clear_trusted_origins(config);
    clear_scripts(config);
    free(config);
}

/* An entry has to be a URL that same_origin() can take apart again, and it has
 * to name a host. Neither is checked by the type test alone, and getting it
 * wrong is silent in the worst way: myl_split_url() fails, same_origin() returns
 * false for every page, and not one meta tag on the device does anything any
 * more. "localhost:4000" without a scheme is the mistake to expect, because
 * match patterns and the domain-block allowlist both take host:port. */
static bool origin_usable(const char *value)
{
    char *scheme = NULL, *host = NULL, *port = NULL, *path = NULL;
    bool ok;

    if (!myl_split_url(value, &scheme, &host, &port, &path))
        return false;

    ok = *host != '\0';

    free(scheme);
    free(host);
    free(port);
    free(path);
    return ok;
}

static void parse_trusted_origins(MylConfig *config, const Doc *doc, int index)
{
    int n = doc->tokens[index].size;
    int i = index + 1;

    if (doc->tokens[index].type != JSMN_ARRAY) {
        myl_warn("config: trusted_origins must be an array, ignoring");
        return;
    }

    clear_trusted_origins(config);

    if (n == 0)
        return;

    config->trusted_origins = calloc((size_t)n, sizeof(*config->trusted_origins));
    if (!config->trusted_origins)
        return;

    for (int k = 0; k < n; k++) {
        if (doc->tokens[i].type == JSMN_STRING) {
            char *value = myl_json_dup(doc->json, &doc->tokens[i]);

            if (value && origin_usable(value)) {
                config->trusted_origins[config->n_trusted_origins++] = value;
            } else if (value) {
                myl_warn("config: trusted_origins entry \"%s\" is not an origin — it "
                         "needs a scheme and a host, as in \"http://localhost:4000\" — "
                         "ignoring it", value);
                free(value);
            }
        } else {
            myl_warn("config: trusted_origins entry %d is not a string, ignoring", k);
        }

        i = myl_json_skip(doc->tokens, i);
    }

    if (config->n_trusted_origins == 0)
        myl_warn("config: trusted_origins has no usable entry, so no page can "
                 "configure a script through a meta tag");
}

static void parse_scripts(MylConfig *config, const Doc *doc, int index)
{
    int n = doc->tokens[index].size;
    int i = index + 1;

    if (doc->tokens[index].type != JSMN_OBJECT) {
        myl_warn("config: scripts must be an object, ignoring");
        return;
    }

    clear_scripts(config);

    if (n == 0)
        return;

    config->scripts = calloc((size_t)n, sizeof(*config->scripts));
    if (!config->scripts)
        return;

    for (int k = 0; k < n; k++) {
        int value = i + 1;
        char *id = myl_json_dup(doc->json, &doc->tokens[i]);

        if (!id) {
            i = myl_json_skip(doc->tokens, value);
            continue;
        }

        if (doc->tokens[value].type != JSMN_OBJECT) {
            myl_warn("config: settings for \"%s\" are not an object, ignoring", id);
            free(id);
        } else if (!myl_json_slice_ok(doc->json, doc->tokens, value)) {
            /* Same bar as the manifest's own "config": this text is spliced into
             * JS source, so it has to be JSON that can travel verbatim. */
            myl_warn("config: settings for \"%s\" are not JSON that can be passed on "
                     "verbatim, ignoring", id);
            free(id);
        } else {
            const jsmntok_t *tok = &doc->tokens[value];
            char *text = dup_range(doc->json + tok->start, (size_t)(tok->end - tok->start));

            if (text) {
                config->scripts[config->n_scripts].id = id;
                config->scripts[config->n_scripts].json = text;
                config->n_scripts++;
            } else {
                free(id);
            }
        }

        i = myl_json_skip(doc->tokens, value);
    }
}

MylConfig *myl_config_parse(const char *json)
{
    MylConfig *config = calloc(1, sizeof(*config));
    Doc doc = { 0 };
    bool seen_trusted_origins = false;
    bool seen_scripts = false;
    int n_keys;
    int i;

    if (!config)
        return NULL;

    /* Unset or empty is the normal case for an application that configures
     * nothing, so it says nothing. */
    if (!json || !*json)
        return config;

    if (strlen(json) > MAX_CONFIG_BYTES) {
        myl_warn("config: larger than %d bytes, ignoring it", MAX_CONFIG_BYTES);
        return config;
    }

    if (!doc_parse_object(&doc, json)) {
        myl_warn("config: not a JSON object, ignoring it — no script loses its "
                 "manifest defaults");
        return config;
    }

    n_keys = doc.tokens[0].size;
    i = 1;

    for (int k = 0; k < n_keys; k++) {
        const jsmntok_t *key = &doc.tokens[i];
        int value = i + 1;

        if (myl_json_eq(json, key, "trusted_origins")) {
            if (seen_trusted_origins)
                myl_warn("config: trusted_origins appears more than once, the last "
                         "one wins");
            seen_trusted_origins = true;
            parse_trusted_origins(config, &doc, value);
        } else if (myl_json_eq(json, key, "scripts")) {
            if (seen_scripts)
                myl_warn("config: scripts appears more than once, the last one wins");
            seen_scripts = true;
            parse_scripts(config, &doc, value);
        } else {
            char *name = myl_json_dup(json, key);

            myl_warn("config: key \"%s\" is not supported, ignoring",
                     name ? name : "?");
            free(name);
        }

        i = myl_json_skip(doc.tokens, value);
    }

    doc_free(&doc);
    return config;
}

/* ------------------------------------------------------------------ *
 * config.json in the search path
 * ------------------------------------------------------------------ */

static char *read_file(const char *path)
{
    FILE *file = fopen(path, "rb");
    long size;
    char *buffer;
    size_t read_bytes;

    if (!file)
        return NULL;

    if (fseek(file, 0, SEEK_END) != 0 || (size = ftell(file)) < 0 ||
        fseek(file, 0, SEEK_SET) != 0) {
        myl_warn("config: cannot determine the size of %s", path);
        fclose(file);
        return NULL;
    }

    if (size > MAX_CONFIG_BYTES) {
        myl_warn("config: %s is larger than %d bytes, refusing to read", path,
                 MAX_CONFIG_BYTES);
        fclose(file);
        return NULL;
    }

    /* An interrupted scp, or a "> config.json" before pasting, leaves a file of
     * no bytes. Handing back an empty string for it would make the caller treat
     * it as a configuration that happens to set nothing — and because the last
     * file in the search path wins outright, it would also discard a good one
     * from an earlier directory. So say so and count as absent: no bytes is not
     * a configuration. */
    if (size == 0) {
        myl_warn("config: %s is empty, ignoring it", path);
        fclose(file);
        return NULL;
    }

    buffer = malloc((size_t)size + 1);
    if (!buffer) {
        fclose(file);
        return NULL;
    }

    read_bytes = fread(buffer, 1, (size_t)size, file);
    fclose(file);

    /* A directory named config.json opens and seeks like a file on Linux and
     * then reads nothing, which is the same silent wipe by another route. */
    if (read_bytes != (size_t)size) {
        myl_warn("config: cannot read %s (got %zu of %ld bytes), ignoring it", path,
                 read_bytes, size);
        free(buffer);
        return NULL;
    }

    buffer[read_bytes] = '\0';
    return buffer;
}

MylConfig *myl_config_load_path(const char *const *search_path, size_t n_entries)
{
    char *found = NULL;
    MylConfig *config;

    for (size_t e = 0; e < n_entries; e++) {
        size_t len = strlen(search_path[e]);
        bool needs_sep = len > 0 && search_path[e][len - 1] != '/';
        size_t size = len + (needs_sep ? 1 : 0) + strlen("config.json") + 1;
        char *path = malloc(size);
        char *text;

        if (!path)
            continue;

        snprintf(path, size, "%s%sconfig.json", search_path[e], needs_sep ? "/" : "");
        text = read_file(path);

        if (text) {
            /* The last directory that has a readable one wins outright. Falling
             * back to an earlier file when a later one is *malformed* would mean a
             * typo silently resurrects settings someone thought they had replaced,
             * so that case keeps winning and gets warned about downstream. A file
             * read_file() rejected outright — empty, or not readable at all — never
             * gets here, and an earlier directory's config stands. */
            free(found);
            found = text;
            myl_debug("config: reading %s", path);
        }

        free(path);
    }

    config = myl_config_parse(found);
    free(found);
    return config;
}

/* ------------------------------------------------------------------ *
 * applying it
 * ------------------------------------------------------------------ */

static const char *script_config_for(const MylConfig *config, const char *id)
{
    for (size_t i = 0; i < config->n_scripts; i++) {
        if (strcmp(config->scripts[i].id, id) == 0)
            return config->scripts[i].json;
    }

    return NULL;
}

/* The coupling between a configuration key and a script id is the directory
 * name, and it is silent: a typo means settings that arrive nowhere at all. */
static void warn_unmatched(const MylConfig *config, const MylManifestList *list)
{
    for (size_t i = 0; i < config->n_scripts; i++) {
        bool matched = false;
        Buf loaded = { 0 };

        for (size_t m = 0; m < list->n_items; m++) {
            if (strcmp(list->items[m].id, config->scripts[i].id) == 0) {
                matched = true;
                break;
            }
        }

        if (matched)
            continue;

        for (size_t m = 0; m < list->n_items; m++) {
            if (m > 0)
                buf_add_str(&loaded, ", ");
            buf_add_str(&loaded, list->items[m].id);
        }

        {
            char *names = buf_take(&loaded);

            myl_warn("config for \"%s\" matches no script (loaded: %s)",
                     config->scripts[i].id, names ? names : "none");
            free(names);
        }
    }
}

void myl_config_apply(const MylConfig *config, MylManifestList *list)
{
    if (!config || !list)
        return;

    for (size_t i = 0; i < list->n_items; i++) {
        MylManifest *manifest = &list->items[i];
        const char *over = script_config_for(config, manifest->id);

        if (!over)
            continue;

        if (!manifest->config) {
            manifest->config = dup_str(over);
            continue;
        }

        {
            char *merged = merge_objects(manifest->config, over);

            if (!merged) {
                myl_warn("%s: could not merge the device configuration, keeping the "
                         "manifest defaults", manifest->id);
                continue;
            }

            free(manifest->config);
            manifest->config = merged;
        }
    }

    warn_unmatched(config, list);
}

/* ------------------------------------------------------------------ *
 * trusted origins
 * ------------------------------------------------------------------ */

static bool same_origin(const char *a, const char *b)
{
    char *a_scheme = NULL, *a_host = NULL, *a_port = NULL, *a_path = NULL;
    char *b_scheme = NULL, *b_host = NULL, *b_port = NULL, *b_path = NULL;
    bool ok = false;

    if (!myl_split_url(a, &a_scheme, &a_host, &a_port, &a_path))
        return false;

    if (!myl_split_url(b, &b_scheme, &b_host, &b_port, &b_path)) {
        free(a_scheme);
        free(a_host);
        free(a_port);
        free(a_path);
        return false;
    }

    /* An entry without a port means "no port", not "any port". Trust is not the
     * place to be generous: http://localhost and http://localhost:8080 are
     * different origins to a browser, and they are different here too. */
    ok = strcmp(a_scheme, b_scheme) == 0 && strcmp(a_host, b_host) == 0 &&
         ((!a_port && !b_port) || (a_port && b_port && strcmp(a_port, b_port) == 0));

    free(a_scheme);
    free(a_host);
    free(a_port);
    free(a_path);
    free(b_scheme);
    free(b_host);
    free(b_port);
    free(b_path);
    return ok;
}

bool myl_config_origin_trusted(const MylConfig *config, const char *url)
{
    if (!config || !url || !*url)
        return false;

    for (size_t i = 0; i < config->n_trusted_origins; i++) {
        if (same_origin(config->trusted_origins[i], url))
            return true;
    }

    return false;
}

/* ------------------------------------------------------------------ *
 * whether a script runs
 * ------------------------------------------------------------------ */

/* True when `list` — a space separated set of script ids, as a myelin-enable or
 * myelin-disable meta tag carries them — contains `id`. */
static bool list_contains(const char *list, const char *id)
{
    size_t id_len = strlen(id);
    const char *cursor = list;

    if (!list)
        return false;

    while (*cursor) {
        size_t len;

        while (*cursor == ' ' || *cursor == '\t' || *cursor == '\n' || *cursor == '\r')
            cursor++;

        len = strcspn(cursor, " \t\n\r");
        if (len == 0)
            break;

        if (len == id_len && strncmp(cursor, id, len) == 0)
            return true;

        cursor += len;
    }

    return false;
}

/* Reads a boolean directly out of an object's raw text. Only the top level, and
 * only a real true/false — anything else leaves `*out` alone. */
static bool lookup_bool(const char *json, const char *key, bool *out)
{
    Doc doc = { 0 };
    int n_keys;
    int i;
    bool found = false;

    if (!json || !doc_parse_object(&doc, json))
        return false;

    n_keys = doc.tokens[0].size;
    i = 1;

    for (int k = 0; k < n_keys; k++) {
        int value = i + 1;

        if (myl_json_eq(json, &doc.tokens[i], key)) {
            if (myl_json_is_true(json, &doc.tokens[value])) {
                *out = true;
                found = true;
            } else if (myl_json_is_false(json, &doc.tokens[value])) {
                *out = false;
                found = true;
            }
            break;
        }

        i = myl_json_skip(doc.tokens, value);
    }

    doc_free(&doc);
    return found;
}

bool myl_script_enabled(const MylManifest *manifest, const char *enable_meta,
                        const char *disable_meta)
{
    bool enabled;

    if (!manifest)
        return false;

    enabled = manifest->enabled;

    /* The device has the last word before the page does. */
    lookup_bool(manifest->config, "enabled", &enabled);

    /* Both are NULL on an untrusted origin, so a foreign page cannot switch a
     * script off by claiming myelin-disable, which is the property this rests on. */
    if (list_contains(disable_meta, manifest->id))
        return false;

    if (list_contains(enable_meta, manifest->id))
        return true;

    return enabled;
}
