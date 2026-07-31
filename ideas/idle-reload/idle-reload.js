/*
 * Idle Reload — sends the kiosk back to its start page after a while without
 * input, so a terminal left standing in some sub-form returns to a known state.
 *
 * The screensaver does not stop the countdown: it keeps running while the screen is
 * dark, and the navigation happens behind it. Whether that is what you want depends
 * on the terminal, which is one reason this is an idea rather than a shipped script.
 *
 * Configuration
 *   after   seconds without input        300
 *   url     where to go                  /
 */

var IDLE_MS = ctx.config("after", 300) * 1000;
var TARGET = ctx.config("url", "/");

var timer = null;

function restart() {
  window.clearTimeout(timer);
  timer = window.setTimeout(go, IDLE_MS);
}

function go() {
  // Already there? Then a reload would only cost a flash of white.
  if (location.pathname + location.search === TARGET) {
    restart();
    return;
  }

  console.log("[idle-reload] returning to " + TARGET);
  location.href = TARGET;
}

["pointerdown", "keydown", "touchstart", "wheel"].forEach(function (name) {
  window.addEventListener(name, restart, { capture: true, passive: true });
});

document.addEventListener("visibilitychange", function () {
  if (document.hidden) window.clearTimeout(timer);
  else restart();
});

restart();
