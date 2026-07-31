/*
 * injector.h — evaluates a content script's CSS and JS in a page context.
 *
 * Unlike the parsing layer this needs WebKit, so it is only built for the
 * target.
 */

#ifndef MYL_INJECTOR_H
#define MYL_INJECTOR_H

#include <jsc/jsc.h>

#include "manifest.h"

/* Injects `script`'s CSS first and then its JS into `context`. Files are read
 * relative to `manifest->dir`. Failures are logged and skipped: one broken
 * file must not stop the remaining scripts from running.
 *
 * Every JS file is wrapped in a function taking one argument, `ctx`, which
 * carries this script's settings and nothing else — not the page's, not another
 * script's. That is why it is an argument and not a global: on a foreign page a
 * global would put the domain-block allowlist and the display-lock PIN within
 * reach of every script the page itself loads.
 *
 * `trusted` says whether this page's <meta> tags may configure anything. It is
 * passed to the prelude as its own argument rather than surfacing on `ctx`, so a
 * script cannot hand it on. The caller determines it with
 * myl_config_origin_trusted().
 *
 * "shadow_css" files are not injected. They arrive as ctx.css for the script to
 * put in a shadow root itself. */
void myl_inject(JSCContext *context, const MylManifest *manifest,
                const MylContentScript *script, bool trusted);

#endif /* MYL_INJECTOR_H */
