#include "tests.h"

#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include "../../c_src/log.h"
#include "../../c_src/manifest.h"

static int warning_count;

static void count_warnings(CusLogLevel level, const char *message, void *user_data)
{
    (void)user_data;

    if (level == CUS_LOG_WARNING) {
        warning_count++;
        if (getenv("CUS_SHOW_WARNINGS")) fprintf(stderr, "WARN: %s\n", message);
    }
}

static CusManifest *parse(const char *json)
{
    warning_count = 0;
    return cus_manifest_parse(json, strlen(json), "unit", "/tmp/unit");
}

/* ------------------------------------------------------------------ *
 * filesystem helpers for the search-path tests
 * ------------------------------------------------------------------ */

/* Twice the size of the caller's buffer: gcc with -O1 and FORTIFY otherwise
 * reports that appending a name to a 1024-byte directory could truncate. */
static void write_file(const char *dir, const char *name, const char *content)
{
    char path[2048];
    FILE *file;

    snprintf(path, sizeof(path), "%s/%s", dir, name);
    file = fopen(path, "wb");
    if (!file)
        return;

    fwrite(content, 1, strlen(content), file);
    fclose(file);
}

static void make_script_dir(const char *root, const char *id, const char *manifest)
{
    char path[1024];

    snprintf(path, sizeof(path), "%s/%s", root, id);
    mkdir(path, 0777);
    write_file(path, "manifest.json", manifest);
}

static void remove_script_dir(const char *root, const char *id)
{
    char path[1024];

    snprintf(path, sizeof(path), "%s/%s/manifest.json", root, id);
    unlink(path);
    snprintf(path, sizeof(path), "%s/%s", root, id);
    rmdir(path);
}

/* ------------------------------------------------------------------ */

static void test_basic_parse(void)
{
    CusManifest *m = parse("{"
                           "\"manifest_version\": 3,"
                           "\"name\": \"Hello Toast\","
                           "\"version\": \"1.0\","
                           "\"content_scripts\": [{"
                           "  \"matches\": [\"http://localhost:4000/*\"],"
                           "  \"js\": [\"hello.js\"],"
                           "  \"css\": [\"hello.css\"],"
                           "  \"run_at\": \"document_end\""
                           "}]}");

    CHECK(m != NULL);
    if (!m)
        return;

    CHECK_STREQ(m->name, "Hello Toast");
    CHECK_STREQ(m->id, "unit");
    /* Nothing runs unless it is asked for, so a manifest that says nothing about
     * "enabled" is dormant. */
    CHECK(!m->enabled);
    CHECK(m->n_scripts == 1);
    CHECK(warning_count == 0);

    if (m->n_scripts == 1) {
        const CusContentScript *s = &m->scripts[0];

        CHECK(s->n_matches == 1);
        CHECK(s->n_js == 1);
        CHECK(s->n_css == 1);
        CHECK_STREQ(s->js[0], "hello.js");
        CHECK_STREQ(s->css[0], "hello.css");
        CHECK(s->run_at == CUS_RUN_AT_DOCUMENT_END);
        CHECK(!s->all_frames);
        CHECK(cus_content_script_matches(s, "http://localhost:4000/dashboard"));
        CHECK(!cus_content_script_matches(s, "https://example.com/"));
    }

    cus_manifest_free(m);
}

static void test_defaults(void)
{
    /* No run_at, no all_frames, no name: defaults apply and nothing warns. */
    CusManifest *m = parse("{\"content_scripts\":[{"
                           "\"matches\":[\"<all_urls>\"],\"js\":[\"a.js\"]}]}");

    CHECK(m != NULL);
    if (!m)
        return;

    CHECK_STREQ(m->name, "unit"); /* falls back to the directory name */
    CHECK(!m->enabled);
    CHECK(m->scripts[0].run_at == CUS_RUN_AT_DOCUMENT_END);
    CHECK(!m->scripts[0].all_frames);
    CHECK(m->scripts[0].n_css == 0);
    CHECK(warning_count == 0);

    cus_manifest_free(m);
}

