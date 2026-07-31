# Ideas

Five userscripts that are **not finished** and **do not ship**. They are here to be
read, copied and reworked, not switched on.

Nothing in this directory is in the Hex package or on the search path. A dependency
cannot reach it and `mix cog_userscripts.copy` will not copy it — the only way to use
one is to take the directory out of a checkout of this repository and put it in your
own application, at which point it is your code and your decision.

They follow the same format as the scripts in `priv/scripts`, so each one is a
readable example of the shape. `mix cog_userscripts.harness` serves them too, so
they can be tried in a browser.

| Idea | What it shows, and what is unfinished about it |
|---|---|
| `probe-field` | Two fields in one shadow root, which is what `ctx.onFocus` exists for: focus moving between them dispatches nothing outside the tree. It is a test fixture, not a feature. |
| `display-lock` | A PIN panel, a focus trap, an attempt penalty. It is a **visual** lock only — the PIN is in the DOM and another URL walks around it. Real protection belongs in front of the pages, on the Elixir side. |
| `konami` | The shortest whole script there is: a secret gesture, and confetti on a canvas. Mostly here as a shape to copy. |
| `idle-reload` | Returning to a known state after a while. Trivial to write, and whether the screensaver should stop the countdown depends on the terminal — so it is a decision, not a default. |
| `statusbar-liveview` | See below. |

## Why `statusbar-liveview` in particular is an idea

It embeds a LiveView served by your application as a bar on any page the kiosk
visits, by fetching the rendered container and letting the LiveView client adopt it.
That works on your own pages. Everywhere else it needs three things, and two of them
weaken the application:

1. **A LiveView socket that accepts a foreign origin** — `check_origin: false`, or an
   explicit list of every origin the kiosk might visit.
2. **CORS headers that echo the requesting origin, with credentials.** The fetch
   sends `credentials: "include"` so the LiveView still sees the session cookie, and
   a credentialed request treats `*` as no permission at all. So the endpoint has to
   reflect whatever origin asks — which on a device reachable from a network is not
   something to do without thinking about it.
3. **An asset bundle that puts `LiveSocket` and `Phoenix.Socket` on `window`.** The
   default Phoenix esbuild setup does not, so this needs a bundle built for it.

And on an `https` page it cannot work at all: WebKit blocks mixed content to
`http://localhost`, alone among engines, so the fetch, the WebSocket and an iframe
are all refused.

The plain `statusbar` script needs no network and covers most of what people reach
for this for. If you want firmware data in a bar on *your own* pages, the simpler
route is `ctx.emit` and a `handle_event` — see *Talking to a LiveView* in the README.
