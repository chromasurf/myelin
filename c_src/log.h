/*
 * log.h — tiny logging shim.
 *
 * The parsing and matching layer must stay free of GLib so it can be unit
 * tested without a WPE WebKit toolchain. It still needs to report malformed
 * manifests, so it logs through this indirection: extension.c routes it to
 * g_warning()/g_debug() under the "myelin" domain, the test harness
 * routes it to a counter.
 */

#ifndef MYL_LOG_H
#define MYL_LOG_H

typedef enum {
    MYL_LOG_DEBUG,
    MYL_LOG_WARNING
} MylLogLevel;

typedef void (*MylLogFunc)(MylLogLevel level, const char *message, void *user_data);

/* Installs the sink for all subsequent log calls. Passing NULL restores the
 * default, which discards everything. */
void myl_log_set_handler(MylLogFunc func, void *user_data);

/* printf-style. Messages are truncated at 1 KiB. */
void myl_log(MylLogLevel level, const char *format, ...)
#ifdef __GNUC__
    __attribute__((format(printf, 2, 3)))
#endif
    ;

#define myl_debug(...) myl_log(MYL_LOG_DEBUG, __VA_ARGS__)
#define myl_warn(...) myl_log(MYL_LOG_WARNING, __VA_ARGS__)

#endif /* MYL_LOG_H */
