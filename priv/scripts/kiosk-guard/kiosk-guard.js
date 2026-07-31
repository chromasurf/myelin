/*
 * Kiosk Guard — removes the browser affordances that only cause trouble on a panel
 * bolted to a wall: the context menu, text selection, drag and drop, pinch zoom, and
 * a mouse cursor nobody is holding. Text fields stay selectable whatever else is
 * switched off, because editing without selection is painful.
 *
 * Beta.
 *
 * Configuration
 *   allow   guards to leave alone: selection contextmenu cursor zoom drag   ()
 */

var ALLOW = ctx.config("allow", []);
var CURSOR_IDLE_MS = 3000;

function guards(what) {
  return ALLOW.indexOf(what) === -1;
}

// composedPath()[0], not event.target: these listeners sit on the window, and there
// the target of anything inside an open shadow root is retargeted to the host.
// closest() then finds no input, the field counts as "not a text field", and
// selection and the context menu get suppressed inside it — including in an
// application's own web components, where it looks like the field is broken rather
// than guarded.
function eventTarget(event) {
  return event.composedPath ? event.composedPath()[0] : event.target;
}

function inTextField(el) {
  return !!(el && el.closest && el.closest("input, textarea, [contenteditable]"));
}

if (guards("contextmenu")) {
  window.addEventListener("contextmenu", function (event) {
    if (!inTextField(eventTarget(event))) event.preventDefault();
  });
}

if (guards("selection")) {
  // A class rather than inline styles, so kiosk-guard.css can keep the exception for
  // text fields in one place.
  document.documentElement.classList.add("myelin-guard-no-select");

  window.addEventListener("selectstart", function (event) {
    if (!inTextField(eventTarget(event))) event.preventDefault();
  });
}

if (guards("drag")) {
  window.addEventListener("dragstart", function (event) {
    event.preventDefault();
  });
}

if (guards("zoom")) {
  // Pinch zoom arrives as a multi-touch gesture; WebKit also fires the non-standard
  // gesture* events, which is what actually zooms here.
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (name) {
    window.addEventListener(name, function (event) {
      event.preventDefault();
    });
  });

  window.addEventListener(
    "touchmove",
    function (event) {
      if (event.touches && event.touches.length > 1) event.preventDefault();
    },
    { passive: false }
  );

  // Double-tap zoom.
  var lastTap = 0;

  window.addEventListener("touchend", function (event) {
    var now = Date.now();
    if (now - lastTap < 300) event.preventDefault();
    lastTap = now;
  });
}

if (guards("cursor")) {
  var hideTimer = null;

  var showCursor = function () {
    document.documentElement.classList.remove("myelin-guard-no-cursor");
    window.clearTimeout(hideTimer);

    hideTimer = window.setTimeout(function () {
      document.documentElement.classList.add("myelin-guard-no-cursor");
    }, CURSOR_IDLE_MS);
  };

  ["mousemove", "pointerdown"].forEach(function (name) {
    window.addEventListener(name, showCursor);
  });

  showCursor();
}
