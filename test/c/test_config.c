#include "tests.h"

#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include "../../c_src/config.h"
#include "../../c_src/log.h"
#include "../../c_src/manifest.h"

static int warning_count;

static void count_warnings(MylLogLevel level, const char *message, void *user_data)
{
    (void)message;
    (void)user_data;

    if (level == MYL_LOG_WARNING)
        warning_count++;
}

/* ------------------------------------------------------------------ *
 * building a manifest list by hand
 * ------------------------------------------------------------------ */

/* Takes ownership of the manifests, exactly as myl_manifest_load_path does:
 * contents move into the list by value and the shells are freed. */
static MylManifestList *list_from(MylManifest **manifests, size_t n)
{
    MylManifestList *list = calloc(1, sizeof(*list));

    if (!list)
        return NULL;

    list->items = calloc(n, sizeof(*list->items));
    if (!list->items) {
        free(list);
        return NULL;
    }

    for (size_t i = 0; i < n; i++) {
        list->items[i] = *manifests[i];
        free(manifests[i]);
    }

    list->n_items = n;
    return list;
}

static MylManifest *manifest_with(const char *id, const char *body)
{
    char json[1024];

    snprintf(json, sizeof(json),
             "{%s%s\"content_scripts\":[{\"matches\":[\"<all_urls>\"],"
             "\"js\":[\"a.js\"]}]}",
             body, *body ? "," : "");

    return myl_manifest_parse(json, strlen(json), id, "/tmp/unit");
}

/* ------------------------------------------------------------------ *
 * parsing the device configuration
 * ------------------------------------------------------------------ */

static void test_parse(void)
{
    /* Nothing configured is the normal case for an application that sets no
     * options, so it must be silent. */
    {
        warning_count = 0;
        MylConfig *c = myl_config_parse(NULL);

        CHECK(c != NULL);
        CHECK(warning_count == 0);
        CHECK(!myl_config_origin_trusted(c, "http://localhost:4000/"));
        myl_config_free(c);

        warning_count = 0;
        c = myl_config_parse("");
        CHECK(c != NULL);
        CHECK(warning_count == 0);
        myl_config_free(c);
    }

    /* Malformed warns but still yields a usable configuration: a typo in
     * runtime.exs must not take every script down with it. */
    {
        const char *bad[] = { "{ not json", "[1,2,3]", "\"a string\"", "42" };

        for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
            warning_count = 0;
            MylConfig *c = myl_config_parse(bad[i]);

            CHECK(c != NULL);
            CHECK(warning_count == 1);
            myl_config_free(c);
        }
    }

    /* An unsupported key is reported, not fatal — the rest still applies. */
    {
        warning_count = 0;
        MylConfig *c = myl_config_parse("{\"trusted_origins\":[\"http://a.test\"],"
                                       "\"reload\":true}");

        CHECK(c != NULL);
        CHECK(warning_count == 1);
        CHECK(myl_config_origin_trusted(c, "http://a.test/page"));
        myl_config_free(c);
    }

    /* Wrong shapes for the two keys we do know. */
    {
        warning_count = 0;
        MylConfig *c = myl_config_parse("{\"trusted_origins\":\"http://a.test\","
                                       "\"scripts\":[]}");

        CHECK(c != NULL);
        CHECK(warning_count == 2);
        CHECK(!myl_config_origin_trusted(c, "http://a.test/"));
        myl_config_free(c);
    }

    /* Settings that are not an object cannot be merged key by key. */
    {
        warning_count = 0;
        MylConfig *c = myl_config_parse("{\"scripts\":{\"keyboard\":\"de\"}}");
        MylManifest *m = manifest_with("keyboard", "");
        MylManifestList *list = list_from(&m, 1);

        myl_config_apply(c, list);
        /* Exactly one warning: the entry was dropped while parsing, so it is not
         * around afterwards to also be reported as matching no script. */
        CHECK(warning_count == 1);
        CHECK(list->items[0].config == NULL);

        myl_manifest_list_free(list);
        myl_config_free(c);
    }

    /* Same bar as the manifest's own config: this text ends up in JS source. */
    {
        warning_count = 0;
        MylConfig *c = myl_config_parse("{\"scripts\":{\"keyboard\":{\"layout\":foo}}}");
        MylManifest *m = manifest_with("keyboard", "");
        MylManifestList *list = list_from(&m, 1);

        myl_config_apply(c, list);
        CHECK(warning_count == 1);
        CHECK(list->items[0].config == NULL);

        myl_manifest_list_free(list);
        myl_config_free(c);
    }

    /* JSON has no rule against repeating a key and jsmn does not deduplicate, so
     * both occurrences reach the parse loop. The second one used to allocate a
     * fresh array while the first one's count still stood and then write past its
     * end — a heap-buffer-overflow reachable from a hand-edited config.json. The
     * later occurrence wins and says so. */
    {
        warning_count = 0;
        /* Deliberately more entries in the second object than in the first: that
         * is the shape that wrote out of bounds. */
        MylConfig *c = myl_config_parse("{\"scripts\":{\"a\":{\"x\":1}},"
                                       "\"scripts\":{\"b\":{\"y\":2},\"c\":{\"z\":3}}}");
        MylManifest *ma = manifest_with("a", "");
        MylManifest *mb = manifest_with("b", "");
        MylManifest *mc = manifest_with("c", "");
        MylManifest *all[3];
        MylManifestList *list;

        all[0] = ma;
        all[1] = mb;
        all[2] = mc;
        list = list_from(all, 3);

        CHECK(c != NULL);
        CHECK(warning_count == 1);

        myl_config_apply(c, list);
        CHECK(list->items[0].config == NULL);
        CHECK_STREQ(list->items[1].config, "{\"y\":2}");
        CHECK_STREQ(list->items[2].config, "{\"z\":3}");

        myl_manifest_list_free(list);
        myl_config_free(c);
    }

    {
        warning_count = 0;
        MylConfig *c = myl_config_parse("{\"trusted_origins\":[\"http://a.test\"],"
                                       "\"trusted_origins\":[\"http://b.test\","
                                       "\"http://c.test\"]}");

        CHECK(c != NULL);
        CHECK(warning_count == 1);
        CHECK(!myl_config_origin_trusted(c, "http://a.test/"));
        CHECK(myl_config_origin_trusted(c, "http://b.test/"));
        CHECK(myl_config_origin_trusted(c, "http://c.test/"));
        myl_config_free(c);
    }
}

