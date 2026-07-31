/*
 * extension.c — WPE WebKit web process extension entry point.
 *
 * Cog loads every .so in the directory given to --web-extensions-dir and calls
 * webkit_web_process_extension_initialize() in the web process. From there we
 * hook the two moments a userscript can run at:
 *
 *   document_start  ->  WebKitScriptWorld::window-object-cleared, which fires
 *                       once per frame before any page script runs.
 *   document_end    ->  WebKitWebPage::document-loaded.
 *   document_idle   ->  a low-priority idle source queued after document-loaded.
 *
 * Manifests are read once, when the web process starts. There is no reload
 * channel in this version: changes take effect after Cog restarts.
 */

#include <glib.h>
#include <jsc/jsc.h>
#include <wpe/webkit-web-process-extension.h>

#include "config.h"
#include "injector.h"
#include "log.h"
#include "manifest.h"

#define CUS_LOG_DOMAIN "cog-userscripts"

/* Used when COG_USERSCRIPTS_PATH is unset. That is the kiosk with no application
 * behind it — nobody calling CogUserscripts.cog_env/1 — and since the library
 * contributes no scripts of its own, this is then the whole search path rather
 * than a fallback with a gap in it. */
#define CUS_DEFAULT_SEARCH_PATH "/data/cog-userscripts"

static CusManifestList *s_manifests;
static CusConfig *s_config;

/* ------------------------------------------------------------------ *
 * logging
 * ------------------------------------------------------------------ */

static void forward_to_glib(CusLogLevel level, const char *message, void *user_data)
{
    (void)user_data;

    if (level == CUS_LOG_WARNING)
        g_log(CUS_LOG_DOMAIN, G_LOG_LEVEL_WARNING, "%s", message);
    else
        g_log(CUS_LOG_DOMAIN, G_LOG_LEVEL_DEBUG, "%s", message);
}

/* ------------------------------------------------------------------ *
 * injection
 * ------------------------------------------------------------------ */

/* Reads the content of a cog-enable / cog-disable meta tag, or NULL when the tag
 * is absent. One evaluation for both, once per pass — which is also cheaper than
 * once per document rather than once per script.
 *
 * Only ever called for a trusted origin. At document_start the <head> is
 * typically not parsed yet, so this comes back empty and the manifest and device
 * settings decide, which is what the README has always said about meta tags. */
static void read_switch_tags(JSCContext *context, char **enable, char **disable)
{
    static const char kReadTags[] =
        "(function () {\n"
        "  var read = function (name) {\n"
        "    var el = document.querySelector('meta[name=\"cog-' + name + '\"]');\n"
        "    return el ? el.content : null;\n"
        "  };\n"
        "  return [read('enable'), read('disable')];\n"
        "})()";
    g_autoptr(JSCValue) pair = jsc_context_evaluate(context, kReadTags, -1);
    g_autoptr(JSCValue) enable_value = NULL;
    g_autoptr(JSCValue) disable_value = NULL;

    *enable = NULL;
    *disable = NULL;

    if (jsc_context_get_exception(context)) {
        jsc_context_clear_exception(context);
        return;
    }

    if (!pair || !jsc_value_is_array(pair))
        return;

    enable_value = jsc_value_object_get_property_at_index(pair, 0);
    disable_value = jsc_value_object_get_property_at_index(pair, 1);

    if (enable_value && jsc_value_is_string(enable_value))
        *enable = jsc_value_to_string(enable_value);

    if (disable_value && jsc_value_is_string(disable_value))
        *disable = jsc_value_to_string(disable_value);
}

/* Runs every script whose run_at equals `when` and whose patterns match `uri`.
 * `main_frame` drives the all_frames check. */
static void run_matching(JSCContext *context, const char *uri, CusRunAt when,
                         gboolean main_frame)
{
    gboolean trusted;
    g_autofree char *enable = NULL;
    g_autofree char *disable = NULL;

    if (!s_manifests || !context || !uri || !*uri)
        return;

    trusted = cus_config_origin_trusted(s_config, uri);

    /* Not looked at on an untrusted origin, which is the point: a foreign page
     * cannot switch a script off by claiming cog-disable. It also means no DOM
     * query at all out there. */
    if (trusted)
        read_switch_tags(context, &enable, &disable);

    for (size_t m = 0; m < s_manifests->n_items; m++) {
        const CusManifest *manifest = &s_manifests->items[m];

        if (!cus_script_enabled(manifest, enable, disable))
            continue;

        for (size_t s = 0; s < manifest->n_scripts; s++) {
            const CusContentScript *script = &manifest->scripts[s];

            if (script->run_at != when)
                continue;

            if (!main_frame && !script->all_frames)
                continue;

            if (!cus_content_script_matches(script, uri))
                continue;

            cus_inject(context, manifest, script, trusted);
        }
    }
}

/* Key under which the main frame's JS context is cached on the page. */
#define CUS_MAIN_CONTEXT_KEY "cog-userscripts-main-context"

