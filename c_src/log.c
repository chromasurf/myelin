#include "log.h"

#include <stdarg.h>
#include <stdio.h>

static MylLogFunc s_handler;
static void *s_user_data;

void myl_log_set_handler(MylLogFunc func, void *user_data)
{
    s_handler = func;
    s_user_data = user_data;
}

void myl_log(MylLogLevel level, const char *format, ...)
{
    char buffer[1024];
    va_list args;

    if (!s_handler)
        return;

    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);

    s_handler(level, buffer, s_user_data);
}