/* ------------------------------------------------------------------ *
 * merging
 * ------------------------------------------------------------------ */

static void test_merge(void)
{
    /* The device wins per key, and the manifest keeps the rest. This is the
     * point of merging rather than replacing: setting one option must not
     * silently drop the others the script shipped with. */
    {
        warning_count = 0;
        MylConfig *c = myl_config_parse("{\"scripts\":{\"domain-block\":"
                                       "{\"home\":\"http://kiosk/\"}}}");
        MylManifest *m = manifest_with("domain-block",
                                       "\"config\":{\"home\":\"http://old/\","
                                       "\"message\":\"nope\"}");
        MylManifestList *list = list_from(&m, 1);

        myl_config_apply(c, list);
        CHECK(warning_count == 0);
        /* manifest keys first, in their original order, then the device's */
        CHECK_STREQ(list->items[0].config,
                    "{\"message\":\"nope\",\"home\":\"http://kiosk/\"}");

        myl_manifest_list_free(list);
        myl_config_free(c);
    }

    /* No manifest config: the device's settings are all there is. */
    {
        MylConfig *c = myl_config_parse("{\"scripts\":{\"screensaver\":{\"idle\":300}}}");
        MylManifest *m = manifest_with("screensaver", "");
        MylManifestList *list = list_from(&m, 1);

        myl_config_apply(c, list);
        CHECK_STREQ(list->items[0].config, "{\"idle\":300}");

        myl_manifest_list_free(list);
        myl_config_free(c);
    }

    /* No device entry: the manifest's defaults are untouched, byte for byte. */
    {
        MylConfig *c = myl_config_parse("{}");
        MylManifest *m = manifest_with("keyboard", "\"config\":{\"layout\": \"de\"}");
        MylManifestList *list = list_from(&m, 1);

        myl_config_apply(c, list);
        CHECK_STREQ(list->items[0].config, "{\"layout\": \"de\"}");

        myl_manifest_list_free(list);
        myl_config_free(c);
    }

    /* Nested values are replaced, not blended. One sentence to explain beats a
     * deep merge nobody can predict. */
    {
        MylConfig *c = myl_config_parse("{\"scripts\":{\"a\":{\"o\":{\"y\":2}}}}");
        MylManifest *m = manifest_with("a", "\"config\":{\"o\":{\"x\":1}}");
        MylManifestList *list = list_from(&m, 1);

        myl_config_apply(c, list);
        CHECK_STREQ(list->items[0].config, "{\"o\":{\"y\":2}}");

        myl_manifest_list_free(list);
        myl_config_free(c);
    }

    /* Both empty stays valid JSON — the wrapper splices this straight in. */
    {
        MylConfig *c = myl_config_parse("{\"scripts\":{\"a\":{}}}");
        MylManifest *m = manifest_with("a", "\"config\":{}");
        MylManifestList *list = list_from(&m, 1);

        myl_config_apply(c, list);
        CHECK_STREQ(list->items[0].config, "{}");

        myl_manifest_list_free(list);
        myl_config_free(c);
    }
}