static void on_window_object_cleared(WebKitScriptWorld *world, WebKitWebPage *page,
                                     WebKitFrame *frame, gpointer user_data)
{
    JSCContext *context;
    const char *uri;
    gboolean main_frame;

    (void)user_data;

    context = webkit_frame_get_js_context_for_script_world(frame, world);
    uri = webkit_frame_get_uri(frame);
    main_frame = webkit_frame_is_main_frame(frame);

    /* Remember the main frame's context for document-loaded, which carries no
     * frame of its own. webkit_web_page_get_main_frame() would answer that,
     * but it is deprecated since 2.48 — presumably because with site isolation
     * "the main frame" is no longer well defined inside one web process. */
    if (main_frame && context)
        g_object_set_data_full(G_OBJECT(page), CUS_MAIN_CONTEXT_KEY,
                               g_object_ref(context), g_object_unref);

    run_matching(context, uri, CUS_RUN_AT_DOCUMENT_START, main_frame);
}

/* The cached context, or a last-resort lookup through the deprecated getter in
 * case a document never had its window object cleared (WebKit creates the JS
 * context lazily). */
static JSCContext *main_context_for(WebKitWebPage *page)
{
    JSCContext *context = g_object_get_data(G_OBJECT(page), CUS_MAIN_CONTEXT_KEY);
    WebKitFrame *frame;

    if (context)
        return context;

    G_GNUC_BEGIN_IGNORE_DEPRECATIONS
    frame = webkit_web_page_get_main_frame(page);
    G_GNUC_END_IGNORE_DEPRECATIONS

    return frame ? webkit_frame_get_js_context(frame) : NULL;
}

static gboolean on_idle(gpointer user_data)
{
    WebKitWebPage *page = WEBKIT_WEB_PAGE(user_data);

    run_matching(main_context_for(page), webkit_web_page_get_uri(page),
                 CUS_RUN_AT_DOCUMENT_IDLE, TRUE);

    return G_SOURCE_REMOVE;
}

static void on_document_loaded(WebKitWebPage *page, gpointer user_data)
{
    (void)user_data;

    /* document-loaded is a per-page signal, so document_end and document_idle
     * only ever see the main frame — all_frames applies to document_start. */
    run_matching(main_context_for(page), webkit_web_page_get_uri(page),
                 CUS_RUN_AT_DOCUMENT_END, TRUE);

    g_idle_add_full(G_PRIORITY_LOW, on_idle, g_object_ref(page), g_object_unref);
}

static void on_page_created(WebKitWebProcessExtension *extension, WebKitWebPage *page,
                            gpointer user_data)
{
    (void)extension;
    (void)user_data;

    g_signal_connect(page, "document-loaded", G_CALLBACK(on_document_loaded), NULL);
}

/* ------------------------------------------------------------------ *
 * startup
 * ------------------------------------------------------------------ */

/* The device configuration, from the environment if an application set it and
 * otherwise from a config.json in the search path. Exactly one source wins, so
 * which one it was goes into the log — otherwise someone hunts for a file that a
 * variable is quietly overruling. */
static void load_config(const char *const *entries, size_t n_entries)
{
    const char *env = g_getenv("COG_USERSCRIPTS_CONFIG");

    if (env) {
        cus_debug("configuration from COG_USERSCRIPTS_CONFIG");
        s_config = cus_config_parse(env);
    } else {
        s_config = cus_config_load_path(entries, n_entries);
    }
}

static void load_manifests(void)
{
    const char *env = g_getenv("COG_USERSCRIPTS_PATH");
    char **entries = cus_split_search_path(env ? env : CUS_DEFAULT_SEARCH_PATH);
    size_t n_entries = 0;

    if (!entries) {
        cus_warn("COG_USERSCRIPTS_PATH is empty, no scripts will be loaded");
        return;
    }

    while (entries[n_entries])
        n_entries++;

    s_manifests = cus_manifest_load_path((const char *const *)entries, n_entries);
    load_config((const char *const *)entries, n_entries);
    cus_strv_free(entries);

    if (!s_manifests || s_manifests->n_items == 0) {
        cus_warn("no userscripts found in %s — nothing ships with the library, "
                 "scripts are copied into an application",
                 env ? env : CUS_DEFAULT_SEARCH_PATH);
        return;
    }

    /* Merge the device settings into every manifest once, so nothing has to be
     * worked out per injection. */
    cus_config_apply(s_config, s_manifests);

    for (size_t i = 0; i < s_manifests->n_items; i++) {
        const CusManifest *m = &s_manifests->items[i];

        cus_debug("loaded \"%s\" (%s) with %zu content script(s) from %s", m->name,
                  m->id, m->n_scripts, m->dir);
    }
}

G_MODULE_EXPORT void
webkit_web_process_extension_initialize(WebKitWebProcessExtension *extension)
{
    cus_log_set_handler(forward_to_glib, NULL);
    cus_debug("initialising (set G_MESSAGES_DEBUG=" CUS_LOG_DOMAIN " for details)");

    load_manifests();

    g_signal_connect(webkit_script_world_get_default(), "window-object-cleared",
                     G_CALLBACK(on_window_object_cleared), NULL);
    g_signal_connect(extension, "page-created", G_CALLBACK(on_page_created), NULL);
}
