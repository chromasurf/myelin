#include "injector.h"

#include <glib.h>

#include "generated/cog_prelude.h"
#include "log.h"

/* The web process extension API has no user-stylesheet equivalent — that lives
 * on WebKitUserContentManager in the UI process, which Cog does not expose. So
 * CSS goes in through a <style> element instead.
 *
 * This is evaluated to obtain a function value rather than being defined as a
 * global, so nothing of ours ends up on the page's window object. The css text
 * is passed as an argument, which sidesteps any string escaping.
 *
 * At document_start there may be no <head> yet, hence the documentElement
 * fallback and the DOMContentLoaded retry. */
static const char kAddStyleSource[] =
    "(function (css, id) {\n"
    "  var install = function () {\n"
    "    if (document.getElementById(id)) return true;\n"
    "    var parent = document.head || document.documentElement;\n"
    "    if (!parent) return false;\n"
    "    var el = document.createElement('style');\n"
    "    el.id = id;\n"
    "    el.textContent = css;\n"
    "    parent.appendChild(el);\n"
    "    return true;\n"
    "  };\n"
    "  if (!install()) {\n"
    "    document.addEventListener('DOMContentLoaded', install, { once: true });\n"
    "  }\n"
    "})";

/* Logs and clears any pending exception. Returns TRUE when one was found. */
static gboolean report_exception(JSCContext *context, const char *what)
{
    JSCException *exception = jsc_context_get_exception(context);
    g_autofree char *report = NULL;

    if (!exception)
        return FALSE;

    report = jsc_exception_report(exception);
    cus_warn("%s raised: %s", what, report ? report : "unknown error");
    jsc_context_clear_exception(context);
    return TRUE;
}

static char *read_script_file(const CusManifest *manifest, const char *name,
                              gsize *length)
{
    g_autofree char *path = g_build_filename(manifest->dir, name, NULL);
    g_autoptr(GError) error = NULL;
    char *contents = NULL;

    /* Names were checked when the manifest was parsed, so this only guards
     * against a caller that skipped that. A subdirectory is allowed — a build
     * writes into one — but nothing that could leave the script's directory. */
    if (!cus_relative_path_ok(name)) {
        cus_warn("%s: refusing to read \"%s\"", manifest->id, name);
        return NULL;
    }

    if (!g_file_get_contents(path, &contents, length, &error)) {
        cus_warn("%s: cannot read %s: %s", manifest->id, path, error->message);
        return NULL;
    }

    return contents;
}

/* ------------------------------------------------------------------ *
 * CSS
 * ------------------------------------------------------------------ */

static void inject_css(JSCContext *context, const CusManifest *manifest,
                       const char *name)
{
    gsize length = 0;
    g_autofree char *css = read_script_file(manifest, name, &length);
    g_autofree char *element_id = NULL;
    g_autoptr(JSCValue) add_style = NULL;
    g_autoptr(JSCValue) result = NULL;

    if (!css)
        return;

    add_style = jsc_context_evaluate(context, kAddStyleSource, -1);
    if (report_exception(context, "the stylesheet helper"))
        return;

    if (!add_style || !jsc_value_is_function(add_style)) {
        cus_warn("%s: could not build the stylesheet helper", manifest->id);
        return;
    }

    /* Stable id so a re-injection into the same document is a no-op. Slashes
     * from a subdirectory become dashes, so the id does not read like a path. */
    element_id = g_strdup_printf("cog-userscript-style-%s-%s", manifest->id, name);
    for (char *c = element_id; *c; c++) {
        if (*c == '/')
            *c = '-';
    }

    result = jsc_value_function_call(add_style, G_TYPE_STRING, css, G_TYPE_STRING,
                                     element_id, G_TYPE_NONE);
    (void)result;

    if (!report_exception(context, element_id))
        cus_debug("%s: injected %s", manifest->id, name);
}

/* The "shadow_css" files, concatenated. These are not injected: the script gets
 * them as cog.css and decides where they go — a shadow root, for a widget that
 * has to survive the CSS of whatever page it landed on. */
static char *read_shadow_css(const CusManifest *manifest,
                             const CusContentScript *script)
{
    GString *out = g_string_new(NULL);

    for (size_t i = 0; i < script->n_shadow_css; i++) {
        gsize length = 0;
        g_autofree char *css = read_script_file(manifest, script->shadow_css[i], &length);

        if (!css)
            continue;

        if (out->len > 0)
            g_string_append_c(out, '\n');
        g_string_append_len(out, css, (gssize)length);
    }

    return g_string_free(out, FALSE);
}

/* ------------------------------------------------------------------ *
 * the cog argument
 * ------------------------------------------------------------------ */

/* Quotes a script id as a JSON string. It comes from a directory name, so the
 * two characters that could end the literal early are all there is to handle;
 * manifest.c has already refused control characters. */
static char *quote_json(const char *text)
{
    GString *out = g_string_new("\"");

    for (const char *c = text; *c; c++) {
        if (*c == '"' || *c == '\\')
            g_string_append_c(out, '\\');
        g_string_append_c(out, *c);
    }

    g_string_append_c(out, '"');
    return g_string_free(out, FALSE);
}

/* Builds the object a script receives. The configuration goes in as a literal
 * rather than through JSON.parse: that function belongs to the page, which could
 * have replaced it with one that keeps a copy — and the whole point of handing
 * settings to a single script is that nobody else sees them. */