/* A configuration key is coupled to a directory name and nothing checks it, so
 * a typo means settings that arrive nowhere. */
static void test_unmatched_key(void)
{
    warning_count = 0;
    MylConfig *c = myl_config_parse("{\"scripts\":{\"domain-blocker\":{\"a\":1},"
                                   "\"keyboard\":{\"b\":2}}}");
    MylManifest *one = manifest_with("keyboard", "");
    MylManifest *two = manifest_with("screensaver", "");
    MylManifest *both[2] = { one, two };
    MylManifestList *list = list_from(both, 2);

    myl_config_apply(c, list);

    /* Exactly one: "domain-blocker" has no script, "keyboard" does. */
    CHECK(warning_count == 1);

    myl_manifest_list_free(list);
    myl_config_free(c);
}

/* ------------------------------------------------------------------ *
 * trusted origins
 * ------------------------------------------------------------------ */

static void test_origin_trusted(void)
{
    /* Without an entry nothing is trusted, so no meta tag has any effect
     * anywhere. That is the starting position, not a degenerate case. */
    {
        MylConfig *c = myl_config_parse("{}");

        CHECK(!myl_config_origin_trusted(c, "http://localhost:4000/"));
        myl_config_free(c);
    }

    {
        MylConfig *c = myl_config_parse(
            "{\"trusted_origins\":[\"http://localhost:4000\",\"https://kiosk.test\"]}");

        CHECK(myl_config_origin_trusted(c, "http://localhost:4000/"));
        CHECK(myl_config_origin_trusted(c, "http://localhost:4000/deep/path?q=1"));
        CHECK(myl_config_origin_trusted(c, "https://kiosk.test/"));

        /* A port in the entry demands that port: trust is not the place to be
         * generous, and a browser treats these as different origins too. */
        CHECK(!myl_config_origin_trusted(c, "http://localhost/"));
        CHECK(!myl_config_origin_trusted(c, "http://localhost:4001/"));
        CHECK(!myl_config_origin_trusted(c, "https://kiosk.test:8443/"));

        /* Scheme and host must match as well. */
        CHECK(!myl_config_origin_trusted(c, "https://localhost:4000/"));
        CHECK(!myl_config_origin_trusted(c, "http://evil.test/"));
        CHECK(!myl_config_origin_trusted(c, "https://kiosk.test.evil.test/"));

        /* Host comparison is case-insensitive, as in a URL. */
        CHECK(myl_config_origin_trusted(c, "https://KIOSK.TEST/"));

        /* Userinfo must not be able to smuggle a trusted host into the string. */
        CHECK(!myl_config_origin_trusted(c, "https://kiosk.test@evil.test/"));

        CHECK(!myl_config_origin_trusted(c, ""));
        CHECK(!myl_config_origin_trusted(c, "not a url"));
        myl_config_free(c);
    }

    /* An entry that is not an origin is the mistake to expect — match patterns and
     * the domain-block allowlist both take host:port, so leaving the scheme off
     * comes naturally. It must not be silent: with no usable entry left, not one
     * meta tag on the device does anything, and nothing else would say why. */
    {
        const char *bad[] = { "localhost:4000", "a.test", "http://", "/statusbar",
                              "" };

        for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
            char json[256];
            MylConfig *c;

            snprintf(json, sizeof(json), "{\"trusted_origins\":[\"%s\"]}", bad[i]);
            warning_count = 0;
            c = myl_config_parse(json);

            CHECK(c != NULL);
            /* One for the entry, one for the array ending up empty. */
            CHECK(warning_count == 2);
            CHECK(!myl_config_origin_trusted(c, "http://localhost:4000/"));
            myl_config_free(c);
        }
    }

    /* A usable entry alongside a broken one keeps working, and only the broken one
     * is reported. */
    {
        warning_count = 0;
        MylConfig *c = myl_config_parse(
            "{\"trusted_origins\":[\"localhost:4000\",\"http://localhost:4000\"]}");

        CHECK(warning_count == 1);
        CHECK(myl_config_origin_trusted(c, "http://localhost:4000/"));
        myl_config_free(c);
    }
}

