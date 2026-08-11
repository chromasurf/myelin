/*
 * match_pattern.h — Chrome-style match patterns.
 *
 * Grammar (subset of the Chrome/WebExtension spec):
 *
 *   <pattern> := "<all_urls>" | <scheme> "://" <host> [":" <port>] <path>
 *   <scheme>  := "*" | "http" | "https" | "file" | "ws" | "wss"
 *   <host>    := "*" | "*." <hostname> | <hostname> | ""   (empty only for file:)
 *   <path>    := "/" <chars, where "*" is a wildcard>
 *
 * "*" as a scheme means http or https, matching Chrome. A leading "*." host
 * also matches the bare domain: a pattern for any scheme, any subdomain of
 * example.com and any path matches both example.com and a.example.com.
 *
 * A port is allowed in the pattern.
 */

#ifndef MYL_MATCH_PATTERN_H
#define MYL_MATCH_PATTERN_H

#include <stdbool.h>

typedef struct {
    char *scheme;      /* NULL means "*" (http or https) */
    char *host;        /* NULL means any host; lowercased */
    char *port;        /* NULL means any port */
    char *path;        /* glob, "*" is the only wildcard; never NULL */
    bool subdomains;   /* pattern host started with "*." */
    bool all_urls;     /* pattern was "<all_urls>" */
} MylMatchPattern;

/* Parses `pattern` into `out`. Returns false and leaves `out` untouched on a
 * malformed pattern. On success the caller owns the strings in `out` and must
 * release them with myl_match_pattern_clear(). */
bool myl_match_pattern_parse(const char *pattern, MylMatchPattern *out);

/* Frees the strings owned by `p` and zeroes it. Safe on an all-zero struct. */
void myl_match_pattern_clear(MylMatchPattern *p);

/* True when `url` satisfies `p`. Scheme and host compare case-insensitively,
 * the path compares case-sensitively. Any URL fragment is ignored; the query
 * string is part of the path for matching purposes, as in Chrome. */
bool myl_match_pattern_matches(const MylMatchPattern *p, const char *url);

/* True when `text` matches `glob`, where "*" stands for any run of characters
 * (including none) and every other character is literal. Exposed for tests. */
bool myl_glob_match(const char *glob, const char *text);

/* Splits `url` into its parts. The host excludes userinfo and port and is
 * lowercased; `*port_out` is NULL when the URL names none. The path runs to the
 * fragment and therefore includes the query, which is what match patterns
 * compare against. Returns false on something that is not a URL, in which case
 * nothing is assigned. The caller frees all four.
 *
 * Exposed so the origin check in config.c takes the same apart the same way,
 * rather than growing a second parser that disagrees at the edges. */
bool myl_split_url(const char *url, char **scheme_out, char **host_out,
                   char **port_out, char **path_out);

#endif /* MYL_MATCH_PATTERN_H */