static JSCValue *build_cog(JSCContext *context, const CusManifest *manifest,
                           const CusContentScript *script, bool trusted)
{
    g_autofree char *id_json = quote_json(manifest->id);
    g_autofree char *source =
        g_strdup_printf("%s(%s, %s, %s)", kCogPrelude, id_json,
                        trusted ? "true" : "false",
                        manifest->config ? manifest->config : "{}");
    JSCValue *cog = jsc_context_evaluate(context, source, -1);

    if (report_exception(context, "the cog prelude")) {
        g_clear_object(&cog);
        return NULL;
    }

    if (!cog || !jsc_value_is_object(cog)) {
        cus_warn("%s: the cog prelude did not return an object", manifest->id);
        g_clear_object(&cog);
        return NULL;
    }

    /* Set rather than passed in: as a JSCValue the stylesheet needs no escaping
     * at all, where a string literal in the source would need every quote,
     * backslash and newline handled. */
    if (script->n_shadow_css > 0) {
        g_autofree char *css = read_shadow_css(manifest, script);
        g_autoptr(JSCValue) value = jsc_value_new_string(context, css);

        jsc_value_object_set_property(cog, "css", value);
    }

    return cog;
}

/* ------------------------------------------------------------------ *
 * JS
 * ------------------------------------------------------------------ */

#define SOURCE_MAP_DIRECTIVE "//# sourceMappingURL="

/* Cuts a trailing sourceMappingURL directive out of `source` and returns it, or
 * NULL. The wrapper's closing "})" would otherwise sit after it, and the
 * directive has to be the last thing in the source to be found — so it is moved
 * to after the wrapper instead. Only from the end, so no line number shifts.
 *
 * sourceURL is deliberately left where it is: hoisting that would override the
 * cog-userscript:// URI below and take the script's name out of every trace. */
static char *take_source_map(char *source, gsize *length)
{
    gsize end = *length;
    gsize start;
    gsize text;

    while (end > 0 && (source[end - 1] == '\n' || source[end - 1] == '\r'))
        end--;

    start = end;
    while (start > 0 && source[start - 1] != '\n')
        start--;

    text = start;
    while (text < end && (source[text] == ' ' || source[text] == '\t'))
        text++;

    if (end - text < strlen(SOURCE_MAP_DIRECTIVE) ||
        strncmp(source + text, SOURCE_MAP_DIRECTIVE, strlen(SOURCE_MAP_DIRECTIVE)) != 0)
        return NULL;

    char *directive = g_strndup(source + text, end - text);

    source[start] = '\0';
    *length = start;
    return directive;
}

static void inject_js(JSCContext *context, const CusManifest *manifest,
                      const char *name, JSCValue *cog)
{
    gsize length = 0;
    g_autofree char *source = read_script_file(manifest, name, &length);
    g_autofree char *directive = NULL;
    g_autofree char *uri = NULL;
    g_autofree char *wrapped = NULL;
    g_autoptr(JSCValue) fn = NULL;
    g_autoptr(JSCValue) result = NULL;

    if (!source)
        return;

    directive = take_source_map(source, &length);

    /* A cog-userscript:// source URI makes stack traces in the remote
     * inspector point at the file instead of at an anonymous eval. */
    uri = g_strdup_printf("cog-userscript:///%s/%s", manifest->id, name);

    /* The prologue shares line 1 with the file's own first line, so every line
     * number stays what it is in the file. Columns on line 1 shift by its
     * length, which is the right trade for hand-written scripts and the wrong
     * one for a minified bundle — where everything is on line 1 anyway. The \n
     * before the closing brace covers a file ending in a // comment.
     *
     * "use strict" belongs to the wrapper rather than to each script: strictness
     * is lexical, so a script cannot inherit it from this file, and every one of
     * them would otherwise open with the same directive. */
    wrapped = g_strdup_printf("(function (ctx) {\"use strict\";%s\n})%s%s", source,
                              directive ? "\n" : "", directive ? directive : "");

    fn = jsc_context_evaluate_with_source_uri(context, wrapped, -1, uri, 1);
    if (report_exception(context, uri))
        return;

    if (!fn || !jsc_value_is_function(fn)) {
        cus_warn("%s: %s did not wrap into a function", manifest->id, name);
        return;
    }

    result = jsc_value_function_call(fn, JSC_TYPE_VALUE, cog, G_TYPE_NONE);
    (void)result;

    if (!report_exception(context, uri))
        cus_debug("%s: injected %s", manifest->id, name);
}

void cus_inject(JSCContext *context, const CusManifest *manifest,
                const CusContentScript *script, bool trusted)
{
    g_autoptr(JSCValue) cog = NULL;

    if (!context || !manifest || !script)
        return;

    /* CSS before JS, so a script that measures layout sees its own styles. */
    for (size_t i = 0; i < script->n_css; i++)
        inject_css(context, manifest, script->css[i]);

    if (script->n_js == 0)
        return;

    /* One cog for every file of this content script: a script split across two
     * files must see the same settings, and cog.css must not be read twice. */
    cog = build_cog(context, manifest, script, trusted);
    if (!cog)
        return;

    for (size_t i = 0; i < script->n_js; i++)
        inject_js(context, manifest, script->js[i], cog);
}
