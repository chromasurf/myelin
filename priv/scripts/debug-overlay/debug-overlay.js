/*
 * Debug Overlay — diagnostics for when you are standing in front of the panel
 * rather than at a laptop with the remote inspector open. Three quick taps into
 * the **bottom-left** corner show and hide it.
 *
 * Bottom-left rather than a top corner, because the top edge is spoken for: a bar
 * (`navbar`, `statusbar`) lives there, and `tap-to-top` answers a tap on the very
 * top edge by scrolling the page up. A diagnostics gesture that fights three other
 * things for the same pixels is a diagnostics gesture nobody can use.
 *
 * Shows URL, viewport, FPS, JS heap where WebKit exposes it, the scripts that
 * registered themselves, and the last few JS errors. That last part is the reason
 * it exists: an exception in a script is otherwise invisible unless somebody
 * is watching the Cog log.
 *
 * Beta.
 *
 * Configuration
 *   open   show it straight away instead of waiting for the taps   false
 */

var CORNER_PX = 80;
var TAPS = 3;
var TAP_WINDOW_MS = 1500;
var KEPT_ERRORS = 5;

var panel = document.createElement("div");
panel.id = "myelin-debug";
document.body.appendChild(panel);
var errors = [];
var taps = [];
var frames = 0;
var fps = 0;
var visible = ctx.config("open", false);

// Installed first, so an error thrown while a later script sets itself up
// still lands here.
window.addEventListener("error", function (event) {
  errors.unshift(
    (event.filename || "?").split("/").pop() +
      ":" +
      (event.lineno || "?") +
      " " +
      (event.message || "")
  );
  errors = errors.slice(0, KEPT_ERRORS);
});

window.addEventListener("unhandledrejection", function (event) {
  var reason = event.reason;
  errors.unshift("promise: " + ((reason && reason.message) || reason));
  errors = errors.slice(0, KEPT_ERRORS);
});

/* --- rendering -------------------------------------------------------- */

// Built as elements rather than assembled into innerHTML: half of what is
// shown here comes from the page — its URL, the message of whatever it threw —
// and textContent cannot be talked into markup.
function line(className, text) {
  var el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function row(label, value) {
  var el = document.createElement("div");
  el.className = "myelin-debug-row";

  var left = document.createElement("span");
  left.textContent = label;

  var right = document.createElement("span");
  right.textContent = String(value);

  el.appendChild(left);
  el.appendChild(right);
  return el;
}

function heap() {
  var memory = window.performance && window.performance.memory;
  if (!memory) return "–";

  return (
    Math.round(memory.usedJSHeapSize / 1048576) +
    " / " +
    Math.round(memory.jsHeapSizeLimit / 1048576) +
    " MB"
  );
}

function render() {
  if (!visible) return;

  var loaded = (window.myelin && window.myelin.loaded) || [];

  panel.textContent = "";
  panel.appendChild(line("myelin-debug-title", "myelin"));
  panel.appendChild(row("URL", location.host + location.pathname));
  panel.appendChild(
    row(
      "Viewport",
      window.innerWidth + "×" + window.innerHeight + " @" + (window.devicePixelRatio || 1) + "x"
    )
  );
  panel.appendChild(row("FPS", fps));
  panel.appendChild(row("JS heap", heap()));
  panel.appendChild(row("Scripts", loaded.length ? loaded.join(", ") : "none"));
  panel.appendChild(row("Online", navigator.onLine ? "yes" : "no"));

  if (!errors.length) return;

  panel.appendChild(line("myelin-debug-title", "Errors"));

  errors.forEach(function (message) {
    panel.appendChild(line("myelin-debug-error", message));
  });
}

/* --- fps -------------------------------------------------------------- */

var lastSecond = null;

function tick(now) {
  if (lastSecond === null) lastSecond = now;
  frames++;

  if (now - lastSecond >= 1000) {
    fps = frames;
    frames = 0;
    lastSecond = now;
    render();
  }

  // Only measure while the panel is up: a rAF loop on a kiosk that is
  // otherwise idle burns CPU for nothing.
  if (visible) window.requestAnimationFrame(tick);
}

function setVisible(next) {
  visible = next;
  panel.classList.toggle("is-visible", visible);

  if (!visible) return;

  lastSecond = null;
  frames = 0;
  render();
  window.requestAnimationFrame(tick);
}

window.addEventListener("pointerdown", function (event) {
  if (event.clientX > CORNER_PX || event.clientY < window.innerHeight - CORNER_PX) {
    taps = [];
    return;
  }

  var now = Date.now();
  taps.push(now);

  taps = taps.filter(function (t) {
    return now - t < TAP_WINDOW_MS;
  });

  if (taps.length < TAPS) return;

  taps = [];
  setVisible(!visible);
});

setVisible(visible);
