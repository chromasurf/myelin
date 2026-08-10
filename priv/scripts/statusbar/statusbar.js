/*
 * Status Bar — a fixed strip across the top of every page: clock, current URL,
 * connection state. Entirely self-contained, with no network and no assets, so it
 * works on any page the kiosk visits and not only on your own.
 *
 * It claims the top edge by pushing the document down, and so does navbar.
 * Neither knows about the other, so whichever is injected second wins the padding
 * and the first ends up covering the page it meant to make room on. Run one.
 *
 * Beta.
 *
 * Configuration
 *   height   px                                          28
 *   bg       any CSS colour                              #1c1f21
 *   fg       any CSS colour                              #e8ecee
 *   items    which cells, in order: clock url online     clock url online
 *   format   24h | 12h                                   24h
 *   text     fixed label, shown first                    ()
 *
 * Events
 *   emits    statusbar:ready — carries the height, for anything sitting below
 *   listens  screensaver:show, screensaver:hide
 */

var KNOWN = ["clock", "url", "online"];
var HEIGHT = ctx.config("height", 28);
var ITEMS = ctx.config("items", ["clock", "url", "online"]);
var FORMAT = ctx.config("format", "24h");
var LABEL = ctx.config("text", "");

var bar = document.createElement("div");
bar.id = "myelin-statusbar";
bar.setAttribute("role", "status");
bar.style.height = HEIGHT + "px";
bar.style.background = ctx.config("bg", "#1c1f21");
bar.style.color = ctx.config("fg", "#e8ecee");

function cell(name) {
  var el = document.createElement("span");
  el.className = "myelin-statusbar-cell myelin-statusbar-" + name;
  return el;
}

var cells = {};

if (LABEL) {
  var label = cell("label");
  label.textContent = LABEL;
  bar.appendChild(label);
}

ITEMS.forEach(function (name) {
  if (KNOWN.indexOf(name) === -1) return;
  cells[name] = cell(name);
  bar.appendChild(cells[name]);
});

document.body.appendChild(bar);

// Pushing the document down rather than floating above it: on a kiosk app the
// covered first row would otherwise be permanently unreachable. On the root
// element, so a page that manages its own body padding is unaffected.
document.documentElement.style.paddingTop = HEIGHT + "px";

/* --- content ---------------------------------------------------------- */

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function renderClock() {
  if (!cells.clock) return;

  var now = new Date();
  var hours = now.getHours();
  var suffix = "";

  if (FORMAT === "12h") {
    suffix = hours < 12 ? " AM" : " PM";
    hours = hours % 12 || 12;
  }

  cells.clock.textContent = pad(hours) + ":" + pad(now.getMinutes()) + suffix;
}

function renderUrl() {
  if (!cells.url) return;

  // Host plus path; the query string is usually noise on a status bar and
  // would push everything else out of view.
  var text = location.host + location.pathname;
  cells.url.textContent = text.length > 1 ? text.replace(/\/$/, "") : text;
  cells.url.title = location.href;
}

function renderOnline() {
  if (!cells.online) return;

  var on = navigator.onLine;
  cells.online.textContent = on ? "online" : "offline";
  cells.online.classList.toggle("is-offline", !on);
}

function renderAll() {
  renderClock();
  renderUrl();
  renderOnline();
}

renderAll();

// Tick on the minute boundary and then settle into a 60s rhythm — nothing
// below the minute is displayed, and a kiosk that is idle should stay idle.
window.setTimeout(function () {
  renderClock();
  window.setInterval(renderClock, 60000);
}, (60 - new Date().getSeconds()) * 1000);

window.addEventListener("online", renderOnline);
window.addEventListener("offline", renderOnline);

// Single-page apps change the URL without reloading and pushState fires no
// event, so poll for it. One string comparison a second, against patching the
// history API.
var shown = location.href;

window.setInterval(function () {
  if (location.href === shown) return;
  shown = location.href;
  renderUrl();
}, 1000);

// The screensaver covers the whole screen. Leaving the padding in place is
// fine; dimming the bar keeps it from bleeding through a translucent
// background.
ctx.on("screensaver:show", function () {
  bar.classList.add("is-dimmed");
});

ctx.on("screensaver:hide", function () {
  bar.classList.remove("is-dimmed");
  renderAll();
});

ctx.emit("statusbar:ready", { height: HEIGHT });