/* ------------------------------------------------------------------ *
 * whether a script runs
 * ------------------------------------------------------------------ */

static void test_script_enabled(void)
{
    struct {
        const char *body;    /* manifest keys */
        const char *enable;  /* myelin-enable content, NULL when untrusted */
        const char *disable; /* myelin-disable content */
        bool expected;
    } cases[] = {
        /* Nothing said anywhere: the script stays dormant. */
        { "", NULL, NULL, false },
        { "\"enabled\":true", NULL, NULL, true },
        { "\"enabled\":false", NULL, NULL, false },

        /* The device overrides the manifest, in both directions. */
        { "\"enabled\":false,\"config\":{\"enabled\":true}", NULL, NULL, true },
        { "\"enabled\":true,\"config\":{\"enabled\":false}", NULL, NULL, false },
        /* A config that says nothing about it leaves the manifest alone. */
        { "\"enabled\":false,\"config\":{\"pin\":\"1234\"}", NULL, NULL, false },
        /* Only a real boolean counts. */
        { "\"enabled\":false,\"config\":{\"enabled\":\"yes\"}", NULL, NULL, false },
        { "\"enabled\":false,\"config\":{\"enabled\":1}", NULL, NULL, false },

        /* A trusted page overrides the device. */
        { "\"enabled\":false", "unit", NULL, true },
        { "\"enabled\":true", NULL, "unit", false },
        { "\"config\":{\"enabled\":false}", "unit", NULL, true },
        { "\"config\":{\"enabled\":true}", NULL, "unit", false },
        /* disable wins over enable, as the meta-tag helper always did. */
        { "", "unit", "unit", false },

        /* Space separated lists, and no partial matches. */
        { "\"enabled\":false", "keyboard unit screensaver", NULL, true },
        { "\"enabled\":false", "  unit\tkeyboard\n", NULL, true },
        { "\"enabled\":false", "unittest", NULL, false },
        { "\"enabled\":false", "un", NULL, false },
        { "\"enabled\":true", "", "", true },
    };

    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        MylManifest *m = manifest_with("unit", cases[i].body);
        bool got;

        CHECK(m != NULL);
        if (!m)
            continue;

        got = myl_script_enabled(m, cases[i].enable, cases[i].disable);
        CHECK(got == cases[i].expected);

        /* Every row shares one line number, so name the row that broke —
         * otherwise a failure here means reading the table and counting. */
        if (got != cases[i].expected) {
            fprintf(stderr, "     row %zu: manifest {%s} enable=%s disable=%s\n", i,
                    cases[i].body, cases[i].enable ? cases[i].enable : "(none)",
                    cases[i].disable ? cases[i].disable : "(none)");
        }

        myl_manifest_free(m);
    }
}

/* On an untrusted origin the caller passes NULL for both, and then nothing the page
 * claims can reach the decision. The property is the point of the design, so it gets
 * its own check rather than living inside the table above.
 *
 * The manifest here says enabled:true, because a dormant script would pass this by
 * accident — it would be off either way. */
