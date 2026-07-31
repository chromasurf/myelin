#include "tests.h"

#include "../../c_src/match_pattern.h"

static bool matches(const char *pattern, const char *url)
{
    MylMatchPattern p;
    bool result;

    if (!myl_match_pattern_parse(pattern, &p))
        return false;

    result = myl_match_pattern_matches(&p, url);
    myl_match_pattern_clear(&p);
    return result;
}

static bool parses(const char *pattern)
{
    MylMatchPattern p;

    if (!myl_match_pattern_parse(pattern, &p))
        return false;

    myl_match_pattern_clear(&p);
    return true;
}

void test_match_pattern(void)
{
    /* --- glob --- */
    CHECK(myl_glob_match("*", ""));
    CHECK(myl_glob_match("*", "/anything"));
    CHECK(myl_glob_match("/a*b", "/axxxb"));
    CHECK(myl_glob_match("/a*b*c", "/abc"));
    CHECK(!myl_glob_match("/a*b", "/axxx"));
    CHECK(myl_glob_match("/exact", "/exact"));
    CHECK(!myl_glob_match("/exact", "/exactly"));
    /* Backtracking must not give up too early. */
    CHECK(myl_glob_match("/*a*a*a", "/aaa"));
    CHECK(!myl_glob_match("/*a*a*a", "/aa"));

    /* --- <all_urls> --- */
    CHECK(matches("<all_urls>", "http://localhost:4000/"));
    CHECK(matches("<all_urls>", "file:///data/index.html"));
    CHECK(matches("<all_urls>", "https://example.com/a/b?c=d"));

    /* --- scheme --- */
    CHECK(matches("http://localhost/*", "http://localhost/"));
    CHECK(!matches("http://localhost/*", "https://localhost/"));
    /* "*" means http or https only, as in Chrome. */
    CHECK(matches("*://localhost/*", "http://localhost/"));
    CHECK(matches("*://localhost/*", "https://localhost/"));
    CHECK(!matches("*://localhost/*", "file://localhost/"));
    CHECK(matches("HTTP://localhost/*", "http://localhost/"));
    CHECK(matches("http://localhost/*", "HTTP://LOCALHOST/"));

    /* --- host --- */
    CHECK(matches("*://*/*", "http://anything.test/"));
    CHECK(matches("*://example.com/*", "http://example.com/"));
    CHECK(!matches("*://example.com/*", "http://other.com/"));

    /* A leading "*." also matches the bare domain. */
    CHECK(matches("*://*.example.com/*", "http://example.com/"));
    CHECK(matches("*://*.example.com/*", "http://a.example.com/"));
    CHECK(matches("*://*.example.com/*", "http://a.b.example.com/"));
    /* ...but must not match a domain that merely ends with the same letters. */
    CHECK(!matches("*://*.example.com/*", "http://myexample.com/"));
    CHECK(!matches("*://*.example.com/*", "http://example.com.evil.test/"));

    /* A pattern without a port matches any port; userinfo is ignored. */
    CHECK(matches("http://localhost/*", "http://localhost:4000/"));
    CHECK(matches("http://localhost/*", "http://user:pw@localhost:4000/"));

    /* --- port (a deliberate deviation from Chrome, see the header) --- */
    CHECK(matches("http://localhost:4000/*", "http://localhost:4000/"));
    CHECK(matches("http://localhost:4000/*", "http://localhost:4000/dashboard"));
    /* A pattern with a port demands exactly that port. */
    CHECK(!matches("http://localhost:4000/*", "http://localhost:5000/"));
    CHECK(!matches("http://localhost:4000/*", "http://localhost/"));
    CHECK(matches("*://*:4000/*", "http://anything.test:4000/"));
    /* A non-numeric or empty port makes the pattern malformed. */
    CHECK(!parses("http://localhost:abc/*"));
    CHECK(!parses("http://localhost:/*"));

    /* --- path --- */
    CHECK(matches("http://localhost:4000/*", "http://localhost:4000/"));
    CHECK(matches("http://localhost/admin*", "http://localhost/admin/users"));
    CHECK(!matches("http://localhost/admin*", "http://localhost/public"));
    /* The query string is part of the path, the fragment is not. */
    CHECK(matches("http://localhost/*?debug=1", "http://localhost/page?debug=1"));
    CHECK(matches("http://localhost/page", "http://localhost/page#section"));
    /* A URL without a path still matches a root wildcard pattern. */
    CHECK(matches("http://localhost/*", "http://localhost"));

    /* --- file --- */
    CHECK(matches("file:///*", "file:///data/index.html"));
    CHECK(parses("file:///data/*"));

    /* --- malformed patterns are rejected --- */
    CHECK(!parses("example.com/*"));            /* no scheme */
    CHECK(!parses("*://example.com"));          /* no path */
    CHECK(!parses("ftp://example.com/*"));      /* unsupported scheme */
    CHECK(!parses("*://*example.com/*"));       /* "*" not followed by "." */
    CHECK(!parses("*://ex*ample.com/*"));       /* "*" inside the host */
    CHECK(!parses("://example.com/*"));         /* empty scheme */
    CHECK(!parses("http://" "/*"));             /* empty host, non-file scheme */
    CHECK(!parses(""));
}
