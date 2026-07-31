/*
 * config.h — the device's configuration, and who is allowed to override it.
 *
 * Until now scripts were configured entirely through <meta> tags in the
 * page. That covers one of a kiosk's two states. In the other one the user has
 * landed on a foreign page: no meta tags, therefore no configuration — and the
 * scripts that matter most there are exactly the ones that cannot be reached.
 * Worse, a foreign page could switch a script off by claiming
 * <meta name="myelin-disable" content="domain-block">, because nothing checked who
 * was asking.
 *
 * So configuration can now come from the device, and meta tags only count on an
 * origin the device trusts:
 *
 *   {
 *     "trusted_origins": ["http://localhost:4000"],
 *     "scripts": {
 *       "domain-block": { "allowlist": ["localhost:4000"] },
 *       "screensaver":  { "enabled": false, "idle": 300 }
 *     }
 *   }
 *
 * It arrives either in MYELIN_CONFIG — set by Myelin.browser_env/1
 * from the application's runtime.exs — or, for a kiosk with no application at
 * all, as a config.json in the search path. Exactly one source wins; there is no
 * merging of one device configuration into another.
 *
 * Per script the settings are kept as raw JSON text, like the manifest's own
 * "config": the contents are the script's business. What this file does with
 * them is merge the two, key by key, and decide whether a script runs at all.
 *
 * libc-only, so the whole decision — including the precedence between manifest,
 * device and meta tag — is unit testable without a WPE WebKit toolchain.
 */

#ifndef MYL_CONFIG_H
#define MYL_CONFIG_H

#include <stdbool.h>
#include <stddef.h>

#include "manifest.h"

typedef struct MylConfig MylConfig;

/* Parses a device configuration. NULL, empty, or malformed all yield a usable
 * empty configuration — malformed additionally warns. A typo in runtime.exs must
 * not take every script down with it. Never returns NULL except on OOM. */
MylConfig *myl_config_parse(const char *json);

/* For a kiosk without an application: reads config.json from the search path.
 * The last entry that *has* one wins outright, even if it turns out to be
 * malformed — otherwise a typo there would silently resurrect an earlier file.
 * Returns an empty configuration when no directory has one. */
MylConfig *myl_config_load_path(const char *const *search_path, size_t n_entries);

void myl_config_free(MylConfig *config);

/* Merges the device settings into every manifest's "config", key by key, with
 * the device winning, and replaces manifest->config with the result. Warns for
 * each script id in the configuration that no loaded script answers to — that
 * coupling is silent otherwise, and a typo means settings that arrive nowhere.
 *
 * Called once at startup, so nothing has to be merged per injection. */
void myl_config_apply(const MylConfig *config, MylManifestList *list);

/* True when `url`'s origin is listed in trusted_origins. Compares scheme, host
 * and port; an entry without a port demands that the URL has none either. An
 * empty list trusts nothing, which is the safe starting position: without an
 * entry, no meta tag has any effect anywhere. */
bool myl_config_origin_trusted(const MylConfig *config, const char *url);

/* Whether this script runs, given what the page says. `manifest->config` must
 * already be merged, i.e. myl_config_apply() has run.
 *
 * Precedence, least to most specific:
 *
 *   manifest "enabled"  ->  device "enabled"  ->  myelin-disable / myelin-enable
 *
 * `enable_meta` and `disable_meta` are the contents of those meta tags, space
 * separated, or NULL. They must be NULL on an untrusted origin — that is the
 * whole point, and the reason this takes the strings rather than reading the
 * document itself: the decision stays testable, and the caller cannot forget
 * the check by accident. Between the two, disable wins. */
bool myl_script_enabled(const MylManifest *manifest, const char *enable_meta,
                        const char *disable_meta);

#endif /* MYL_CONFIG_H */
