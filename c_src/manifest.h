/*
 * manifest.h — manifest.json loading.
 *
 * The format is a small subset of a WebExtension MV3 manifest.
 * It is a *file format* only: there is no chrome.* / browser.* API behind it,
 * because WPE WebKit exposes no WebExtension bindings to GLib. Keys outside
 * the subset below are reported once and then ignored.
 *
 *   {
 *     "manifest_version": 3,
 *     "name": "Onscreen Keyboard",
 *     "version": "1.0",
 *     "enabled": true,
 *     "config": { "layout": "de" },
 *     "content_scripts": [
 *       {
 *         "matches":         ["http://localhost:4000/..."],
 *         "exclude_matches": [],
 *         "js":              ["keyboard.js"],
 *         "css":             ["keyboard.css"],
 *         "shadow_css":      [],
 *         "run_at":          "document_end",
 *         "all_frames":      false
 *       }
 *     ]
 *   }
 *
 * Three keys are our own additions, none of them MV3:
 *
 *   "enabled"     whether the script runs unless something says otherwise.
 *                 Defaults to false: nothing runs until it is asked for, by the
 *                 device configuration or — on a trusted origin — a
 *                 myelin-enable/myelin-disable meta tag.
 *   "config"      default settings for this script, free-formed. Kept as raw
 *                 JSON text and handed to the script unchanged; the device
 *                 configuration overrides it key by key. A script that declares
 *                 its settings in ctx.script() needs none of this.
 *   "shadow_css"  stylesheets the script receives as text instead of having
 *                 them injected into the page, so it can put them in a shadow
 *                 root. Both lists may be used at once: a script that both
 *                 styles the page and owns an encapsulated widget needs both.
 */

#ifndef MYL_MANIFEST_H
#define MYL_MANIFEST_H

#include <stdbool.h>
#include <stddef.h>

#include "match_pattern.h"

typedef enum {
    MYL_RUN_AT_DOCUMENT_START,
    MYL_RUN_AT_DOCUMENT_END, /* default */
    MYL_RUN_AT_DOCUMENT_IDLE
} MylRunAt;

typedef struct {
    MylMatchPattern *matches;
    size_t n_matches;
    MylMatchPattern *excludes;
    size_t n_excludes;
    char **js; /* file names, relative to the manifest directory */
    size_t n_js;
    char **css; /* injected into the page as a <style> element */
    size_t n_css;
    char **shadow_css; /* handed to the script as text, not injected */
    size_t n_shadow_css;
    MylRunAt run_at;
    bool all_frames;
} MylContentScript;

typedef struct {
    char *id;   /* directory name, unique across the search path */
    char *dir;  /* absolute path to the directory holding manifest.json */
    char *name; /* "name" from the manifest, or a copy of id if absent */
    /* Raw JSON text of the "config" object, braces included, or NULL. Never
     * parsed into a structure: the contents are the script's own business and
     * are passed through verbatim. myl_config_apply() replaces this with the
     * merged result once the device configuration is known. */
    char *config;
    bool enabled; /* runs unless the device or a trusted page says otherwise */
    MylContentScript *scripts;
    size_t n_scripts;
} MylManifest;

typedef struct {
    MylManifest *items;
    size_t n_items;
} MylManifestList;

/* Parses manifest JSON. `id` and `dir` describe where it came from and are
 * copied into the result. Returns NULL on a malformed manifest, having logged
 * the reason. */
MylManifest *myl_manifest_parse(const char *json, size_t len, const char *id,
                                const char *dir);

/* Reads `dir`/manifest.json and parses it. Returns NULL if the file is
 * missing or malformed. */
MylManifest *myl_manifest_load_dir(const char *dir, const char *id);

void myl_manifest_free(MylManifest *manifest);

/* Scans every directory in `search_path` for subdirectories containing a
 * manifest.json. Later entries win: a script id found again in a later
 * directory replaces the earlier one entirely. Manifests with "enabled":false
 * are kept — whether a script actually runs is decided per page by
 * myl_script_enabled(), which the device configuration and a trusted page's
 * meta tags also have a say in. Never returns NULL; the list may be empty. */
MylManifestList *myl_manifest_load_path(const char *const *search_path,
                                        size_t n_entries);

void myl_manifest_list_free(MylManifestList *list);

/* True when `url` matches at least one "matches" pattern and no
 * "exclude_matches" pattern. */
bool myl_content_script_matches(const MylContentScript *script, const char *url);

/* True when `name` is a file name a manifest may reference: a relative path
 * that cannot leave the script's own directory. A subdirectory is allowed, so a
 * build can write into one ("build/branding.js"); an absolute path, an empty
 * segment, "." or ".." as a segment, and backslashes are not.
 *
 * Names are checked while the manifest is parsed, so a bad one warns once at
 * startup and drops out of the list — rather than warning on every page load. */
bool myl_relative_path_ok(const char *name);

/* Splits a colon-separated search path such as MYELIN_PATH into a
 * NULL-terminated array. Free with myl_strv_free(). Returns NULL if `value`
 * is NULL or empty. */
char **myl_split_search_path(const char *value);

void myl_strv_free(char **strv);

#endif /* MYL_MANIFEST_H */
