# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
major version is 0, a minor bump is where a breaking change may appear.

## 0.2.0

Renamed from `cog_userscripts` to `myelin`. Nothing about how the library works
changed — this release is the rename and nothing else.

Three reasons for it. `cog` named the wrong thing: Cog is Igalia's browser, which
this library *uses*, and naming ourselves after it is like calling a Phoenix library
`beam_`. There were five spellings for one thing — `cog_args/0`, `config
:cog_userscripts`, `cus_*` in C, the `cog-userscripts` log domain, the `cog:` wire
prefix. And "userscript" described it wrongly: a userscript is written by the *user*
of someone else's page, while these ship with the firmware.

`myelin` is the sheath around a nerve fibre — a Nerves reference and a coating in one
word, and functionally right: myelin does not carry the signal, it wraps the line.
One word now covers the package, the module, the environment, the log domain, and the
wire protocol.

`Cog` still appears wherever it means Igalia's program — the `cog` binary,
`--web-extensions-dir`, the documentation.

### Migration

**This breaks consumer code in three places** that a rename inside this library
cannot reach: `handle_event("cog:" <> …)` clauses in your LiveViews, `<meta
name="cog-…">` tags in your templates, and `.cog-*` / `--cog-*` selectors in your CSS.

| Old | New |
|---|---|
| `{:cog_userscripts, …}` | `{:myelin, …}` |
| `config :cog_userscripts` | `config :myelin` |
| `CogUserscripts` | `Myelin` |
| `CogUserscripts.cog_args/0` | `Myelin.browser_args/0` |
| `CogUserscripts.cog_env/1` | `Myelin.browser_env/1` |
| `mix cog_userscripts.copy` | `mix myelin.copy` |
| `mix cog_userscripts.harness` | `mix myelin.harness` |
| `COG_USERSCRIPTS_PATH` / `_CONFIG` | `MYELIN_PATH` / `MYELIN_CONFIG` |
| `/data/cog-userscripts` | `/data/myelin` |
| `priv/userscripts` (copy target) | `priv/myelin` |
| `G_MESSAGES_DEBUG=cog-userscripts` | `G_MESSAGES_DEBUG=myelin` |
| `handle_event("cog:" <> event, …)` | `handle_event("myelin:" <> event, …)` |
| `push_event(socket, "cog:…")` | `push_event(socket, "myelin:…")` |
| `<meta name="cog-…">` | `<meta name="myelin-…">` |
| `.cog-*`, `#cog-*`, `--cog-*` | `.myelin-*`, `#myelin-*`, `--myelin-*` |
| `--osk-*` | `--myelin-osk-*` |
| `window.cogUserscripts` | `window.myelin` |
| `window.cogOsk` | `window.myelin.osk` |
| `cog-userscript:///<id>/<file>` | `myelin:///<id>/<file>` |
| Tailwind `prefix(cog)` / `prefix: "cog-"` | `prefix(myelin)` / `prefix: "myelin-"` |

For a copied script, the mechanical part is one pass over your own files:

```bash
grep -rl 'cog[-:_]' lib assets priv | xargs perl -pi -e '
  s/cog_userscripts/myelin/g;
  s/CogUserscripts/Myelin/g;
  s/phx:cog:/phx:myelin:/g;
  s/cog:/myelin:/g;
  s/--osk-/--myelin-osk-/g;
  s/cog-/myelin-/g;
'
```

Then rename `cog_args`/`cog_env` to `browser_args`/`browser_env` by hand, and move
`priv/userscripts` to `priv/myelin` if you copied a script.

### Also in this release

- `window.cogOsk` became `window.myelin.osk`. The keyboard no longer creates a second
  global; it hangs off the one the prelude already makes.
- The keyboard's custom properties were the one set without a prefix (`--osk-*`) and
  now match everything else (`--myelin-osk-*`).
- Internal C naming caught up with the surface: the injector's `cog` value and
  `build_cog()` are `ctx` and `build_ctx()`, matching the `ctx` the script has
  actually received for some time.
- `mix.exs` pointed ExDoc at `Mix.Tasks.CogUserscripts.Install`, which does not
  exist; it now names the two tasks that do.
- The README's TypeScript declaration described a `ctx.script({…})` surface that was
  removed before 0.1.0. It now declares `config`, `on`, `emit` and `css`.

## 0.1.0

First release, as `cog_userscripts`. Names in this entry are the ones 0.1.0 shipped
with; see the migration table above.

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
