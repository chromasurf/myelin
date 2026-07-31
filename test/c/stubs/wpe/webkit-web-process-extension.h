#ifndef STUB_WPE_H
#define STUB_WPE_H
#include <glib-object.h>
#include <gmodule.h>
#include <jsc/jsc.h>

typedef struct _WebKitWebProcessExtension WebKitWebProcessExtension;
typedef struct _WebKitWebPage WebKitWebPage;
typedef struct _WebKitFrame WebKitFrame;
typedef struct _WebKitScriptWorld WebKitScriptWorld;

#define WEBKIT_WEB_PAGE(p) ((WebKitWebPage *)(p))

WebKitScriptWorld *webkit_script_world_get_default(void);
JSCContext *webkit_frame_get_js_context_for_script_world(WebKitFrame *frame,
                                                        WebKitScriptWorld *world);
JSCContext *webkit_frame_get_js_context(WebKitFrame *frame);
const char *webkit_frame_get_uri(WebKitFrame *frame);
gboolean webkit_frame_is_main_frame(WebKitFrame *frame);
WebKitFrame *webkit_web_page_get_main_frame(WebKitWebPage *page);
const char *webkit_web_page_get_uri(WebKitWebPage *page);
#endif
