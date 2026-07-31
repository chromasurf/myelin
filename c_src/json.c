/* Strict mode rejects what permissive jsmn waves through: unquoted primitives,
 * non-string object keys, trailing garbage. That matters beyond tidiness —
 * manifest.c hands the raw text of a "config" object straight into JS source,
 * so "valid JSON" has to actually mean it. Without this, {"config":{"a":foo}}
 * parses and `foo` ends up as an identifier in the page's scope. */
#define JSMN_STRICT

/* jsmn in implementation mode. This include must come first and must not be
 * guarded by JSMN_HEADER — json.h defines that macro, so once json.h has been
 * seen jsmn.h would only ever contribute declarations, and nothing would define
 * the parser. */
#include "vendor/jsmn.h"

#include "json.h"

#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ *
 * JSON string decoding
 * ------------------------------------------------------------------ */

static size_t encode_utf8(unsigned long cp, char *out)
{
    if (cp < 0x80) {
        out[0] = (char)cp;
        return 1;
    }
    if (cp < 0x800) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        out[0] = (char)(0xE0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    out[0] = (char)(0xF0 | (cp >> 18));
    out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (char)(0x80 | (cp & 0x3F));
    return 4;
}

static bool parse_hex4(const char *s, unsigned long *out)
{
    unsigned long value = 0;

    for (int i = 0; i < 4; i++) {
        char c = s[i];
        value <<= 4;

        if (c >= '0' && c <= '9')
            value |= (unsigned long)(c - '0');
        else if (c >= 'a' && c <= 'f')
            value |= (unsigned long)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F')
            value |= (unsigned long)(c - 'A' + 10);
        else
            return false;
    }

    *out = value;
    return true;
}

/* Decodes a raw JSON string body (the bytes between the quotes) into a fresh
 * NUL-terminated UTF-8 string. */
static char *decode_json_string(const char *src, size_t len)
{
    /* Escapes only ever shrink the input, except \uXXXX which yields at most
     * 3 bytes from 6 — so the source length is always a safe upper bound. */
    char *out = malloc(len + 1);
    size_t w = 0;

    if (!out)
        return NULL;

    for (size_t i = 0; i < len; i++) {
        if (src[i] != '\\') {
            out[w++] = src[i];
            continue;
        }

        if (++i >= len)
            break;

        switch (src[i]) {
        case '"': out[w++] = '"'; break;
        case '\\': out[w++] = '\\'; break;
        case '/': out[w++] = '/'; break;
        case 'b': out[w++] = '\b'; break;
        case 'f': out[w++] = '\f'; break;
        case 'n': out[w++] = '\n'; break;
        case 'r': out[w++] = '\r'; break;
        case 't': out[w++] = '\t'; break;
        case 'u': {
            unsigned long cp;

            if (i + 4 >= len || !parse_hex4(src + i + 1, &cp)) {
                out[w++] = 'u';
                break;
            }
            i += 4;

            /* Combine a surrogate pair when the low half follows. */
            if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 < len &&
                src[i + 1] == '\\' && src[i + 2] == 'u') {
                unsigned long low;

                if (parse_hex4(src + i + 3, &low) && low >= 0xDC00 && low <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                    i += 6;
                }
            }

            w += encode_utf8(cp, out + w);
            break;
        }
        default:
            out[w++] = src[i];
            break;
        }
    }

    out[w] = '\0';
    return out;
}

/* ------------------------------------------------------------------ *
 * token walking
 * ------------------------------------------------------------------ */

int myl_json_skip(const jsmntok_t *tokens, int i)
{
    int n;

    switch (tokens[i].type) {
    case JSMN_OBJECT:
        n = tokens[i].size;
        i++;
        for (int k = 0; k < n; k++) {
            i++; /* the key is always a single token */
            i = myl_json_skip(tokens, i);
        }
        return i;
    case JSMN_ARRAY:
        n = tokens[i].size;
        i++;
        for (int k = 0; k < n; k++)
            i = myl_json_skip(tokens, i);
        return i;
    default:
        return i + 1;
    }
}

bool myl_json_eq(const char *json, const jsmntok_t *tok, const char *literal)
{
    size_t len = (size_t)(tok->end - tok->start);

    return tok->type == JSMN_STRING && strlen(literal) == len &&
           strncmp(json + tok->start, literal, len) == 0;
}

char *myl_json_dup(const char *json, const jsmntok_t *tok)
{
    return decode_json_string(json + tok->start, (size_t)(tok->end - tok->start));
}

bool myl_json_is_true(const char *json, const jsmntok_t *tok)
{
    return tok->type == JSMN_PRIMITIVE && json[tok->start] == 't';
}

bool myl_json_is_false(const char *json, const jsmntok_t *tok)
{
    return tok->type == JSMN_PRIMITIVE && json[tok->start] == 'f';
}

/* ------------------------------------------------------------------ *
 * verbatim safety
 * ------------------------------------------------------------------ */

static bool literal_is(const char *text, size_t len, const char *literal)
{
    return strlen(literal) == len && strncmp(text, literal, len) == 0;
}

static bool digits(const char *text, size_t len, size_t *i)
{
    size_t start = *i;

    while (*i < len && text[*i] >= '0' && text[*i] <= '9')
        (*i)++;

    return *i > start;
}

/* The JSON number grammar, which is stricter than strtod: no leading plus, no
 * leading zeros, no hex, no "1." and no ".5". */
static bool number_ok(const char *text, size_t len)
{
    size_t i = 0;

    if (i < len && text[i] == '-')
        i++;

    if (i < len && text[i] == '0')
        i++;
    else if (!digits(text, len, &i))
        return false;

    if (i < len && text[i] == '.') {
        i++;
        if (!digits(text, len, &i))
            return false;
    }

    if (i < len && (text[i] == 'e' || text[i] == 'E')) {
        i++;
        if (i < len && (text[i] == '+' || text[i] == '-'))
            i++;
        if (!digits(text, len, &i))
            return false;
    }

    return i == len;
}

static bool primitive_ok(const char *text, size_t len)
{
    return literal_is(text, len, "true") || literal_is(text, len, "false") ||
           literal_is(text, len, "null") || number_ok(text, len);
}

bool myl_json_slice_ok(const char *json, const jsmntok_t *tokens, int index)
{
    int end = myl_json_skip(tokens, index);

    for (int i = index; i < end; i++) {
        const jsmntok_t *tok = &tokens[i];
        size_t len = (size_t)(tok->end - tok->start);

        if (tok->type == JSMN_PRIMITIVE && !primitive_ok(json + tok->start, len))
            return false;

        /* Control characters matter inside a string and only there: a raw
         * newline would end the JS string literal this text becomes. Between
         * tokens they are just the formatting of a pretty-printed manifest, and
         * a newline there is as legal in JS as it is in JSON.
         *
         * Sweeping the whole range instead was the first version, and it refused
         * every manifest whose "config" spanned more than one line. */
        if (tok->type == JSMN_STRING) {
            for (size_t p = 0; p < len; p++) {
                if ((unsigned char)json[tok->start + p] < 0x20)
                    return false;
            }
        }
    }

    return true;
}
