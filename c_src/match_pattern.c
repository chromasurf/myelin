#include "match_pattern.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

/* Own duplicator so the file stays free of POSIX feature-test macro juggling
 * around strdup/strndup across the host and cross toolchains. */
static char *dup_range(const char *start, size_t len)
{
    char *out = malloc(len + 1);

    if (!out)
        return NULL;

    memcpy(out, start, len);
    out[len] = '\0';
    return out;
}

static char *dup_range_lower(const char *start, size_t len)
{
    char *out = dup_range(start, len);

    if (!out)
        return NULL;

    for (size_t i = 0; i < len; i++)
        out[i] = (char)tolower((unsigned char)out[i]);

    return out;
}

bool cus_glob_match(const char *glob, const char *text)
{
    const char *g = glob;
    const char *t = text;
    const char *star = NULL;
    const char *star_text = NULL;

    /* Iterative backtracking: on a mismatch, rewind to the most recent "*"
     * and let it swallow one more character. Avoids recursion blowups on
     * patterns like "*a*a*a*". */
    while (*t) {
        if (*g == '*') {
            star = g++;
            star_text = t;
        } else if (*g == *t) {
            g++;
            t++;
        } else if (star) {
            g = star + 1;
            t = ++star_text;
        } else {
            return false;
        }
    }

    while (*g == '*')
        g++;

    return *g == '\0';
}

void cus_match_pattern_clear(CusMatchPattern *p)
{
    if (!p)
        return;

    free(p->scheme);
    free(p->host);
    free(p->port);
    free(p->path);
    memset(p, 0, sizeof(*p));
}

/* Case-insensitive, because a pattern may spell the scheme in any case. */
static bool scheme_is_known(const char *scheme, size_t len)
{
    static const char *known[] = { "http", "https", "file", "ws", "wss" };

    for (size_t i = 0; i < sizeof(known) / sizeof(known[0]); i++) {
        size_t known_len = strlen(known[i]);

        if (known_len != len)
            continue;

        size_t j = 0;
        while (j < len && tolower((unsigned char)scheme[j]) == known[i][j])
            j++;

        if (j == len)
            return true;
    }

    return false;
}

/* Splits an authority such as "localhost:4000" or "[::1]:80" into host and
 * port. `port_start` is set to NULL when there is no port. */
static void split_authority(const char *start, size_t len, size_t *host_len,
                            const char **port_start, size_t *port_len)
{
    const char *bracket = memchr(start, ']', len);
    const char *from = bracket ? bracket + 1 : start;

    *host_len = len;
    *port_start = NULL;
    *port_len = 0;

    for (const char *c = from; c < start + len; c++) {
        if (*c == ':') {
            *host_len = (size_t)(c - start);
            *port_start = c + 1;
            *port_len = (size_t)(start + len - c - 1);
            return;
        }
    }
}

bool cus_match_pattern_parse(const char *pattern, CusMatchPattern *out)
{
    CusMatchPattern p;

    if (!pattern || !out)
        return false;

    memset(&p, 0, sizeof(p));

    if (strcmp(pattern, "<all_urls>") == 0) {
        p.all_urls = true;
        p.path = dup_range("*", 1);
        if (!p.path)
            return false;
        *out = p;
        return true;
    }

    const char *sep = strstr(pattern, "://");
    if (!sep || sep == pattern)
        return false;

    /* --- scheme --- */
    size_t scheme_len = (size_t)(sep - pattern);
    if (!(scheme_len == 1 && pattern[0] == '*') &&
        !scheme_is_known(pattern, scheme_len))
        return false;

    if (!(scheme_len == 1 && pattern[0] == '*')) {
        p.scheme = dup_range_lower(pattern, scheme_len);
        if (!p.scheme)
            goto fail;
    }

    /* --- host and optional port --- */
    const char *host_start = sep + 3;
    const char *slash = strchr(host_start, '/');

    /* Chrome requires an explicit path; "*://example.com" is malformed. */
    if (!slash)
        goto fail;

    size_t authority_len = (size_t)(slash - host_start);
    size_t host_len;
    const char *port_start;
    size_t port_len;

    split_authority(host_start, authority_len, &host_len, &port_start, &port_len);

    if (port_start) {
        if (port_len == 0)
            goto fail;

        for (size_t i = 0; i < port_len; i++) {
            if (!isdigit((unsigned char)port_start[i]))
                goto fail;
        }

        p.port = dup_range(port_start, port_len);
        if (!p.port)
            goto fail;
    }

    if (host_len == 1 && host_start[0] == '*') {
        /* NULL host means "any host". */
    } else if (host_len > 2 && host_start[0] == '*' && host_start[1] == '.') {
        p.subdomains = true;
        p.host = dup_range_lower(host_start + 2, host_len - 2);
        if (!p.host)
            goto fail;
        if (strchr(p.host, '*'))
            goto fail;
    } else if (host_len == 0) {
        /* Only file:// may have an empty host, as in a file pattern rooted at
         * an absolute path. */
        if (!p.scheme || strcmp(p.scheme, "file") != 0)
            goto fail;
        p.host = dup_range("", 0);
        if (!p.host)
            goto fail;
    } else {
        p.host = dup_range_lower(host_start, host_len);
        if (!p.host)
            goto fail;
        if (strchr(p.host, '*'))
            goto fail;
    }

    /* --- path --- */
    p.path = dup_range(slash, strlen(slash));
    if (!p.path)
        goto fail;

    *out = p;
    return true;

fail:
    cus_match_pattern_clear(&p);
    return false;
}