static void test_run_at_variants(void)
{
    const char *template = "{\"content_scripts\":[{\"matches\":[\"<all_urls>\"],"
                           "\"js\":[\"a.js\"],\"run_at\":\"%s\"}]}";
    struct {
        const char *value;
        CusRunAt expected;
        int warnings;
    } cases[] = {
        { "document_start", CUS_RUN_AT_DOCUMENT_START, 0 },
        { "document_end", CUS_RUN_AT_DOCUMENT_END, 0 },
        { "document_idle", CUS_RUN_AT_DOCUMENT_IDLE, 0 },
        /* An unknown value warns and falls back rather than failing the load. */
        { "whenever", CUS_RUN_AT_DOCUMENT_END, 1 },
    };

    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        char json[512];
        CusManifest *m;

        snprintf(json, sizeof(json), template, cases[i].value);
        m = parse(json);

        CHECK(m != NULL);
        if (!m)
            continue;

        CHECK(m->scripts[0].run_at == cases[i].expected);
        CHECK(warning_count == cases[i].warnings);
        cus_manifest_free(m);
    }
}

static void test_exclude_matches(void)
{
    CusManifest *m = parse("{\"content_scripts\":[{"
                           "\"matches\":[\"*://*/*\"],"
                           "\"exclude_matches\":[\"*://*/admin/*\"],"
                           "\"js\":[\"a.js\"]}]}");

    CHECK(m != NULL);
    if (!m)
        return;

    CHECK(m->scripts[0].n_excludes == 1);
    CHECK(cus_content_script_matches(&m->scripts[0], "http://localhost/dashboard"));
    CHECK(!cus_content_script_matches(&m->scripts[0], "http://localhost/admin/users"));

    cus_manifest_free(m);
}

static void test_unknown_keys_warn_but_load(void)
{
    CusManifest *m = parse("{"
                           "\"manifest_version\":3,"
                           "\"permissions\":[\"tabs\"],"
                           "\"background\":{\"service_worker\":\"bg.js\"},"
                           "\"content_scripts\":[{"
                           "\"matches\":[\"<all_urls>\"],\"js\":[\"a.js\"],"
                           "\"world\":\"MAIN\"}]}");

    CHECK(m != NULL);
    if (!m)
        return;

    /* permissions, background and world: three ignored keys, three warnings,
     * but the manifest still loads and the script still runs. */
    CHECK(warning_count == 3);
    CHECK(m->n_scripts == 1);
    CHECK(cus_content_script_matches(&m->scripts[0], "http://localhost/"));

    cus_manifest_free(m);
}

static void test_malformed(void)
{
    CHECK(parse("{ this is not json") == NULL);
    CHECK(parse("[1, 2, 3]") == NULL); /* top level must be an object */
    CHECK(parse("") == NULL);

    /* A bad match pattern drops that pattern, not the manifest. */
    {
        CusManifest *m = parse("{\"content_scripts\":[{"
                               "\"matches\":[\"not-a-pattern\",\"<all_urls>\"],"
                               "\"js\":[\"a.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK(m->scripts[0].n_matches == 1);
            CHECK(warning_count == 1);
            CHECK(cus_content_script_matches(&m->scripts[0], "http://localhost/"));
            cus_manifest_free(m);
        }
    }

    /* A script with no usable matches loads but never runs. */
    {
        CusManifest *m = parse("{\"content_scripts\":[{"
                               "\"matches\":[\"nope\"],\"js\":[\"a.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK(m->scripts[0].n_matches == 0);
            CHECK(!cus_content_script_matches(&m->scripts[0], "http://localhost/"));
            cus_manifest_free(m);
        }
    }

    /* jsmn does not deduplicate object keys, so a manifest that names
     * content_scripts twice hands both arrays to the parse loop. Allocating for
     * the second while the first one's count still stood wrote past the end of the
     * new array. The later one wins, as it does for "name" and "config". */
    {
        CusManifest *m = parse("{\"content_scripts\":[{"
                               "\"matches\":[\"<all_urls>\"],\"js\":[\"first.js\"]}],"
                               "\"content_scripts\":[{"
                               "\"matches\":[\"<all_urls>\"],\"js\":[\"second.js\"]},{"
                               "\"matches\":[\"<all_urls>\"],\"js\":[\"third.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK(m->n_scripts == 2);
            CHECK(m->scripts[0].n_js == 1);
            CHECK_STREQ(m->scripts[0].js[0], "second.js");
            CHECK_STREQ(m->scripts[1].js[0], "third.js");
            cus_manifest_free(m);
        }
    }
}

/* "config" is kept as raw text and later spliced into JS source, so the bar for
 * accepting it is "this is definitely valid JSON", not "jsmn did not complain". */
