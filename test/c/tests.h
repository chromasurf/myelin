/*
 * tests.h — minimal assertion harness.
 *
 * Deliberately not GLib's g_test: the layer under test is libc-only, and the
 * tests should run on a development machine with nothing installed.
 */

#ifndef CUS_TESTS_H
#define CUS_TESTS_H

#include <stdio.h>
#include <string.h>

extern int tests_run;
extern int tests_failed;

#define CHECK(cond)                                                            \
    do {                                                                       \
        tests_run++;                                                           \
        if (!(cond)) {                                                         \
            tests_failed++;                                                    \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);    \
        }                                                                      \
    } while (0)

#define CHECK_STREQ(actual, expected)                                          \
    do {                                                                       \
        const char *a_ = (actual);                                             \
        const char *e_ = (expected);                                           \
        tests_run++;                                                           \
        if (!a_ || !e_ || strcmp(a_, e_) != 0) {                               \
            tests_failed++;                                                    \
            fprintf(stderr, "FAIL %s:%d: expected \"%s\", got \"%s\"\n",       \
                    __FILE__, __LINE__, e_ ? e_ : "(null)",                    \
                    a_ ? a_ : "(null)");                                       \
        }                                                                      \
    } while (0)

void test_match_pattern(void);
void test_manifest(void);
void test_config(void);

#endif /* CUS_TESTS_H */
