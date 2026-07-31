# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
major version is 0, a minor bump is where a breaking change may appear.

## 0.1.0

First release.

- A WPE WebKit web process extension that injects userscripts (JS + CSS) into every
  web session of the Cog kiosk browser, loaded via `--web-extensions-dir`. No patched
  Cog and no forked Nerves system.
- Manifests modelled on WebExtension MV3: `matches`, `exclude_matches`, `js`, `css`,
  `run_at`, `all_frames`, plus `enabled`, `config` and `shadow_css`. Match patterns
  accept a port, which Chrome refuses and a kiosk needs.
- Configuration in three layers, least specific first: the default the script passes,
  the device configuration from `config :cog_userscripts`, and — only on an origin
  listed in `trusted_origins` — a `<meta name="cog-…">` tag on the page.
- Userscripts are plain JavaScript with no format to learn: the file body is the
  script, and `ctx` offers `config`, `on`, `emit` and `css`. The type of the default
  passed to `ctx.config` decides how a value is read, so a meta tag's `"1"` and a
  device configuration's `true` mean the same thing without every script solving it
  again.
- Both directions to a LiveView without a hook or a bridge: `ctx.emit` announces to
  the other scripts and pushes to the view over the public `liveSocket.js().push`, and
  `ctx.on` listens for `phx:cog:*` alongside `cog:*`. The same `cog:`-prefixed name in
  both directions, so an application can route the whole layer through
  `handle_event("cog:" <> event, …)`.
- Eight scripts ship, dormant, on the search path: `keyboard` and `screensaver` as
  stable, and `kiosk-guard`, `statusbar`, `navbar`, `offline-banner`, `domain-block`
  and `debug-overlay` as beta. Switching one on is a line of configuration; copying is
  only for changing one.
- `ideas/` holds five more that do not ship and are not loadable.
- Zero runtime dependencies. The device configuration is encoded with OTP 27's
  `:json`, which is also the version floor and is checked at compile time.
