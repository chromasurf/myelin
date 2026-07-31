# Contributing

Issues and pull requests are welcome. The library is small and the tests are
fast, so the loop below runs in seconds on a development machine — no Nerves
toolchain and no device needed for anything except the extension itself.

## Running the tests

There are three layers, and CI runs all of them:

```bash
make check                        # C unit tests — libc only, no GLib, no WebKit
make -C test/c syntax             # compile the WebKit-facing C (needs GLib)
mix test                          # the Elixir side
mix format --check-formatted
```

The parsing, matching and configuration layers (`c_src/manifest.c`,
`match_pattern.c`, `config.c`, `json.c`) are deliberately libc-only so they can be
tested anywhere with a compiler. That covers the whole precedence between
manifest, device configuration and meta tag, including the property the design
rests on: a page that is not a trusted origin cannot switch a script off.

`injector.c` and `extension.c` need WebKit, so they are not in the unit tests.
`make -C test/c syntax` compiles them against declared signatures in `test/c/stubs`
so a typo does not have to wait for a device build. It checks our use of the API,
not the API — a WebKit change is still something only a device build finds.

## Trying a change without a device

```bash
mix myelin.harness
open http://127.0.0.1:8899/test/harness.html
```

The harness wraps each script the way the extension does — same prelude, same
`ctx` argument — so what runs in the browser is what runs on a device. Settings
come from `test/config.json` and from query parameters that become meta tags.
`?trusted=0` puts it in the foreign-page state. See *Development* in the README
for the details.

Use real clicks rather than `element.click()` when testing anything
keyboard-related: a scripted click moves no focus.

## Building the extension

Only a cross-compile produces the `.so`:

```bash
MIX_TARGET=<target> mix compile
```

Three invariants in the `Makefile` are easy to break by accident — pkg-config pointing
at the toolchain rather than the sysroot, `--cflags` without `--libs`, and undefined
symbols being intended. They are written up in the `Makefile`'s own header, next to
the code they constrain. Read that before changing it.

## Style

- `mix format` for Elixir. The C is hand-formatted; match the file you are in.
- Scripts are ES5-compatible plain JS, no build step, no dependencies. They are
  meant to be read and reworked by whoever copies them, so clarity beats brevity.
- User-facing strings are English, and configurable where that is reasonable.

## Adding a script

A script is a plain `.js` file whose body is the script — the loader wraps it in a
function, so there is no IIFE to write and no `"use strict"` to declare. Settings come
from `ctx.config(name, default)`, events from `ctx.on` and `ctx.emit`, and everything
else from the DOM. Read `priv/scripts/kiosk-guard` for the shortest whole example, and
*Writing a script* in the README for the rest.

What *is* fixed is the header: a title line, a paragraph saying what it does and why,
`Configuration` as a table of name, meaning and default, and `Events` listing what it
emits and what it listens for.

`priv/scripts/` is what ships and is held to that standard. `ideas/` is for things
worth reading but not finished; nothing there ships or is loadable, and
`ideas/README.md` says of each one what is unresolved about it.

A new script needs a directory, a `manifest.json`, and nothing else. Tests assert that
every manifest parses with the real C parser, that referenced files exist and stay
inside the directory, that ids are unique across both directories, that no manifest
carries defaults the script passes to `ctx.config` anyway, and that **nothing is
enabled by default** — a script that switches itself on fails that last one on purpose.

Do not reach for `document.getElementById(id)` plus `remove()` before adding your own
element. `document-loaded` fires once per page, so a script body runs once — and if it
finds an element of the *page* with that id, it deletes part of somebody else's page.

A script is stable or it says `Beta.` in its header. The copy task groups by the same
distinction, and a test keeps the two statements in step.
