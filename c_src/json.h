/*
 * json.h — the jsmn token helpers shared by manifest.c and config.c.
 *
 * Both files walk jsmn token arrays and need the same handful of operations:
 * skip past a value, compare a key against a literal, decode a string with its
 * escapes. Keeping them here means one copy rather than two that drift.
 *
 * jsmn is included in *declaration* mode (JSMN_HEADER), so its functions have
 * external linkage and json.c is the single translation unit that defines them.
 * Do not define JSMN_STATIC anywhere: that would make the declarations static
 * and every includer would need its own copy of the parser.
 *
 * libc-only, like everything it is included from, so the whole parsing layer
 * stays unit testable without a WPE WebKit toolchain.
 */

#ifndef CUS_JSON_H
#define CUS_JSON_H

#include <stdbool.h>
#include <stddef.h>

#define JSMN_HEADER
#include "vendor/jsmn.h"

/* Returns the index just past token `i` and everything nested inside it. */
int cus_json_skip(const jsmntok_t *tokens, int i);

/* True when `tok` is the string `literal`. Used to match object keys, which
 * jsmn hands back as plain string tokens. */
bool cus_json_eq(const char *json, const jsmntok_t *tok, const char *literal);

/* Decodes a string token into a fresh NUL-terminated UTF-8 string. jsmn returns
 * the raw slice, so escapes are still encoded when this is called. */
char *cus_json_dup(const char *json, const jsmntok_t *tok);

bool cus_json_is_true(const char *json, const jsmntok_t *tok);
bool cus_json_is_false(const char *json, const jsmntok_t *tok);

/* True when the raw text of token `index` and everything nested inside it can be
 * handed onward verbatim — as JSON, or spliced into JS source.
 *
 * jsmn is not enough of a validator for that, even with JSMN_STRICT: strict mode
 * only requires a primitive to be *terminated* by a comma, brace or bracket. It
 * never looks at the characters, so `foo` in {"a": foo} parses happily as a
 * primitive. Passed on into JS that becomes an identifier read from the page's
 * scope. So every primitive here is checked against true/false/null and the JSON
 * number grammar.
 *
 * Raw control characters are rejected too. jsmn accepts them inside strings, and
 * a literal newline would break the JS line the text lands on. */
bool cus_json_slice_ok(const char *json, const jsmntok_t *tokens, int index);

#endif /* CUS_JSON_H */
