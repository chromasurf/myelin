# myelin

[![CI](https://github.com/chromasurf/myelin/actions/workflows/ci.yml/badge.svg)](https://github.com/chromasurf/myelin/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

The kiosk UI layer for Nerves. Loads scripts (JS + CSS) into every web session of
the [Cog](https://github.com/Igalia/cog) kiosk browser, so that kiosk-wide
features — an onscreen keyboard, a screensaver — can be written once instead of
being built into every application.

It ships as a WPE WebKit **web process extension**: a small `.so` that Cog loads via
`--web-extensions-dir`. No patched Cog, no forked Nerves system.

*Myelin is the sheath around a nerve fibre: it does not carry the signal, it wraps
the line and makes it fast and reliable. That is this library's relationship to your
application — it sits between the glass and the web page and adds nothing the page
has to know about.*

Verified against Cog 0.18.5 / WPE WebKit 2.50.5 (`nerves_system_br` 1.34.0), which
is what the official [Nerves Web Kiosk](https://github.com/nerves-web-kiosk) systems
currently build.

## This is not a Chrome extension

The manifest format is modelled on a WebExtension MV3 manifest because that is a
format people already know. **The APIs behind it do not exist here.** WPE WebKit
contains the Safari-style WebExtension machinery in its source tree but exposes no
GLib bindings for it — those are Cocoa-only. So there is no `chrome.*`, no
`browser.*`, no background page, no permissions model.

What you get is what a `<script>` tag in the page would give you, injected reliably
into every session, plus URL matching, a defined run time, and configuration that
can come from the device rather than the page.

## Installation

```elixir
# mix.exs
{:myelin, github: "chromasurf/myelin", tag: "v0.2.0"}
```

Needs OTP 27 or newer: the device configuration is encoded with `:json`, which keeps
this library free of a JSON dependency. The floor is checked at compile time rather
than left to fail inside a firmware image.

Merge two things into however you already start Cog — `browser_args/0` for the command
line, `browser_env/1` for the environment:

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

That is the whole install. The scripts ship inside the library, in
`Myelin.bundled_dir/0`, and that directory is on the search path already —
but **every one of them is dormant until you set `enabled: true`**. No bundled
manifest carries an `enabled` key, and a manifest without one is off, so the
device configuration is what switches a script on. Settings alone do not: a
script named under `scripts` without `enabled: true` is configured and never
runs. A kiosk that configures nothing gets no scripts.

On `MIX_TARGET=host` the native build is skipped and `browser_args/0` returns `[]`, so a
host build stays green.

## Where scripts come from

`MYELIN_PATH` is a colon-separated list of directories, scanned left to
right. Each subdirectory containing a `manifest.json` is one script, identified by
its directory name — **that name is the script id**, and everything else refers to it
by that.

| Directory | What it is |
|---|---|
| `priv/scripts` inside this library | the eight that ship. On the search path automatically. |
| `priv/myelin` of your application | what you wrote, and what you copied to change |
| `/data/myelin` | for iterating on a device without a firmware build |

**Later entries win.** A directory with the same name further right replaces the
earlier one entirely, which is what makes copying work: your copy of `keyboard`
shadows the one that ships.

```elixir
config :myelin, extra_dirs: ["/data/myelin"]

Myelin.browser_env(extra: [Application.app_dir(:my_app, "priv/myelin")])
```

`:my_app` there is your own application's OTP name — the `:app` in your `mix.exs`.

### The eight that ship

Two are stable. The other six work and are maintained, but their shape may still
change, so they say **Beta** in their own header.

| Script | | What it does |
|---|---|---|
| `keyboard` | stable | Touch keyboard in two variants: the **physical** US ANSI (default) and German T1 letter layouts — punctuation on the letter block, real Shift pairs, `ß` — or a keypad when the field is numeric. Optional number row, two symbol levels, caps lock, light/dark, key sizes from the viewport. No caret keys. Writes through the native value setter so LiveView sees the change. |
| `screensaver` | stable | After a while without input, the Nerves logo drifts across a dark screen and bounces off the edges. Optional clock. Any input wakes it, and the tap that wakes it is swallowed whole — both the `pointerdown` and the `click` after it, or waking on top of a link would follow the link. |
| `kiosk-guard` | beta | Removes the affordances that only cause trouble on a wall panel: context menu, selection, drag and drop, pinch zoom, and the cursor when nobody moves it. Text fields stay selectable. |
| `statusbar` | beta | A fixed strip across the top: clock, URL, connection state. No network, no assets, so it works on any page. |
| `navbar` | beta | A browser bar for a kiosk: home, reload, address. Claims the top edge, as `statusbar` does — run one. |
| `offline-banner` | beta | Says so when the connection drops. `navigator.onLine` only reports whether a link exists, so an optional probe URL answers the real question. |
| `domain-block` | beta | Covers a page that is not on an allowlist, with a way back. **Not a network filter** — see below. |
| `debug-overlay` | beta | URL, viewport, FPS, JS heap, which scripts ran, and the last few JS errors. Three taps top-right. That last part is why it exists: an exception in a script is otherwise invisible. |

`ideas/` holds five more that **do not ship** — a PIN lock, a LiveView status bar, a
confetti gesture and two others. They are there to be read and reworked; see
[ideas/README.md](ideas/README.md).

### Copying one to change it

You do not need to copy anything to *run* it. Copy when you want to **edit**:

```bash
mix myelin.copy              # what there is, and how to switch it on
mix myelin.copy keyboard     # into priv/myelin
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

**If you control the page being shown**, you can also configure per page, with meta
tags:

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

1. **The default in the script**, which is the script author's answer.
2. **Your `config :myelin`**, which is the answer for this fleet of
   terminals — and the one that holds whatever page the kiosk ends up on.
3. **A meta tag on the page**, on a trusted origin only, which is the answer for
   this page.

So a script whose default is `120`, on a device that says `%{idle: 300}`, on a
trusted page carrying `<meta name="myelin-screensaver-idle" content="30">`, gets 30.

## Writing a script

There is not much of a format. A script is a plain `.js` file, and the file body
is the script — the loader already wraps it in a function of its own, so a top-level
`var` belongs to your script and cannot collide with another's.

`ctx` is what the loader hands in: three functions and one value.

```js
/*
 * Screensaver — after a while without input, the Nerves logo drifts across a dark
 * screen and bounces off the edges.
 *
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

Everything else is the DOM, and all of it works — `addEventListener`,
`querySelector`, `createElement`, `attachShadow`, `fetch`, `setTimeout`. A script
runs in the page's own JavaScript world, so there is no shim and no wrapper around any
of it.

There is also no lifecycle to implement and nothing to register. A script runs once
per page load and nothing ever removes it again. By then the DOM is parsed, though
images may still be loading — if you need `load`, listen for it yourself.

### `ctx.config` and the default you pass

The default is not only a fallback — **its type decides how the value is read.** A
meta tag can only ever carry a string, while the device configuration carries real
numbers, booleans and lists, so `%{numbers: true}` and `content="1"` have to mean the
same thing. This is where that happens, once, instead of in every script:

| Default | What arrives |
|---|---|
| `120` | a number; unreadable values fall back rather than becoming `NaN` |
| `false` | a boolean; `true`, `"1"` and `"true"` all count |
| `["clock"]` | an array; a string is split on whitespace and commas |
| `"auto"` | a string, so a configured number still compares as one |

Two tag names are tried, this script's own and then the bare one. So
`<meta name="myelin-theme" content="dark">` reaches every script that asks for `theme`,
while `myelin-keyboard-theme` overrides it for the keyboard alone.

Write a list as a list. As a bare string it is split on commas, which is right for
`items` and wrong for a regular expression — `keyboard`'s `skip` says so where it
reads it.


### Scripts can talk to each other

`ctx.emit` and `ctx.on` are ordinary `CustomEvent`s on `window`. `offline-banner`
listens for `statusbar:ready` to sit below the bar rather than under it; `statusbar`
listens for `screensaver:show` to dim itself.

You pass the bare name — `emit("screensaver:show")` — and everything on the wire
carries a `myelin:` prefix. That is there for one reason: `window` belongs to the page,
and a kiosk visits pages nobody here controls, so a bare `screensaver:show` could
collide with an event of the page's own.

An event carries no trust check. A page can dispatch one, and that is deliberate:
being *told* to show the screensaver is not the same as being configured.

### Talking to a LiveView

Both directions work without writing a hook, and the event name is the same one in
both — `myelin:` plus what the script called it.

**Scripts → application.** `ctx.emit` announces to the other scripts *and* pushes to
the LiveView, over the client's public `liveSocket.js().push`. It needs an element
belonging to the view — `[data-phx-main]`, which every LiveView page has — so it needs
LiveView 1.1 or newer. On a page with no LiveView it is a no-op. There is no reply: if
you need `{:reply, …}`, use a real hook.

**Application → scripts.** `push_event` arrives as a `window` event named `phx:` plus
the name you sent, and `ctx.on` listens for that alongside the plain one.

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

Which is the whole answer to "dim the panel when the screensaver comes on": the
screensaver dims the DOM, and the firmware dims the backlight, because
`/sys/class/backlight` is not something a script can reach.

> #### Your LiveViews need a clause for the whole layer {: .warning}
>
> A script announces what it does without knowing who is listening, so a LiveView on a
> page where a script runs will be sent events it may not care about — `statusbar`
> announces its height, `navbar` announces itself. An unmatched `handle_event/3` is a
> `FunctionClauseError` in the view process, not an ignored message, so the view would
> go down.
>
> The shared prefix is what keeps that from meaning a blanket catch-all:
> `handle_event("myelin:" <> _event, …)` as the last of your `myelin:` clauses swallows
> script events without also swallowing a typo in one of your own.

## What surrounds a script

Each script is wrapped in its own function and called with `ctx`:

```js
(function (ctx) {"use strict"; /* your file */ })(prelude("keyboard", true, {…}, ""))
```

That buys two things. Top-level `var`s belong to the script, so two scripts cannot
collide. And nothing hands `ctx` out, so the page cannot read another script's
settings — which matters for a `domain-block` allowlist.

**It is scoping, not a sandbox, and the difference is worth being clear about.**
Scripts run in the page's own JavaScript world: same `window`, same `document`, same
intrinsics. A page that replaced `JSON.parse` is in the path. Injected CSS is a
`<style>` in the page's DOM, which the page can read or remove. Nothing here is
secret from the page it runs on.

The boundary that does hold is a different one: **whether an origin is trusted is
decided in C, outside the page, and baked into the evaluated source as a literal.**
A page cannot claim trust it was not given, so it cannot switch a script off with
`myelin-disable`, and it cannot configure one with a meta tag. That property has its own
test.

## Shadow roots

If your script draws something on pages you do not control, put it in a shadow root.
The page's CSS then cannot reshape it, and yours cannot reach the page either.

List the stylesheet under `shadow_css` instead of `css` in the manifest. Those files
are **not** injected — a `<style>` in the page's `<head>` does not reach inside a
shadow root at all — so they arrive as text in `ctx.css` and the script puts them
where they belong:

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

**One trap, and it costs an afternoon if you meet it unprepared.** A rule in the page
beats a plain `:host` rule of yours, however specific yours is — so a page's
`div { opacity: 0.8 }` can dim your overlay, and a block page a stylesheet can dim is
not a block page. Two things follow:

- Mark the structural properties `!important` on the host: `position`, `inset`,
  `z-index`, `display`, `background`, `opacity`, `visibility`, `transform`,
  `pointer-events`.
- Put inherited properties — font, colour, line-height — on an element *inside* the
  root. On the host they are computed in the page's tree and inherit through the
  boundary whatever you do.

Why the cascade behaves that way, and what was measured on a real panel, is written up
in `priv/scripts/domain-block/domain-block.css`, above the rules it explains.

`@font-face` has to be in the outer document, so a script with a shadow root needs a
second stylesheet under `css` for it.

Of the eight that ship, only `domain-block` uses a shadow root. The keyboard
deliberately does not: it lives in the page, so a page can recolour it through the
`--myelin-osk-*` custom properties and drive it through `window.myelin.osk`. The cost is that a
page's CSS can interfere with it.


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
| `enabled` | Ours, not MV3. Defaults to `false`: nothing runs until it is asked for. |
| `config` | Ours, not MV3. Default settings. A script passes its own defaults to `ctx.config`, so none of the shipped ones use this. |

Unsupported keys (`background`, `permissions`, `action`, `world`, …) are logged once
and ignored, so a manifest copied from a real extension still loads what it can.

**Both of ours are defaults you can override from Elixir**, per script id, without
touching the file:

```elixir
config :myelin,
  scripts: %{"statusbar" => %{enabled: true, items: ["clock", "url"]}}
```

Which is the point of a manifest holding only what the script *is* — its files, where
it runs — while what it should *do* on your terminals stays in your config.

### `run_at`

| Value | When it runs | Use it for |
|---|---|---|
| `document_start` | Before the page is parsed. Fires once per frame, as soon as the JS context exists. | Overriding something before page scripts see it. There is no DOM yet: no `document.body`, and usually no `<meta>` tags either. |
| `document_end` | Once the DOM is parsed — images may still be loading. **Default.** | Almost everything. All the shipped scripts use it. |
| `document_idle` | One event-loop turn after `document_end`. | Work heavy enough that you would rather not delay the page becoming usable. |

Two practical notes:

- **Meta tags need `document_end` or later.** At `document_start` the `<head>` is
  typically not parsed yet, so neither a script nor the loader can read the page's
  configuration.
- **`document_idle` differs from Chrome's.** Chrome also waits for `window.onload`;
  here it is only a low-priority idle callback queued after `document_end`, so it runs
  a moment later, not after images finish. If you need `load`, listen for it yourself.

### Match patterns

Standard Chrome syntax — `<scheme>://<host><path>`, `*` as scheme means http or
https, a leading `*.` in the host also matches the bare domain.

**One deliberate deviation:** a port is allowed. Chrome rejects
`http://localhost:4000/*` outright, but that is exactly the kiosk case, so it works
here. A pattern with a port demands that port; a pattern without one matches any.

## Notes on individual scripts

### `domain-block` is not a network filter

At `document_end` the page has already loaded: its requests went out, its scripts
ran, its trackers fired. What `domain-block` does is stop someone at the terminal
from *using* it. For real blocking, Cog takes `--content-filter` with a
`WebKitUserContentFilter` rule set, which refuses the requests in the first place.

### A page with its own keyboard

A kiosk shows two kinds of page: your application, which may have its own input
handling, and whatever else it is pointed at, which has none. Two keyboards over one
field is worse than none, so the keyboard can be told to stand aside — from the
device, which is where that knowledge lives:

```elixir
scripts: %{
  "keyboard" => %{
    enabled: true,
    skip: [~S"^localhost$", ~S"^\d{1,3}(\.\d{1,3}){3}$", ~S"^\["]
  }
}
```

Those are regular expressions tested against `location.hostname`, and anchors are
yours to write: `localhost` without them also matches `notlocalhost.com`. A pattern
that does not compile is dropped with a warning rather than thrown.

### Using a different keyboard

`keyboard` covers kiosk day-to-day: the physical US ANSI and German T1 layouts with
their punctuation and Shift pairs, `ß`, two symbol levels, an optional number row,
caps lock, a keypad for numeric fields, light and dark. It is not a full onscreen
keyboard — no IME, no prediction, no accessibility work, one language pair, and no
caret keys.

**Why the physical layouts and not a phone's.** A phone reaches `;` `<` `?` and `ß`
through a long press, and there is no long press on a kiosk panel — no gestures, no
second level for letters, one tap is all there is. Putting those characters behind
`?123` means hunting two levels down for a semicolon.

If you need more, swap in a library such as
[simple-keyboard](https://github.com/hodgef/simple-keyboard) and write the input
layer yourself. What any keyboard library leaves you: writing through the native value
setter so frameworks notice, focus tracking across shadow roots, deciding which
fields get a keypad, keeping focus while a key is pressed, and not covering the field
you are typing into.

Under the `:weston` backend, `weston.ini` may also enable `weston-keyboard`
(`[input-method]` / `overlay-keyboard=true`). Turn that off, or two keyboards appear.
Under `:cog_drm` there is no compositor and this is the only option.

## Building scripts with the asset pipeline

Three ways to write one, and the first stays the recommendation.

**1. By hand.** Like all thirteen in this repository: one `.js`, one `.css`, no build,
no content glob, nothing that can fail on a foreign `https` page. For anything under
a few hundred lines this is the shorter route, not the cruder one.

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

**3. Tailwind.** Two settings are not optional here, because the CSS is injected into
someone else's page:

- **No preflight.** The reset (`*, ::before, ::after { box-sizing: border-box; margin:
  0 }`, heading sizes, `img { display: block }`) would land on `apple.com` as readily
  as on your own app. Tailwind v4: import `tailwindcss/theme` and
  `tailwindcss/utilities` only, never the collected `tailwindcss`. v3:
  `corePlugins: { preflight: false }`.
- **A prefix.** `.flex`, `.p-4` and `.fixed` collide in both directions with whatever
  the visited page defines. v4: `@import "tailwindcss" prefix(myelin)`. v3:
  `prefix: "myelin-"`. It also matches the convention the shipped scripts use —
  `myelin-osk`, `myelin-screensaver`, `myelin-debug-row`.

Point the content glob at the sources (`assets/js/myelin/**/*.{js,ts}`), not at
the esbuild output. Tailwind and esbuild are independent; the order does not matter
as long as the glob sees the source.

Watch the size. Without preflight and with a tight glob it is a few KB; with a glob
that catches `deps/**` it is hundreds — injected into every page, on every load.

**Not under `priv/static`.** `phx.digest` would put a content hash in the filename
and the manifest would no longer find them.

**Debugging a minified bundle:** build it unminified for the duration. Line numbers in
a stack trace are the file's own, but the wrapper's prologue shares line 1, so columns
on that line are shifted by its length — and in a minified bundle everything is on
line 1.

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

No output at all means the `.so` was not loaded — check that `--web-extensions-dir`
points at a directory containing it.

JavaScript exceptions are reported as warnings with a `myelin:///<id>/<file>`
source URI, which is also what shows up in the remote inspector's Sources panel. A
script that throws while setting up is caught and logged with its id, rather than
silently abandoning the rest of its file.

Watching a device is easiest through Cog's remote inspector: start it with
`WEBKIT_INSPECTOR_HTTP_SERVER=0.0.0.0:9222` and open `http://<device>:9222` from a
desktop browser.

If nothing appears at all, put a minimal script in place first — a manifest matching
`<all_urls>` plus a one-line `document.body.append(…)`. If that shows up, the loader
is fine and the problem is in your script.

## Development

```bash
make check                        # host unit tests — no toolchain needed
make -C test/c syntax             # compile the WebKit-facing code (needs GLib)
mix test                          # Elixir side
MIX_TARGET=<target> mix compile   # cross-compiles priv/webext/libmyelin.so
```

The parsing, matching and configuration layers (`c_src/manifest.c`,
`match_pattern.c`, `config.c`, `json.c`) are deliberately libc-only — no GLib, no
WebKit — so they can be tested on a development machine. That includes the whole
precedence between manifest, device and meta tag.

`injector.c` and `extension.c` do need WebKit, so they are not in the unit tests.
`make -C test/c syntax` compiles them against declared signatures in `test/c/stubs`,
which needs GLib alone. It checks our use of the API, not the API.

### Trying the scripts without a device

```bash
mix myelin.harness
open http://127.0.0.1:8899/test/harness.html
```

The scripts are not served as files. The harness wraps each one the way the extension
does — same prelude, same `ctx` argument — so what runs in the browser is what runs on
a device. Settings come from the same two places: `test/config.json`, re-read on every
request, and query parameters that become meta tags.

`?trusted=0` is the switch worth knowing. It puts the harness in the foreign-page
state: every meta tag stops counting and only the device configuration is left. That
is where you can watch a page fail to switch a script off.

The page also has a leak check, which walks `window` for a `display-lock` PIN and a
canary from the configuration — the demonstration that a script's settings stay
inside it.

One caveat when testing keyboards: use real clicks, not `element.click()` from the
console. A scripted click moves no focus, so it will not reveal a keyboard that closes
the moment you press a key.

`c_src/prelude.js` is turned into a C byte array during the build. It is a real
`.js` file, so `node --check` covers it and an editor treats it as JavaScript.

## Limitations

- **No reload.** Manifests and configuration are read once, when the web process
  starts; changes take effect after Cog restarts. Enabling and disabling works per
  page load via meta tags, not at runtime.
- **Meta tags need `document_end`.** At `document_start` the `<head>` may not be
  parsed yet, so a script running that early cannot read the page's configuration.
- **No isolation from the page.** Scripts share `window` and every intrinsic with the
  page they run in. See *What surrounds a script*.
- **`all_frames` only helps at `document_start`.** At `document_end` the extension is
  told about the main frame only, so a script that has to reach an iframe needs
  `document_start`.

## Licence

MIT. Vendored: [jsmn](https://github.com/zserge/jsmn) (MIT) in `c_src/vendor/jsmn.h`.

The one script that bundles a font vendors a subset of it, SIL OFL 1.1, with the
licence beside it:

- [IBM Plex Mono](https://github.com/IBM/plex) in `priv/scripts/navbar/` —
  `font/OFL-IBMPlexMono.txt`

`screensaver` inlines the Nerves logo from
[nerves-project.org](https://nerves-project.org).
