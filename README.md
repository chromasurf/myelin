# myelin

The kiosk UI layer for Nerves. Loads scripts (JS + CSS) into every web session of
the [Cog](https://github.com/Igalia/cog) kiosk browser.

It ships as a WPE WebKit **web process extension**: a small `.so` that Cog loads via `--web-extensions-dir`.

> [Myelin](https://en.wikipedia.org/wiki/Myelin) is the sheath around a nerve fibre and increases the rate at which electrical impulses pass along.

## This is not a Chrome extension

The manifest format is very loosely modelled after the WebExtension MV3 manifest. WebKit contains the Safari-style WebExtension machinery in its source tree but exposes no GLib bindings for it — those are Cocoa-only. So there is no `chrome.*`, no `browser.*`, no background page, no permissions model.

This is an injected `<script>` tag in the page.


## Installation

```elixir
# mix.exs
{:myelin, github: "chromasurf/myelin", tag: "v0.1.0"}
```

Now add the supplied `Myelin.browser_args/0` and `Myelin.browser_env/1` to the cog startup.

```elixir
args = ["--platform=drm", url] ++ Myelin.browser_args()
env = [{"XDG_RUNTIME_DIR", runtime_dir}] ++ Myelin.browser_env()

MuonTrap.Daemon.start_link("cog", args, env: env)
```

Then switch on what you want:

```elixir
# config/runtime.exs
config :myelin,
  scripts: %{
    "keyboard" => %{enabled: true},
    "screensaver" => %{enabled: true}
  }
```

Done. Neither the bundled scripts nor your own are enabled by default: a kiosk that
configures nothing gets no scripts.

_On the Nerves host the native build is skipped and `browser_args/0` returns `[]`._

## Where scripts come from

`MYELIN_PATH` is a colon-separated list of directories. Each subdirectory containing a `manifest.json` is one script, identified by
its directory name — **that name is the script id**, and everything else refers to it by that.

| Directory | What it is |
|---|---|
| `priv/scripts` inside this library | the ones that come with the library. On the search path automatically. |
| `priv/myelin` of your application | what you wrote, and what you copied to change |
| custom like `/data/myelin` | for iterating on a device without a firmware build |

**Later entries win.** A directory with the same name further right replaces the
earlier one entirely, which is what makes copying work: your copy of `keyboard`
shadows the one that ships.

```elixir
config :myelin, extra_dirs: ["/data/myelin"]
```

### The scripts

| Script | What it does |
|---|---|
| `keyboard` | Touch keyboard, US ANSI or German. Two symbol levels, caps lock, numeric keypad, light/dark. |
| `screensaver` | Bouncing Nerves logo, optional clock. |
| `statusbar` | Fixed strip at the top: clock, URL, connection. |
| `navbar` | Back, forward, home, reload, address. Claims the top edge, as `statusbar` does — run one. |
| `offline-banner` | Banner while the connection is down. Optional probe URL. |
| `domain-block` | Covers a page that is not on the allowlist. **Not a network filter** — see below. |
| `debug-overlay` | URL, viewport, FPS, JS heap, loaded scripts, last JS errors. Three taps bottom-left. |
| `tap-to-top` | Tap the top edge, the page springs back up. |

`ideas/` holds four more that **do not ship**.

### Copying one to change it

You do not need to copy anything to *run* it. Copy when you want to **edit**:

```bash
mix myelin.copy              # lists the scripts
mix myelin.copy keyboard     # copy into priv/myelin
```

A copied script is yours: it will not be touched by an upgrade, and it replaces the
bundled version because its directory sits later on the search path. It still has to
be switched on.

### Iterating on a device

Changing a script does not need a firmware build if the writable partition is on the
search path. Nerves devices expose an SSH subsystem for file transfer:

```bash
scp -O priv/myelin/keyboard/keyboard.js \
    nerves.local:/data/myelin/keyboard/keyboard.js
```

Create the directory first over an IEx session if it is not there
(`File.mkdir_p!/1`), then restart Cog so the web process re-reads the manifests.

## Configuration

Device-wide, in your application's config. This is the layer that always applies:

```elixir
# config/runtime.exs, or config/target.exs in a Nerves project
config :myelin,
  trusted_origins: ["http://localhost:4000"],
  scripts: %{
    "keyboard" => %{enabled: true, layout: "de"},
    "screensaver" => %{enabled: true, idle: 300},
    "statusbar" => %{enabled: true, items: ["clock", "url"]}
  }
```

The keys under `scripts` are directory names.

**If you control the page being shown**, you can also configure per page, with meta tags:

```html
<meta name="myelin-screensaver-idle" content="30">
<meta name="myelin-keyboard-layout" content="de">
<meta name="myelin-enable" content="statusbar">
<meta name="myelin-disable" content="keyboard">
```

A tag is only read if the page's origin appears in `trusted_origins`, which starts
empty. Anywhere else the device configuration is the whole story — so a kiosk that
wanders onto a page you do not control cannot be reconfigured by it.

### Where a setting comes from

Three places, least specific first, each overriding the one before it key by key:

1. The default in the script
2. Your `config :myelin`
3. A meta tag on the page


## Writing a script

There is not much of a format. A script is a plain `.js` file, and the file body is the script — the myelin loader already wraps it in a function of its own, so a top-level `var` belongs to your script and cannot collide with another's.

`ctx` is a script 'global' with helpers to read the configuration at runtime and to
emit and subscribe to JavaScript and LiveView events — though a plain
`addEventListener` works just as well.

For example:

```js
/*
 * Configuration
 *   idle    seconds without input before it shows      120
 *   mode    logo | clock | both                        both
 *
 * Events
 *   emits    screensaver:show, screensaver:hide
 *   listens  screensaver:show, screensaver:hide
 */

var IDLE_MS = ctx.config("idle", 120) * 1000;
var MODE = ctx.config("mode", "both");

var overlay = document.createElement("div");
overlay.id = "myelin-screensaver";
overlay.style.background = ctx.config("bg", "#000");
document.body.appendChild(overlay);

function show() {
  overlay.classList.add("is-visible");
  ctx.emit("screensaver:show");
}

ctx.on("screensaver:show", show);
```

| | |
|---|---|
| `ctx.config(name, default)` | a setting — see below |
| `ctx.on(name, handler)` | listen for `myelin:<name>` **and** `phx:myelin:<name>`, so it does not matter whether another script or your application sent it |
| `ctx.emit(name, detail)` | dispatch `myelin:<name>` on `window`, and push it to a LiveView if the page has one |
| `ctx.css` | the text of the manifest's `shadow_css` files, for a script that builds its own shadow root |

A script runs once per page load and nothing ever removes it again. By then the DOM is parsed, though images may still be loading — if you need `load`, listen for it yourself, the same goes for LiveView pages updates.

### `ctx.config` and the default you pass

The default is the value you fall back to, and it also **decides how the value is
read.** A meta tag can only ever carry a string, while the device configuration
carries real numbers, booleans and lists, so `%{numbers: true}` and `content="1"`
have to mean the same thing.

| Default | What arrives |
|---|---|
| `120` | a number; unreadable values fall back rather than becoming `NaN` |
| `false` | a boolean; `true`, `"1"` and `"true"` all count |
| `["clock"]` | an array; a string is split on whitespace and commas |
| `"auto"` | a string, so a configured number still compares as one |


### Scripts can talk to each other

`ctx.emit` and `ctx.on` are ordinary `CustomEvent`s on `window`.

For example `offline-banner` listens for `statusbar:ready` to sit below the bar rather than under it; `statusbar` listens for `screensaver:show` to dim itself.

You pass the bare name — `emit("screensaver:show")` and emit adds a `myelin:` namespace prefix, because `window` belongs to the page, and a kiosk overlay UI must not collide with the page's events.

### Talking to a LiveView

Both directions work without writing a hook, and the event name is the same one in both — `myelin:` plus what the script called it.

**Scripts → application.** `ctx.emit` announces to the other scripts *and* pushes to the LiveView, over the client's public `liveSocket.js().push`. It needs an element belonging to the view — `[data-phx-main]`, which every LiveView page has — so it needs LiveView 1.1 or newer. On a page with no LiveView it is a no-op. There is no reply: if you need `{:reply, …}`, use a real hook.

**Application → scripts.** `push_event` arrives as a `window` event named `phx:` plus the name you sent, and `ctx.on` listens for that alongside the plain one.

```elixir
def handle_event("myelin:screensaver:show", _params, socket) do
  File.write("/sys/class/backlight/10-0045/brightness", "0")
  {:noreply, socket}
end

def handle_event("myelin:" <> _event, _params, socket) do
  # statusbar:ready, navbar:ready, and whatever a script announces next
  {:noreply, socket}
end

# and to drive one from Elixir
{:noreply, push_event(socket, "myelin:screensaver:hide", %{})}
```

_Now your kiosk can dim the panel when the screensaver comes on._


## What surrounds a script

Each script is wrapped in its own function and called with `ctx`:

```js
(function (ctx) {"use strict"; /* your file */ })(prelude("keyboard", true, {…}, ""))
```

This way top-level `var`s belong to the script and two scripts cannot
collide.


## Shadow roots

If your script draws something on pages you do not control, it's best to put it in a shadow root; the page's CSS then cannot change it, and yours cannot reach the page either.

List the stylesheet under `shadow_css` instead of `css` in the manifest, and it
arrives as text on `ctx.css` rather than being injected — attaching it to the shadow
root is then up to your script.

```json
{ "shadow_css": ["display-lock.css"] }
```

```js
var host = document.createElement("div");
host.id = "myelin-lock";

var root = host.attachShadow({ mode: "open" });

var style = document.createElement("style");
style.textContent = ctx.css;
root.appendChild(style);

document.body.appendChild(host);
```


## Manifest format

```json
{
  "manifest_version": 3,
  "name": "Onscreen Keyboard",
  "version": "1.0",
  "description": "Touch keyboard for text fields",
  "content_scripts": [
    {
      "matches": ["http://localhost:4000/*"],
      "exclude_matches": ["*://*/admin/*"],
      "js": ["keyboard.js"],
      "css": ["keyboard.css"],
      "shadow_css": [],
      "run_at": "document_end",
      "all_frames": false
    }
  ]
}
```

| Key | Notes |
|---|---|
| `matches` | Chrome match patterns, plus `<all_urls>`. Required — without one the script never runs. |
| `exclude_matches` | Wins over `matches`. |
| `js` / `css` | File names relative to the manifest directory. A subdirectory is allowed; `..` is not. |
| `shadow_css` | Stylesheets the script receives as text instead of having them injected — see *Shadow roots*. |
| `run_at` | When the script runs — see below. Default `document_end`. |
| `all_frames` | Only meaningful for `document_start` — see limitations. |
| `enabled` | Defaults to `false`: nothing runs until it is asked for. |
| `config` | Default settings. A script passes its own defaults to `ctx.config`, so none of the shipped ones use this. |

### `run_at`

| Value | When it runs | Use it for |
|---|---|---|
| `document_start` | Before the page is parsed. Fires once per frame, as soon as the JS context exists. | Overriding something before page scripts see it. There is no DOM yet: no `document.body`, and usually no `<meta>` tags either. |
| `document_end` | Once the DOM is parsed — images may still be loading. **Default.** | Almost everything. All the shipped scripts use it. |
| `document_idle` | One event-loop turn after `document_end`. | Work heavy enough that you would rather not delay the page becoming usable. |


**Meta tags need `document_end` or later.** At `document_start` the `<head>` is typically not parsed yet, so neither a script nor the loader can read the page's configuration.


### Match patterns

Standard Chrome syntax — `<scheme>://<host><path>`, `*` as scheme means http or
https, a leading `*.` in the host also matches the bare domain. A port is allowed.

## Notes on individual scripts

### `domain-block` is not a network filter

At `document_end` the page has already loaded: its requests went out, its scripts
ran, its trackers fired. What `domain-block` does is stop someone at the terminal
from *using* it. For real blocking, Cog takes `--content-filter` with a
`WebKitUserContentFilter` rule set, which refuses the requests in the first place.

### A page with its own onscreen keyboard

A kiosk shows two kinds of page: your application, which may have its own onscreen input handling, and whatever else it is pointed at, which has none. Two conflicting keyboards are not ideal, so the keyboard can be told to stand aside.

```elixir
scripts: %{
  "keyboard" => %{
    enabled: true,
    skip: [~S"^localhost$", ~S"^\d{1,3}(\.\d{1,3}){3}$", ~S"^\["]
  }
}
```

### Using a different keyboard


If you need a more full featured keyboard, swap in a library such as
[simple-keyboard](https://github.com/hodgef/simple-keyboard) and write the input layer yourself.


## Building scripts with the asset pipeline

There is more than one way to write a script.

**1. By hand.** Just one `.js`, one `.css`. No precompiler.

**2. esbuild**, for modern JS or TypeScript:

```elixir
# config/config.exs
config :esbuild,
  myelin: [
    args: ~w(
      js/myelin/branding.js --bundle --format=iife --target=es2020
      --outfile=../priv/myelin/branding/build/branding.js
    ),
    cd: Path.expand("../assets", __DIR__),
    env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}
  ]
```

```json
{ "js": ["build/branding.js"] }
```

- **`--format=iife`**, and no `--global-name`. Each file is evaluated as a plain
  script, so top-level `import`/`export` will not work, and `--global-name` would
  write to `window`.
- **Output into `build/`**, gitignored, with the hand-written `manifest.json` beside
  it. A manifest may name a subdirectory; it may not leave the script's own
  directory.
- **`--sourcemap=inline` while developing**, off for the release: the map is base64
  and gets injected with every page load. External maps cannot work at all — the
  script never goes over HTTP.
- `ctx` is a wrapper parameter, not a global, so esbuild leaves the free reference
  alone. For TypeScript:

  ```ts
  declare const ctx: {
    config<T>(name: string, fallback: T): T
    on(name: string, handler: (event: CustomEvent) => void): void
    emit(name: string, detail?: unknown): boolean
    css: string
  }
  ```

**3. Tailwind.** Because the CSS is injected into someone else's page, you'll have to add a new layer.

```css
@layer theme, utilities;
@import "tailwindcss/theme.css" layer(theme) prefix(myelin);
@import "tailwindcss/utilities.css" layer(utilities) prefix(myelin) source(none);

@source "../js/myelin/**/*.{js,ts}";
```

- **No preflight.** The reset (`*, ::before, ::after { box-sizing: border-box; margin:
  0 }`, heading sizes, `img { display: block }`) would land on `apple.com` as readily
  as on your own app. So `theme` and `utilities` are imported by themselves and
  `preflight.css` is left out; never the collected `tailwindcss`. v3:
  `corePlugins: { preflight: false }`.
- **A prefix.** `.flex`, `.p-4` and `.fixed` collide in both directions with whatever
  the visited page defines.
- **`source(none)`, on v4.** Automatic content detection scans the whole project, and `@source` *adds* to that rather than replacing it — so without this every class from your Phoenix pages is bundled into the stylesheet injected on every page. Point the `@source` glob at the script sources
  (`assets/js/myelin/**/*.{js,ts}`), not at the esbuild output.

Tailwind and esbuild are independent; the order does not matter as long as the glob
sees the source.


## Debugging

Set `G_MESSAGES_DEBUG=myelin` in Cog's environment. The extension then logs
where its configuration came from, which manifests it found, which were overridden,
and every injection:

```
myelin-DEBUG: configuration from MYELIN_CONFIG
myelin-DEBUG: loaded "Onscreen Keyboard" (keyboard) with 1 content script(s) from …
myelin-DEBUG: keyboard: injected keyboard.css
myelin-DEBUG: keyboard: injected keyboard.js
```

No output at all means the `.so` was not loaded — check that `--web-extensions-dir` points at a directory containing it.

JavaScript exceptions are reported as warnings with a `myelin:///<id>/<file>`
source URI, which is also what shows up in the remote inspector's Sources panel. A script that throws while setting up is caught and logged with its id, rather than silently abandoning the rest of its file.

Watching a device is easiest through Cog's remote inspector: start it with
`WEBKIT_INSPECTOR_HTTP_SERVER=0.0.0.0:9222` and open `http://<device>:9222` from a desktop browser.

If nothing appears at all, put a minimal script in place first — a manifest matching `<all_urls>` plus a one-line `document.body.append(…)`. If that shows up, the loader is fine and the problem is in your script.

## Development

```bash
make check                        # host unit tests — no toolchain needed
make -C test/c syntax             # compile the WebKit-facing code (needs GLib)
mix test                          # Elixir side
MIX_TARGET=<target> mix compile   # cross-compiles priv/webext/libmyelin.so
```

### Trying the scripts

#### without a device

```bash
mix myelin.harness
open http://127.0.0.1:8899/test/harness.html
```

#### On a reTerminal DM

[Myelin Demo](https://github.com/chromasurf/myelin_demo)

## License

MIT. Vendored: [jsmn](https://github.com/zserge/jsmn) (MIT) in `c_src/vendor/jsmn.h`.

The one script that bundles a font vendors a subset of it, SIL OFL 1.1, with the license beside it:

- [IBM Plex Mono](https://github.com/IBM/plex) in `priv/scripts/navbar/` —
  `font/OFL-IBMPlexMono.txt`

`screensaver` inlines the Nerves logo from
[nerves-project.org](https://nerves-project.org).
