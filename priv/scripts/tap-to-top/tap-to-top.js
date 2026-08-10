/*
 * Tap to Top — tap the very top edge of the screen and the page scrolls back up,
 * the way a tablet's status bar does it.
 *
 * On a long page that is the difference between one tap and a dozen swipes, and
 * on a wall panel nobody wants to swipe a dozen times.
 *
 * This is what is left of a larger script that also drew overscroll bounce,
 * pull-to-refresh and edge swipes. Those needed the scroll position while a
 * finger was still down, and WPE scrolls the document on its own thread: a
 * `scrollY` read inside a touch handler is stale — measured at 0 through an
 * entire gesture whose scroll events ran to 6044. Cog's
 * `--features=-AsyncFrameScrolling` fixes the reading and tears the display
 * instead. A tap needs none of that: it reads the position once, when nothing is
 * moving, which is the one moment the number is right.
 *
 * Beta.
 *
 * Configuration
 *   zone   height of the tap strip along the top edge, px   24
 *
 * Events
 *   emits    tap-to-top:scrolled — when a tap sends the page up
 */

var TOP_ZONE = ctx.config("zone", 24);

// A tap, not a drag: longer than this or further than that and the finger was
// doing something else.
var TAP_MS = 300;
var TAP_SLOP = 8;

// Underdamped on purpose — the small overshoot at the end is what makes it feel
// like the page arrived rather than being teleported.
var STIFFNESS = 420;
var DAMPING = 34;

/* --- the spring ------------------------------------------------------------ */

// One integrator, running only while a tap is being answered. The scroll
// position *is* the animated value, so nothing here transforms anything — which
// is why this survives on a stack where the overscroll band could not.
var x = 0;
var v = 0;
var raf = null;

function stop() {
  if (raf) window.cancelAnimationFrame(raf);
  raf = null;
}

function ride(from) {
  x = from;
  v = 0;

  if (raf) return;

  var last = null;

  function step(now) {
    if (last === null) last = now;
    var dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;

    v += (-STIFFNESS * x - DAMPING * v) * dt;
    x += v * dt;

    if (x <= 0 || (Math.abs(x) < 0.5 && Math.abs(v) < 8)) {
      window.scrollTo(0, 0);
      stop();
      return;
    }

    window.scrollTo(0, x);
    raf = window.requestAnimationFrame(step);
  }

  raf = window.requestAnimationFrame(step);
}

/* --- the tap --------------------------------------------------------------- */

var tap = null;

// The navbar owns the top edge while it runs, and a tap there is meant for its
// buttons. The statusbar is passive and stays tappable, which is exactly the
// status-bar feel this borrows from.
function onNavbar(el) {
  return !!(el && el.closest && el.closest("#myelin-navbar"));
}

window.addEventListener(
  "touchstart",
  function (event) {
    tap = null;

    if (event.touches.length !== 1) return;

    var touch = event.touches[0];

    if (touch.clientY > TOP_ZONE || onNavbar(event.target)) return;

    tap = { x: touch.clientX, y: touch.clientY, at: performance.now() };

    // A finger on the glass stops a ride in progress, so a second tap does not
    // fight the first.
    stop();
  },
  { passive: true }
);

window.addEventListener(
  "touchmove",
  function (event) {
    if (!tap || !event.touches.length) return;

    var touch = event.touches[0];

    if (
      Math.abs(touch.clientX - tap.x) > TAP_SLOP ||
      Math.abs(touch.clientY - tap.y) > TAP_SLOP
    ) {
      tap = null;
    }
  },
  { passive: true }
);

window.addEventListener(
  "touchend",
  function () {
    var ended = tap;
    tap = null;

    if (!ended || performance.now() - ended.at > TAP_MS) return;
    if (window.scrollY <= 0) return;

    ctx.emit("tap-to-top:scrolled");
    ride(window.scrollY);
  },
  { passive: true }
);

window.addEventListener("touchcancel", function () { tap = null; }, { passive: true });