static void test_config_slice(void)
{
    /* Preserved verbatim, nesting and spacing included. */
    {
        CusManifest *m = parse("{\"config\": {\"a\": 1, \"b\": {\"c\": [true, null]}},"
                               "\"content_scripts\":[{\"matches\":[\"<all_urls>\"],"
                               "\"js\":[\"a.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK_STREQ(m->config, "{\"a\": 1, \"b\": {\"c\": [true, null]}}");
            CHECK(warning_count == 0);
            cus_manifest_free(m);
        }
    }

    /* Absent is not an error; the script simply has no defaults. */
    {
        CusManifest *m = parse("{\"content_scripts\":[{\"matches\":[\"<all_urls>\"],"
                               "\"js\":[\"a.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK(m->config == NULL);
            CHECK(warning_count == 0);
            cus_manifest_free(m);
        }
    }

    /* Not an object: warn and carry on without it. A bare value could not be
     * merged key by key with the device configuration anyway. */
    {
        CusManifest *m = parse("{\"config\": 5,\"content_scripts\":[{"
                               "\"matches\":[\"<all_urls>\"],\"js\":[\"a.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK(m->config == NULL);
            CHECK(warning_count == 1);
            CHECK(m->n_scripts == 1);
            cus_manifest_free(m);
        }
    }

    /* A config spanning several lines, as any hand-written manifest does. The
     * first version of the control-character check swept the whole slice and
     * refused every one of these — the newlines between tokens are the
     * formatting, and a newline there is as legal in JS as it is in JSON. */
    {
        CusManifest *m = parse("{\n"
                              "  \"config\": {\n"
                              "    \"allowlist\": [\"localhost:4000\"],\n"
                              "    \"home\": \"http://localhost:4000/\"\n"
                              "  },\n"
                              "  \"content_scripts\": [{\n"
                              "    \"matches\": [\"<all_urls>\"],\n"
                              "    \"js\": [\"a.js\"]\n"
                              "  }]\n"
                              "}");

        CHECK(m != NULL);
        if (m) {
            CHECK(m->config != NULL);
            CHECK(warning_count == 0);
            cus_manifest_free(m);
        }
    }

    /* A raw control character inside a string: jsmn accepts it even in strict
     * mode, but it would break the JS line the slice lands on. */
    {
        CusManifest *m = parse("{\"config\": {\"a\": \"x\ty\"},\"content_scripts\":[{"
                               "\"matches\":[\"<all_urls>\"],\"js\":[\"a.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK(m->config == NULL);
            CHECK(warning_count == 1);
            cus_manifest_free(m);
        }
    }

    /* An unquoted primitive is the dangerous one: jsmn hands `foo` back as a
     * primitive token even in strict mode — strict only checks what *terminates*
     * a primitive, never its characters — and spliced into JS that becomes an
     * identifier read from the page's scope. */
    {
        CusManifest *m = parse("{\"config\": {\"a\": foo},\"content_scripts\":[{"
                               "\"matches\":[\"<all_urls>\"],\"js\":[\"a.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK(m->config == NULL);
            CHECK(warning_count == 1);
            cus_manifest_free(m);
        }
    }

    /* Real JSON primitives stay, including the awkward numbers. */
    {
        CusManifest *m = parse("{\"config\": {\"a\": -0.5e+3, \"b\": null, \"c\": false},"
                               "\"content_scripts\":[{\"matches\":[\"<all_urls>\"],"
                               "\"js\":[\"a.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK_STREQ(m->config, "{\"a\": -0.5e+3, \"b\": null, \"c\": false}");
            CHECK(warning_count == 0);
            cus_manifest_free(m);
        }
    }

    /* Numbers JSON does not have, however written, must not slip through: JS
     * would happily evaluate 0x10 or .5, JSON does not allow either. */
    {
        const char *bad[] = { "0x10", "1.", ".5", "+1", "01", "1e", "Infinity", "NaN" };

        for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
            char json[256];
            CusManifest *m;

            snprintf(json, sizeof(json),
                     "{\"config\": {\"a\": %s},\"content_scripts\":[{"
                     "\"matches\":[\"<all_urls>\"],\"js\":[\"a.js\"]}]}",
                     bad[i]);
            m = parse(json);

            /* Either the manifest fails to parse or the config is dropped —
             * both are fine, what matters is that the text never travels on. */
            if (m) {
                CHECK(m->config == NULL);
                cus_manifest_free(m);
            }
        }
    }
}

