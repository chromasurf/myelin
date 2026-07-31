/*
 * log.h — tiny logging shim.
 *
 * The parsing and matching layer must stay free of GLib so it can be unit
 * tested without a WPE WebKit toolchain. It still needs to report malformed
 * manifests, so it logs through this indirection: extension.c routes it to
 * g_warning()/g_debug() under the "cog-userscripts" domain, the test harness
 * routes it to a counter.
 */

#ifndef CUS_LOG_H
#define CUS_LOG_H

typedef enum {
    CUS_LOG_DEBUG,
    CUS_LOG_WARNING
} CusLogLevel;

typedef void (*CusLogFunc)(CusLogLevel level, const char *message, void *user_data);

/* Installs the sink for all subsequent log calls. Passing NULL restores the
 * default, which discards everything. */
void cus_log_set_handler(CusLogFunc func, void *user_data);

/* printf-style. Messages are truncated at 1 KiB. */
void cus_log(CusLogLevel level, const char *format, ...)
#ifdef __GNUC__
    __attribute__((format(printf, 2, 3)))
#endif
    ;

#define cus_debug(...) cus_log(CUS_LOG_DEBUG, __VA_ARGS__)
#define cus_warn(...) cus_log(CUS_LOG_WARNING, __VA_ARGS__)

#endif /* CUS_LOG_H */
