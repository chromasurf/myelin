# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
major version is 0, a minor bump is where a breaking change may appear.

## 0.1.1

- Published on hex.pm.
- Elixir requirement is now `~> 1.17`.

## 0.1.0

First release.

A WPE WebKit web process extension. Cog loads it via `--web-extensions-dir`; it
injects JS and CSS into every web session.

- Manifest: a WebExtension MV3 subset — `matches`, `exclude_matches`, `js`, `css`,
  `run_at`, `all_frames`, `enabled`, `config`, `shadow_css`. Match patterns take a
  port.
- Configuration in three layers: the script's default, `config :myelin`, then a
  `<meta name="myelin-…">` tag on a `trusted_origins` origin.
- A script is a plain file body. `ctx` gives `config`, `on`, `emit`, `css`.
- `ctx.emit` reaches the other scripts and the page's LiveView. `ctx.on` takes
  `myelin:*` and `phx:myelin:*`.
- Eight bundled scripts: `keyboard`, `screensaver`, `statusbar`, `navbar`,
  `offline-banner`, `domain-block`, `debug-overlay`, `tap-to-top`.