static void test_shadow_css(void)
{
    /* Both lists at once: a script may style the page and own an encapsulated
     * widget. shadow_css must not leak into css, or it would be injected twice. */
    CusManifest *m = parse("{\"content_scripts\":[{\"matches\":[\"<all_urls>\"],"
                           "\"js\":[\"a.js\"],\"css\":[\"page.css\"],"
                           "\"shadow_css\":[\"widget.css\",\"theme.css\"]}]}");

    CHECK(m != NULL);
    if (!m)
        return;

    CHECK(warning_count == 0);
    CHECK(m->scripts[0].n_css == 1);
    CHECK_STREQ(m->scripts[0].css[0], "page.css");
    CHECK(m->scripts[0].n_shadow_css == 2);
    CHECK_STREQ(m->scripts[0].shadow_css[0], "widget.css");
    CHECK_STREQ(m->scripts[0].shadow_css[1], "theme.css");

    cus_manifest_free(m);
}

static void test_relative_paths(void)
{
    /* A subdirectory is the point: it gives an esbuild or Tailwind build its own
     * gitignored place to write, next to the hand-written manifest. */
    CHECK(cus_relative_path_ok("branding.js"));
    CHECK(cus_relative_path_ok("build/branding.js"));
    CHECK(cus_relative_path_ok("build/nested/branding.js"));

    /* Everything that could leave the script's directory, or is simply not a
     * file name. */
    CHECK(!cus_relative_path_ok("../branding.js"));
    CHECK(!cus_relative_path_ok("a/../../etc/passwd"));
    CHECK(!cus_relative_path_ok("/etc/passwd"));
    CHECK(!cus_relative_path_ok("a//branding.js"));
    CHECK(!cus_relative_path_ok("build/"));
    CHECK(!cus_relative_path_ok("."));
    CHECK(!cus_relative_path_ok(".."));
    CHECK(!cus_relative_path_ok("a/./b.js"));
    CHECK(!cus_relative_path_ok("build\\branding.js"));
    CHECK(!cus_relative_path_ok(""));
    CHECK(!cus_relative_path_ok(NULL));

    /* In a manifest the bad name drops out and the good one survives, with one
     * warning — at load time, not once per page load. */
    {
        CusManifest *m = parse("{\"content_scripts\":[{\"matches\":[\"<all_urls>\"],"
                               "\"js\":[\"../escape.js\",\"build/ok.js\"]}]}");

        CHECK(m != NULL);
        if (m) {
            CHECK(m->scripts[0].n_js == 1);
            CHECK_STREQ(m->scripts[0].js[0], "build/ok.js");
            CHECK(warning_count == 1);
            cus_manifest_free(m);
        }
    }
}

static void test_search_path_split(void)
{
    char **parts = cus_split_search_path("/a:/b:/c");

    CHECK(parts != NULL);
    if (parts) {
        CHECK_STREQ(parts[0], "/a");
        CHECK_STREQ(parts[1], "/b");
        CHECK_STREQ(parts[2], "/c");
        CHECK(parts[3] == NULL);
        cus_strv_free(parts);
    }

    /* Empty segments are dropped. */
    parts = cus_split_search_path("/a::/b:");
    CHECK(parts != NULL);
    if (parts) {
        CHECK_STREQ(parts[0], "/a");
        CHECK_STREQ(parts[1], "/b");
        CHECK(parts[2] == NULL);
        cus_strv_free(parts);
    }

    CHECK(cus_split_search_path("") == NULL);
    CHECK(cus_split_search_path(NULL) == NULL);
}

