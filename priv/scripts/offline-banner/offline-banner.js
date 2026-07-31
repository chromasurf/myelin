/*
 * Offline Banner — says so when the connection drops, instead of leaving a
 * silently stalled page in front of someone.
 *
 * navigator.onLine only reports whether a link exists, not whether anything is
 * reachable over it: a kiosk on an unplugged switch still reads "online". Set a
 * probe URL and it is re-checked on an interval, which is what actually answers
 * the question.
 *
 * Beta.
 *
 * Configuration
 *   text     what the banner says                        No connection
 *   probe    URL to HEAD for a real answer, "" for none   ()
 *   every    seconds between probes                       15
 *
 * Events
 *   emits    offline, online
 *   listens  statusbar:ready — to sit below a bar rather than under it
 */

var PROBE = ctx.config("probe", "");
var PROBE_MS = ctx.config("every", 15) * 1000;

var banner = document.createElement("div");
banner.id = "cog-offline-banner";
document.body.appendChild(banner);

banner.setAttribute("role", "status");
banner.textContent = ctx.config("text", "No connection");

// Sit below a status bar if one is present. The bar announces its height when
// it is ready; without one the offset stays 0.
function offsetBelow(height) {
  banner.style.setProperty("--cog-offline-offset", (height || 0) + "px");
}

ctx.on("statusbar:ready", function (event) {
  offsetBelow(event.detail && event.detail.height);
});

// Injection order decides whether that event has already fired, and that
// order is just alphabetical — so also look for a bar that is already there.
["cog-statusbar", "cog-statusbar-lv"].forEach(function (elementId) {
  var bar = document.getElementById(elementId);
  if (bar) offsetBelow(bar.offsetHeight);
});

function setOffline(offline) {
  if (banner.classList.contains("is-visible") === offline) return;

  banner.classList.toggle("is-visible", offline);
  ctx.emit(offline ? "offline" : "online");
}

function probe() {
  // cache: no-store, so a cached response cannot fake reachability.
  fetch(PROBE, { method: "HEAD", cache: "no-store" })
    .then(function () {
      setOffline(false);
    })
    .catch(function () {
      setOffline(true);
    });
}

window.addEventListener("online", function () {
  setOffline(false);
  if (PROBE) probe();
});

window.addEventListener("offline", function () {
  setOffline(true);
});

setOffline(!navigator.onLine);

if (PROBE) {
  window.setInterval(probe, PROBE_MS);
  probe();
}
