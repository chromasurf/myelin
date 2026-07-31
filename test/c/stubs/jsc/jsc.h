/*
 * Enough of the JSC GLib API to compile injector.c and extension.c on a machine
 * with no WPE WebKit — see `make -C test/c syntax`.
 *
 * These two files are the only ones that touch WebKit, and until this existed
 * nothing compiled them before a device build: a typo travelled all the way into
 * a firmware image. This does not verify the API, it verifies our use of it —
 * signatures are copied from the JSC GLib documentation, so a wrong argument
 * list or type fails here the way it would there. If WebKit changes an API, the
 * device build is still the thing that finds out.
 *
 * Only what those two files actually call is declared. Add to it when they grow.
 */
#ifndef STUB_JSC_H
#define STUB_JSC_H
#include <glib-object.h>

typedef struct _JSCContext JSCContext;
typedef struct _JSCValue JSCValue;
typedef struct _JSCException JSCException;

G_DEFINE_AUTOPTR_CLEANUP_FUNC(JSCValue, g_object_unref)

#define JSC_TYPE_VALUE (jsc_value_get_type())
GType jsc_value_get_type(void);

JSCException *jsc_context_get_exception(JSCContext *context);
void jsc_context_clear_exception(JSCContext *context);
char *jsc_exception_report(JSCException *exception);

JSCValue *jsc_context_evaluate(JSCContext *context, const char *code, gssize length);
JSCValue *jsc_context_evaluate_with_source_uri(JSCContext *context, const char *code,
                                               gssize length, const char *uri,
                                               guint line_number);

gboolean jsc_value_is_function(JSCValue *value);
gboolean jsc_value_is_object(JSCValue *value);
gboolean jsc_value_is_array(JSCValue *value);
gboolean jsc_value_is_string(JSCValue *value);
char *jsc_value_to_string(JSCValue *value);
JSCValue *jsc_value_new_string(JSCContext *context, const char *string);
JSCValue *jsc_value_function_call(JSCValue *value, GType first_parameter_type, ...);
void jsc_value_object_set_property(JSCValue *value, const char *name, JSCValue *property);
JSCValue *jsc_value_object_get_property_at_index(JSCValue *value, guint index);
#endif