static void test_search_path_override(void)
{
    char base_template[] = "/tmp/cus-test-XXXXXX";
    char *base = mkdtemp(base_template);
    char defaults[1024];
    char overrides[1024];
    const char *path[2];
    CusManifestList *list;

    CHECK(base != NULL);
    if (!base)
        return;

    snprintf(defaults, sizeof(defaults), "%s/defaults", base);
    snprintf(overrides, sizeof(overrides), "%s/overrides", base);
    mkdir(defaults, 0777);
    mkdir(overrides, 0777);

    path[0] = defaults;
    path[1] = overrides;

    make_script_dir(defaults, "hello",
                    "{\"name\":\"shipped hello\",\"content_scripts\":[{"
                    "\"matches\":[\"<all_urls>\"],\"js\":[\"a.js\"]}]}");
    make_script_dir(defaults, "keyboard",
                    "{\"name\":\"shipped keyboard\",\"content_scripts\":[{"
                    "\"matches\":[\"<all_urls>\"],\"js\":[\"k.js\"]}]}");

    /* Nothing overridden yet: both shipped scripts load, sorted by id. */
    list = cus_manifest_load_path(path, 2);
    CHECK(list != NULL);
    if (list) {
        CHECK(list->n_items == 2);
        if (list->n_items == 2) {
            CHECK_STREQ(list->items[0].id, "hello");
            CHECK_STREQ(list->items[1].id, "keyboard");
            CHECK_STREQ(list->items[0].name, "shipped hello");
        }
        cus_manifest_list_free(list);
    }

    /* A later search-path entry replaces the shipped script outright. */
    make_script_dir(overrides, "hello",
                    "{\"name\":\"local hello\",\"content_scripts\":[{"
                    "\"matches\":[\"<all_urls>\"],\"js\":[\"b.js\"]}]}");

    list = cus_manifest_load_path(path, 2);
    CHECK(list != NULL);
    if (list) {
        CHECK(list->n_items == 2);
        if (list->n_items == 2) {
            CHECK_STREQ(list->items[0].id, "hello");
            CHECK_STREQ(list->items[0].name, "local hello");
            /* and it is the copy from the override directory, not the shipped one */
            CHECK(strncmp(list->items[0].dir, overrides, strlen(overrides)) == 0);
        }
        cus_manifest_list_free(list);
    }

    /* "enabled": false keeps the manifest and marks it dormant, rather than
     * dropping the entry: whether a script runs is decided per page, where the
     * device configuration and a trusted origin also get a say. */
    remove_script_dir(overrides, "hello");
    make_script_dir(overrides, "hello", "{\"enabled\": false}");

    list = cus_manifest_load_path(path, 2);
    CHECK(list != NULL);
    if (list) {
        CHECK(list->n_items == 2);
        if (list->n_items == 2) {
            CHECK_STREQ(list->items[0].id, "hello");
            CHECK(!list->items[0].enabled);
            /* and the one that says nothing is dormant too */
            CHECK(!list->items[1].enabled);
        }
        cus_manifest_list_free(list);
    }

    remove_script_dir(overrides, "hello");
    remove_script_dir(defaults, "hello");
    remove_script_dir(defaults, "keyboard");
    rmdir(defaults);
    rmdir(overrides);
    rmdir(base);
}

/* Loads every manifest in the repository through the real parser, so a typo does
 * not have to wait for a device to surface as a script that never runs.
 *
 * Both directories at once, which also exercises the search path: ideas/ first,
 * priv/scripts/ second, so a shipped script would win an id it shared with an
 * idea. */
static void test_example_manifests(void)
{
    const char *path[2] = { "../../ideas", "../../priv/scripts" };
    CusManifestList *list;

    warning_count = 0;
    list = cus_manifest_load_path(path, 2);

    CHECK(list != NULL);
    if (!list)
        return;

    CHECK(list->n_items == 13);
    CHECK(warning_count == 0);

    for (size_t i = 0; i < list->n_items; i++) {
        const CusManifest *m = &list->items[i];

        /* Nothing ships switched on. The device configuration is what turns a
         * script on, so a manifest that did it for you would be a script running
         * on a kiosk nobody pointed at it. */
        CHECK(!m->enabled);
        CHECK(m->n_scripts >= 1);

        for (size_t s = 0; s < m->n_scripts; s++) {
            const CusContentScript *cs = &m->scripts[s];

            /* No matches means the script would load and never run. */
            CHECK(cs->n_matches >= 1);
            CHECK(cs->n_js + cs->n_css >= 1);
            /* They all rely on the DOM being present. */
            CHECK(cs->run_at == CUS_RUN_AT_DOCUMENT_END);
            CHECK(cus_content_script_matches(cs, "http://localhost:4000/"));
        }
    }

    cus_manifest_list_free(list);
}

void test_manifest(void)
{
    cus_log_set_handler(count_warnings, NULL);

    test_basic_parse();
    test_defaults();
    test_run_at_variants();
    test_exclude_matches();
    test_unknown_keys_warn_but_load();
    test_malformed();
    test_config_slice();
    test_shadow_css();
    test_relative_paths();
    test_search_path_split();
    test_search_path_override();
    test_example_manifests();

    cus_log_set_handler(NULL, NULL);
}