bool cus_split_url(const char *url, char **scheme_out, char **host_out,
                   char **port_out, char **path_out)
{
    const char *sep = strstr(url, "://");

    if (!sep || sep == url)
        return false;

    char *scheme = dup_range_lower(url, (size_t)(sep - url));
    if (!scheme)
        return false;

    const char *authority = sep + 3;
    const char *authority_end = authority + strcspn(authority, "/?#");

    /* Strip userinfo: everything up to and including the last "@". */
    const char *host_start = authority;
    for (const char *c = authority; c < authority_end; c++) {
        if (*c == '@')
            host_start = c + 1;
    }

    size_t host_len;
    const char *port_start;
    size_t port_len;

    split_authority(host_start, (size_t)(authority_end - host_start), &host_len,
                    &port_start, &port_len);

    char *host = dup_range_lower(host_start, host_len);
    if (!host) {
        free(scheme);
        return false;
    }

    char *port = port_start ? dup_range(port_start, port_len) : NULL;
    if (port_start && !port) {
        free(scheme);
        free(host);
        return false;
    }

    const char *path_start = authority_end;
    size_t path_len = strcspn(path_start, "#");
    char *path = path_len ? dup_range(path_start, path_len) : dup_range("/", 1);

    if (!path) {
        free(scheme);
        free(host);
        free(port);
        return false;
    }

    *scheme_out = scheme;
    *host_out = host;
    *port_out = port;
    *path_out = path;
    return true;
}

bool cus_match_pattern_matches(const CusMatchPattern *p, const char *url)
{
    char *scheme = NULL;
    char *host = NULL;
    char *port = NULL;
    char *path = NULL;
    bool ok = false;

    if (!p || !url)
        return false;

    if (!cus_split_url(url, &scheme, &host, &port, &path))
        return false;

    if (p->all_urls) {
        ok = true;
        goto done;
    }

    if (p->scheme) {
        if (strcmp(p->scheme, scheme) != 0)
            goto done;
    } else if (strcmp(scheme, "http") != 0 && strcmp(scheme, "https") != 0) {
        /* A "*" scheme means http or https only, as in Chrome. */
        goto done;
    }

    if (p->host) {
        if (p->subdomains) {
            size_t hl = strlen(host);
            size_t pl = strlen(p->host);

            if (hl == pl) {
                if (strcmp(host, p->host) != 0)
                    goto done;
            } else if (hl > pl) {
                /* "*.example.com" matches "a.example.com" but not "myexample.com". */
                if (host[hl - pl - 1] != '.' || strcmp(host + hl - pl, p->host) != 0)
                    goto done;
            } else {
                goto done;
            }
        } else if (strcmp(p->host, host) != 0) {
            goto done;
        }
    }

    /* A pattern without a port matches any port; one with a port demands it. */
    if (p->port && (!port || strcmp(p->port, port) != 0))
        goto done;

    ok = cus_glob_match(p->path, path);

done:
    free(scheme);
    free(host);
    free(port);
    free(path);
    return ok;
}
