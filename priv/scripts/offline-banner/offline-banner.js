/*
 * Offline Banner — says so when the connection drops, instead of leaving a
 * silently stalled page in front of someone.
 *
 * navigator.onLine only reports whether a link exists, not whether anything is
 * reachable over it: a kiosk on an unplugged switch still reads "online". Set a
 * probe URL and it is re-checked on an interval, which is what actually answers
 * the question.
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
banner.id = "myelin-offline-banner";
document.body.appendChild(banner);

banner.setAttribute("role", "status");
banner.textContent = ctx.config("text", "No connection");

// Sit below a status bar if one is present. The bar announces its height when
// it is ready; without one the offset stays 0.
function offsetBelow(height) {
  banner.style.setProperty("--myelin-offline-offset", (height || 0) + "px");
}

ctx.on("statusbar:ready", function (event) {
  offsetBelow(event.detail && event.detail.height);
});

// Injection order decides whether that event has already fired, and that
// order is just alphabetical — so also look for a bar that is already there.
["myelin-statusbar", "myelin-statusbar-lv"].forEach(function (elementId) {
  var bar = document.getElementById(elementId);
  if (bar) offsetBelow(bar.offsetHeight);
});

function setOffline(offline) {
  if (banner.classList.contains("is-visible") === offline) return;

  banner.classList.toggle("is-visible", offline);
  ctx.emit(offline ? "offline" : "online");
}

// Half the interval, so a probe is always finished before the next one starts.
var PROBE_TIMEOUT_MS = Math.max(2000, Math.round(PROBE_MS / 2));

function probe() {
  // cache: no-store, so a cached response cannot fake reachability.
  //
  // mode: no-cors, because the probe is almost always a foreign origin and
  // CORS would reject every response it has no headers for — making "the
  // server answered" indistinguishable from "the cable is out". An opaque
  // response resolves, a network failure rejects, and that is the whole
  // question this banner asks.
  //
  // The abort is what makes it recover. Without it a probe sent into an
  // unplugged cable hangs until TCP gives up, which is minutes — and the
  // interval keeps starting more. Six of those and WebKit's per-host connection
  // limit is full, so the probe that would finally succeed never leaves: the
  // banner stays up long after the cable is back. Every probe now gives up well
  // before the next one starts, and nothing accumulates.
  var abort = new AbortController();
  var giveUp = window.setTimeout(function () {
    abort.abort();
  }, PROBE_TIMEOUT_MS);

  fetch(PROBE, {
    method: "HEAD",
    cache: "no-store",
    mode: "no-cors",
    signal: abort.signal
  })
    .then(function () {
      window.clearTimeout(giveUp);
      setOffline(false);
    })
    .catch(function () {
      window.clearTimeout(giveUp);
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