static void test_untrusted_page_cannot_disable(void)
{
    MylManifest *m = manifest_with("domain-block", "\"enabled\":true");

    CHECK(m != NULL);
    if (!m)
        return;

    /* What a hostile page would like to happen. */
    CHECK(!myl_script_enabled(m, NULL, "domain-block"));
    /* What happens once its meta tags are not consulted. */
    CHECK(myl_script_enabled(m, NULL, NULL));

    myl_manifest_free(m);
}

/* ------------------------------------------------------------------ *
 * config.json in the search path
 * ------------------------------------------------------------------ */

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

static void remove_file(const char *dir, const char *name)
{
    char path[2048];

    snprintf(path, sizeof(path), "%s/%s", dir, name);
    unlink(path);
}

static void test_load_path(void)
{
    char base_template[] = "/tmp/cus-config-XXXXXX";
    char *base = mkdtemp(base_template);
    char first[1024];
    char second[1024];
    const char *path[2];
    MylConfig *c;

    CHECK(base != NULL);
    if (!base)
        return;

    snprintf(first, sizeof(first), "%s/first", base);
    snprintf(second, sizeof(second), "%s/second", base);
    mkdir(first, 0777);
    mkdir(second, 0777);
    path[0] = first;
    path[1] = second;

    /* No file anywhere: an empty configuration, silently. */
    warning_count = 0;
    c = myl_config_load_path(path, 2);
    CHECK(c != NULL);
    CHECK(warning_count == 0);
    CHECK(!myl_config_origin_trusted(c, "http://a.test/"));
    myl_config_free(c);

    /* One file, in the earlier directory. */
    write_file(first, "config.json", "{\"trusted_origins\":[\"http://a.test\"]}");
    c = myl_config_load_path(path, 2);
    CHECK(myl_config_origin_trusted(c, "http://a.test/"));
    myl_config_free(c);

    /* Two files: the later directory wins, and not by merging. */
    write_file(second, "config.json", "{\"trusted_origins\":[\"http://b.test\"]}");
    c = myl_config_load_path(path, 2);
    CHECK(myl_config_origin_trusted(c, "http://b.test/"));
    CHECK(!myl_config_origin_trusted(c, "http://a.test/"));
    myl_config_free(c);

    /* A malformed later file still wins — falling back to the earlier one would
     * mean a typo silently resurrects settings someone thought they replaced. */
    warning_count = 0;
    write_file(second, "config.json", "{ broken");
    c = myl_config_load_path(path, 2);
    CHECK(warning_count == 1);
    CHECK(!myl_config_origin_trusted(c, "http://a.test/"));
    CHECK(!myl_config_origin_trusted(c, "http://b.test/"));
    myl_config_free(c);

    /* A file of no bytes is not a configuration. It used to read back as an empty
     * string, count as "found" — so it discarded the earlier directory's file —
     * and then parse into an empty configuration without a word, which looks
     * exactly like every setting having been reverted. An interrupted scp or a
     * "> config.json" before pasting produces it. */
    warning_count = 0;
    write_file(first, "config.json", "{\"trusted_origins\":[\"http://a.test\"]}");
    write_file(second, "config.json", "");
    c = myl_config_load_path(path, 2);
    CHECK(warning_count == 1);
    CHECK(myl_config_origin_trusted(c, "http://a.test/"));
    myl_config_free(c);

    /* Same silent wipe by another route: a *directory* named config.json opens and
     * seeks like a file on Linux and then reads nothing. */
    warning_count = 0;
    remove_file(second, "config.json");
    {
        char dir_path[2048];

        snprintf(dir_path, sizeof(dir_path), "%s/config.json", second);
        mkdir(dir_path, 0777);
        c = myl_config_load_path(path, 2);
        CHECK(warning_count >= 1);
        CHECK(myl_config_origin_trusted(c, "http://a.test/"));
        myl_config_free(c);
        rmdir(dir_path);
    }

    remove_file(first, "config.json");
    remove_file(second, "config.json");
    rmdir(first);
    rmdir(second);
    rmdir(base);
}

void test_config(void)
{
    myl_log_set_handler(count_warnings, NULL);

    test_parse();
    test_merge();
    test_unmatched_key();
    test_origin_trusted();
    test_script_enabled();
    test_untrusted_page_cannot_disable();
    test_load_path();

    myl_log_set_handler(NULL, NULL);
}
