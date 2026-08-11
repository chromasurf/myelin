# Ideas

Scripts that are ideas, and unfinished. Nothing here ships or is loadable.

| Idea | What it shows, and what is unfinished about it |
|---|---|
| `display-lock` | A PIN panel, a focus trap, an attempt penalty. It is a **visual** lock only — the PIN is in the DOM and another URL walks around it. Real protection belongs in front of the pages, on the Elixir side. |
| `konami` | The shortest whole script there is: a secret gesture, and confetti on a canvas. Mostly here as a shape to copy. |
| `idle-reload` | Returning to a known state after a while. Trivial to write, and whether the screensaver should stop the countdown depends on the terminal — so it is a decision, not a default. |
| `statusbar-liveview` | A LiveView of your application as a bar on any page. Needs `check_origin: false`, CORS headers that echo the requesting origin with credentials, and a bundle that puts `LiveSocket` on `window`. On an `https` page it cannot work at all — WebKit blocks mixed content to `http://localhost`. |

