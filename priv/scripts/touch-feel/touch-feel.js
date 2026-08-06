/*
 * Touch Feel — the physics a finger expects from a tablet, on a kiosk panel:
 * rubber-band overscroll (the document and its inner scrollers), pull-to-
 * refresh, edge swipes for back and forward with the page peeking along, a
 * tap on the very top edge that scrolls back up, and an iOS-style scroll
 * indicator.
 *
 * One spring drives every release. It integrates per frame, is seeded with
 * the finger's (or the scroll's) velocity at the moment of letting go, and a
 * new gesture retargets a running spring by inheriting its position and
 * momentum. That handover is what tablet physics feel like; an eased CSS
 * transition has no idea how fast the finger was moving and always looks
 * like an afterthought. (Motion.dev was considered and measured: its global
 * build is 140 kB into every visited page for the ~90 lines it would replace
 * — the integrator below is those lines.)
 *
 * The rubber band is a transform on <body>, which makes body the containing
 * block for fixed-position elements — so the bars the other scripts pin to an
 * edge ride along with the bounce. That is a limitation and a feature in one:
 * it is also what the whole page moving as one sheet looks like.
 *
 * The back and forward swipes deliberately do NOT touch the browser history.
 * On this WPE a history navigation wedges the panel's touch handling (a hard
 * navigation from the same gesture is fine — the navbar proves it on every
 * tap; a history step leaves the panel frozen on the old page's last frame),
 * so the script keeps its own trail of visited URLs in window.name and walks
 * it with plain location.href. WebKit wipes window.name at every cross-origin
 * navigation, so a fresh trail plants document.referrer as its first entry —
 * the way back across an origin boundary is the referrer's origin, which is
 * what the policy leaves of it. The cost: window.name belongs to this script
 * while it is enabled, forward never crosses an origin boundary, every step
 * is a real load, and the browser's own history grows instead of unwinding.
 *
 * Nothing here claims a navigation gesture's touch sequence: no
 * preventDefault on the edge swipes, ever. A sequence this script had claimed
 * and then navigated out of left WPE's touch handling wedged until Cog was
 * restarted. Overscroll is the one place preventDefault remains — no
 * navigation follows it, and WebKit's own (absent) overscroll handling would
 * otherwise fight the sheet.
 *
 * Beta.
 *
 * Configuration — every gesture has its own switch
 *   rubber     overscroll bounce at the document's ends      true
 *   inner      the same bounce inside scrollable containers  true
 *   refresh    pull down at the top to reload the page       true
 *   back       swipe in from the left edge to go back        true
 *   forward    swipe in from the right edge to go forward    true
 *   peek       the page drifts along with an edge swipe      true
 *   top        tap the very top edge to scroll back up       true
 *   indicator  a scroll position pill at the right edge      true
 *
 * Events
 *   emits    touch-feel:refresh — just before the reload it triggers
 *   emits    touch-feel:back {to} — just before it navigates back
 *   emits    touch-feel:forward {to} — just before it navigates forward
 */

var RUBBER = ctx.config("rubber", true);
var INNER = ctx.config("inner", true);
var REFRESH = ctx.config("refresh", true);
var BACK = ctx.config("back", true);
var FORWARD = ctx.config("forward", true);
var PEEK = ctx.config("peek", true);
var TOP = ctx.config("top", true);
var INDICATOR = ctx.config("indicator", true);

/* Tuning. MAX_PULL is the asymptote a drag saturates against, REFRESH_AT the
   effective offset that arms the reload, EDGE the strip an edge swipe may
   start in, SWIPE_AT how far it has to travel to count, PEEK_FOLLOW how much
   of the finger the page follows sideways. The spring is a touch underdamped
   on purpose — the slight overshoot is the tablet feel. */
var MAX_PULL = 140;
var REFRESH_AT = 80;
var EDGE = 28;
var SWIPE_AT = 70;
var PEEK_FOLLOW = 0.35;
var TOP_ZONE = 24;
var TAP_MS = 300;
var TAP_SLOP = 8;
var STIFFNESS = 260;
var DAMPING = 26;

var root = document.documentElement;

/* --- one spring, many channels ------------------------------------------ */

// A channel is one animated value. settle() starts its spring toward 0 —
// or, if one is already running, retargets it in place: the new call simply
// hands over position and velocity and the integrator carries on, which is
// what lets a finger catch a moving sheet without a visible seam.
function makeChannel(onFrame, onDone) {
  return { x: 0, v: 0, raf: null, onFrame: onFrame, onDone: onDone || null };
}

function settle(channel, from, velocity) {
  channel.x = from;
  channel.v = velocity;

  if (channel.raf) return;

  var last = null;

  function step(now) {
    if (last === null) last = now;
    var dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;

    channel.v += (-STIFFNESS * channel.x - DAMPING * channel.v) * dt;
    channel.x += channel.v * dt;

    if (Math.abs(channel.x) < 0.3 && Math.abs(channel.v) < 8) {
      channel.x = 0;
      channel.raf = null;
      channel.onFrame(0);
      if (channel.onDone) channel.onDone();
      return;
    }

    // onFrame may halt this very channel (the scroll spring hands its
    // momentum to the rubber band that way). The ticket notices: halt()
    // clears channel.raf, and a cleared ticket must not schedule on.
    var ticket = channel.raf;
    channel.onFrame(channel.x);
    if (channel.raf !== ticket) return;

    channel.raf = window.requestAnimationFrame(step);
  }

  channel.raf = window.requestAnimationFrame(step);
}

function halt(channel) {
  if (channel.raf) {
    window.cancelAnimationFrame(channel.raf);
    channel.raf = null;
  }

  channel.x = 0;
  channel.v = 0;
}

/* --- the body as one sheet ----------------------------------------------- */

// Peek (x) and rubber (y) share the body's transform, so both write through
// here and the newest value of either axis wins a frame.
var bodyX = 0;
var bodyY = 0;

function applyBody() {
  document.body.style.transform =
    bodyX || bodyY ? "translate3d(" + bodyX + "px," + bodyY + "px,0)" : "";
}

function setBodyX(x) {
  bodyX = x;
  applyBody();
}

function setBodyY(y) {
  bodyY = y;
  applyBody();
  renderPull(Math.max(y, 0));
}

var bodyXChannel = makeChannel(setBodyX);
var bodyYChannel = makeChannel(setBodyY);

/* --- only the right scroller ---------------------------------------------- */

function maxScroll() {
  return Math.max(0, root.scrollHeight - window.innerHeight);
}

// The scrollable container a drag starts in, or null for the document. A drag
// inside one belongs to that container — with `inner` on it gets its own
// rubber band, with it off the document must not fight it either way.
function scrollerAncestor(el) {
  for (; el && el !== document.body && el !== root; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1) {
      var overflow = getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll") return el;
    }
  }

  return null;
}

/* --- rubber band ---------------------------------------------------------- */

// Saturating rather than linear: the further the finger goes, the less the
// page follows, and MAX_PULL is the limit it never quite reaches.
function damp(distance) {
  return (MAX_PULL * distance) / (distance + MAX_PULL);
}

// The inner channel animates whichever container the gesture that filled it
// was in; the element travels with the channel so a release keeps animating
// the right box even if the next touch lands elsewhere.
var innerEl = null;

var innerChannel = makeChannel(
  function (x) {
    if (innerEl) innerEl.style.transform = x ? "translate3d(0," + x + "px,0)" : "";
  },
  function () {
    if (innerEl) innerEl.style.transform = "";
    innerEl = null;
  }
);

/* --- the pull-to-refresh indicator ----------------------------------------- */

var indicator = null;
var indicatorArrow = null;

if (REFRESH) {
  indicator = document.createElement("div");
  indicator.id = "myelin-touch-refresh";
  indicator.setAttribute("aria-hidden", "true");
  indicator.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66" />' +
    '<path d="M20 3.5v5h-5" /></svg>';
  document.body.appendChild(indicator);
  indicatorArrow = indicator.firstChild;
}

function renderPull(pull) {
  if (!indicator) return;

  indicator.classList.toggle("is-armed", pull >= REFRESH_AT);
  indicator.classList.toggle("is-pulling", pull > 4);

  // Straight onto the transform: winding the arrow through a CSS variable
  // recalculated style on every frame of the drag.
  if (!indicator.classList.contains("is-refreshing")) {
    indicatorArrow.style.transform =
      "rotate(" + Math.min(pull / REFRESH_AT, 1) * 360 + "deg)";
  }
}

function triggerRefresh() {
  indicator.classList.add("is-refreshing");
  indicatorArrow.style.transform = "";
  ctx.emit("touch-feel:refresh");

  // The sheet settles onto a holding position instead of freezing wherever
  // the finger left it — the spinner needs a shelf to sit on while the page
  // goes away. settle() aims at 0, so the shelf is carved out in onFrame.
  var shelf = damp(REFRESH_AT);

  settle(bodyYChannel, bodyY - shelf, 0);
  bodyYChannel.onFrame = function (x) {
    bodyY = x + shelf;
    applyBody();
  };

  // Never leave the page from inside the touch sequence that asked for it.
  window.setTimeout(function () {
    location.reload();
  }, 0);
}

/* --- the trail the edge swipes walk ----------------------------------------- */

// window.name, because it is the one string that survives navigation across
// origins. The invariant: the trail's top is always the current page — each
// page records itself when this script starts, never on the way out (a write
// during pagehide is lost in the very navigation it tries to describe).
// myelinAhead is what goBack left behind, for goForward to walk again; any
// ordinary navigation discards it, the way every browser does.
function readTrail() {
  try {
    var parsed = JSON.parse(window.name);

    if (parsed && Array.isArray(parsed.myelinTrail)) {
      if (!Array.isArray(parsed.myelinAhead)) parsed.myelinAhead = [];
      return parsed;
    }
  } catch (ignore) {
    /* someone else's window.name — start fresh */
  }

  return { myelinTrail: [], myelinAhead: [] };
}

function writeTrail(state) {
  window.name = JSON.stringify(state);
}

if (BACK || FORWARD) {
  var arrival = readTrail();
  var arrivalTrail = arrival.myelinTrail;

  // The trail dies at every origin boundary: WebKit wipes window.name on a
  // cross-origin navigation. The referrer still names where we came from —
  // origin only, by policy, but that is exactly the step back — so a fresh
  // trail gets it planted underneath. From there the same-origin part of the
  // journey accumulates on top as usual.
  if (
    arrivalTrail.length === 0 &&
    document.referrer &&
    document.referrer.indexOf(location.origin) !== 0
  ) {
    arrivalTrail.push(document.referrer);
  }

  if (arrivalTrail[arrivalTrail.length - 1] !== location.href) {
    // An ordinary navigation: record it and drop the forward stack.
    arrivalTrail.push(location.href);
    if (arrivalTrail.length > 50) arrivalTrail.shift();
    arrival.myelinAhead = [];
    writeTrail(arrival);
  }
}

// Always a hard load, never history.back(): on this Cog/DRM stack a history
// navigation leaves the panel showing the old page's last frame while the web
// process has long moved on — the compositor stops getting frames. A plain
// location load repaints reliably; the HTTP cache is what softens the cost.
function navigateVia(_historyStep, target) {
  location.href = target;
}

function goBack() {
  var state = readTrail();
  var trail = state.myelinTrail;

  // trail[last] is this page; the step back is the last *other* entry.
  while (trail.length > 0 && trail[trail.length - 1] === location.href) {
    state.myelinAhead.push(trail.pop());
  }

  var target = trail[trail.length - 1];
  if (!target) return;

  writeTrail(state);
  ctx.emit("touch-feel:back", { to: target });
  navigateVia(-1, target);
}

function goForward() {
  var state = readTrail();
  var target = null;

  while (state.myelinAhead.length > 0 && !target) {
    var candidate = state.myelinAhead.pop();
    if (candidate !== location.href) target = candidate;
  }

  if (!target) return;

  state.myelinTrail.push(target);
  writeTrail(state);
  ctx.emit("touch-feel:forward", { to: target });
  navigateVia(1, target);
}

/* --- the scroll indicator ---------------------------------------------------- */

var pill = null;
var pillTimer = null;

if (INDICATOR) {
  pill = document.createElement("div");
  pill.id = "myelin-touch-scrollbar";
  pill.setAttribute("aria-hidden", "true");
  document.body.appendChild(pill);
}

// The pill's geometry (a layout write plus the scrollHeight read) is settled
// once per burst of scrolling; every event after that only moves the pill by
// transform, which stays on the compositor. Writing height per event made
// each scroll event pay for a full layout pass.
var pillHeight = 0;
var pillTravel = 0;
var pillMax = 0;

function measureIndicator() {
  pillMax = maxScroll();
  if (pillMax <= 0) return;

  var viewport = window.innerHeight;

  pillHeight = Math.max(24, (viewport / root.scrollHeight) * viewport - 8);
  pillTravel = viewport - 8 - pillHeight;
  pill.style.height = pillHeight + "px";
}

function showIndicator() {
  if (!pill) return;

  if (!pillTimer) measureIndicator();
  if (pillMax <= 0) return;

  var along = Math.min(Math.max(window.scrollY / pillMax, 0), 1);

  pill.style.transform = "translate3d(0," + (4 + pillTravel * along) + "px,0)";
  pill.classList.add("is-visible");

  window.clearTimeout(pillTimer);
  pillTimer = window.setTimeout(function () {
    pill.classList.remove("is-visible");
    pillTimer = null;
  }, 600);
}

/* --- tap the top edge to scroll back up --------------------------------------- */

// iOS' status-bar tap, on the spring like everything else. The channel's
// value is the scroll position itself; if the spring undershoots past zero
// with momentum left, that momentum is handed to the rubber band and the
// arrival bounces — which is exactly what it does on the tablet.
var scrollChannel = makeChannel(function (x) {
  if (x <= 0) {
    window.scrollTo(0, 0);

    if (RUBBER && Math.abs(scrollChannel.v) > 60) {
      var carried = scrollChannel.v;
      halt(scrollChannel);
      settle(bodyYChannel, 0, -carried * 0.25);
    } else {
      halt(scrollChannel);
    }

    return;
  }

  window.scrollTo(0, x);
});

function scrollToTop() {
  if (window.scrollY > 0) settle(scrollChannel, window.scrollY, 0);
}

/* --- one gesture at a time ------------------------------------------------------ */

var gesture = null;

// Whether a touch belongs to another myelin surface — their buttons must keep
// working inside the edge strip, so those sequences are never cancelled.
function onMyelinSurface(el) {
  return !!(
    el &&
    el.closest &&
    el.closest("#myelin-navbar, #myelin-statusbar, #myelin-osk, #myelin-keyboard")
  );
}

window.addEventListener(
  "touchstart",
  function (event) {
    // A gesture whose touchend never arrived would block this slot forever —
    // a stale one is abandoned the moment a fresh finger lands.
    if (gesture && performance.now() - gesture.lastT > 800) endGesture(false);

    if (event.touches.length !== 1 || gesture) return;

    // A finger on the glass catches whatever is in flight — the scroll ride
    // stops where it is, the sheets hand their state to the next gesture.
    halt(scrollChannel);

    var touch = event.touches[0];
    var target = event.target;
    var scroller = scrollerAncestor(target);

    var edge =
      BACK && touch.clientX <= EDGE
        ? "left"
        : FORWARD && touch.clientX >= window.innerWidth - EDGE
          ? "right"
          : null;

    // WPE 2.50 has a half-built edge gesture of its own: it claims any
    // sequence that starts at the screen's edge — the page never sees the
    // moves — but on this DRM stack it commits no navigation either.
    // Cancelling the touchstart is the documented way for a page to keep such
    // a sequence to itself, and it is what lets the peek and the trail work
    // at all. Verified against libinput: the sensor reports the full track,
    // WebKit was eating it.
    if (edge && event.cancelable && !onMyelinSurface(target)) event.preventDefault();

    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      startT: performance.now(),
      lastX: touch.clientX,
      lastY: touch.clientY,
      lastT: performance.now(),
      velocityX: 0,
      velocityY: 0,
      scroller: scroller,
      kind: null,
      pull: 0,
      edge: edge,
      // The navbar owns the top edge while it runs — a tap there presses its
      // buttons, not this. The statusbar is passive and stays tappable, which
      // is exactly the iOS status-bar feel.
      topTap:
        TOP &&
        touch.clientY <= TOP_ZONE &&
        !(target && target.closest && target.closest("#myelin-navbar"))
    };
  },
  // Not passive — the edge strip has to be able to cancel the touchstart.
  { passive: false }
);

window.addEventListener(
  "touchmove",
  function (event) {
    if (!gesture || event.touches.length !== 1) return;

    var touch = event.touches[0];
    var dx = touch.clientX - gesture.startX;
    var dy = touch.clientY - gesture.startY;

    var now = performance.now();
    var dt = now - gesture.lastT;

    if (dt > 0) {
      gesture.velocityX = ((touch.clientX - gesture.lastX) / dt) * 1000;
      gesture.velocityY = ((touch.clientY - gesture.lastY) / dt) * 1000;
    }

    gesture.lastX = touch.clientX;
    gesture.lastY = touch.clientY;
    gesture.lastT = now;

    if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) gesture.topTap = false;

    if (!gesture.kind) {
      if (gesture.edge && Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 8) {
        gesture.kind = "edge";
      } else if (Math.abs(dy) > Math.abs(dx)) {
        // The scroll bounds are read once per gesture — they are layout reads,
        // and a drag delivers touchmoves faster than frames.
        if (gesture.scroller) {
          gesture.kind = INNER ? "inner" : "other";
          gesture.innerMax = gesture.scroller.scrollHeight - gesture.scroller.clientHeight;
        } else {
          gesture.kind = "scroll";
          gesture.docMax = maxScroll();
        }
      } else if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        gesture.kind = "other";
      }
    }

    if (gesture.kind === "edge") {
      var along = gesture.edge === "left" ? dx : -dx;
      var alongVelocity = gesture.edge === "left" ? gesture.velocityX : -gesture.velocityX;

      if (PEEK && !gesture.committed) {
        halt(bodyXChannel);
        setBodyX((gesture.edge === "left" ? 1 : -1) * Math.max(along, 0) * PEEK_FOLLOW);
      }

      // Committed mid-move, not on release: WPE's half-gesture swallows the
      // touchend of an edge sequence often enough that waiting for it means
      // navigating only sometimes. Distance OR speed decides — a flick lifts
      // off long before 70px, and on the tablet the speed is what means
      // "yes"; the small distance floor keeps a twitch from navigating.
      if (!gesture.committed && (along >= SWIPE_AT || (along >= 24 && alongVelocity > 600))) {
        gesture.committed = true;

        if (bodyX) settle(bodyXChannel, bodyX, gesture.velocityX * 0.4);
        if (gesture.edge === "left") goBack();
        else goForward();
      }

      return;
    }

    if (gesture.kind === "inner") {
      var el = gesture.scroller;
      var innerTop = el.scrollTop <= 0 && dy > 0;
      var innerBottom = el.scrollTop >= gesture.innerMax && dy < 0;

      if (innerTop || innerBottom) {
        var innerPull = damp(Math.abs(dy));

        halt(innerChannel);
        innerEl = el;
        innerChannel.onFrame(innerTop ? innerPull : -innerPull);
        innerChannel.x = innerTop ? innerPull : -innerPull;

        if (event.cancelable) event.preventDefault();
      } else if (innerChannel.x) {
        innerChannel.onFrame(0);
        innerChannel.x = 0;
      }

      return;
    }

    if (gesture.kind !== "scroll") return;

    showIndicator();

    // Overscroll: past the top pulling down, or past the bottom pushing up.
    var overTop = window.scrollY <= 0 && dy > 0;
    var overBottom = window.scrollY >= gesture.docMax && dy < 0;

    if (overTop || overBottom) {
      var pull = damp(Math.abs(dy));

      if (RUBBER) {
        halt(bodyYChannel);
        setBodyY(overTop ? pull : -pull);
      } else if (overTop && REFRESH) {
        renderPull(pull);
      }

      gesture.pull = overTop ? pull : 0;

      // Without this WebKit still runs its own (absent) overscroll handling
      // and the page jitters between the two.
      if ((RUBBER || (REFRESH && overTop)) && event.cancelable) event.preventDefault();
    } else {
      gesture.pull = 0;

      if (bodyY) setBodyY(0);
      else renderPull(0);
    }
  },
  { passive: false }
);

// A lifted finger commits what the gesture promised; a cancelled touch — the
// system took the sequence away — must neither navigate nor reload.
function endGesture(commit) {
  if (!gesture) return;

  var ended = gesture;
  gesture = null;

  if (commit && ended.topTap && performance.now() - ended.startT <= TAP_MS) {
    scrollToTop();
  } else if (commit && REFRESH && ended.kind === "scroll" && ended.pull >= REFRESH_AT) {
    triggerRefresh();
    return;
  }

  // Whatever this gesture left displaced comes home, on every path — a sheet
  // parked by one branch must not wait for a later gesture to notice it. The
  // spring inherits the finger's velocity, damped the same way the drag is:
  // a fast release should snap, a gentle one should settle.
  if (bodyX) settle(bodyXChannel, bodyX, ended.velocityX * 0.4);
  if (bodyY) settle(bodyYChannel, bodyY, ended.velocityY * 0.4);
  else renderPull(0);
  if (innerChannel.x) settle(innerChannel, innerChannel.x, ended.velocityY * 0.4);
}

window.addEventListener("touchend", function () { endGesture(true); }, { passive: true });
window.addEventListener("touchcancel", function () { endGesture(false); }, { passive: true });

/* --- the flick that arrives at an edge -------------------------------------------- */

// Momentum scrolling ends at the document's edge with no touch on the glass,
// so the drag path above never sees it. The velocity is measured per frame
// and smoothed over the last three — raw scroll events arrive on their own
// erratic schedule, and a bounce seeded from one of their deltas stuttered.
if (RUBBER || INDICATOR) {
  var rideFrames = 0;
  var rideRaf = null;
  var rideY = 0;
  var rideSamples = [0, 0, 0];

  var rideMax = 0;

  function rideStep(now, dt) {
    var y = window.scrollY;
    var v = dt > 0 ? ((y - rideY) / dt) * 1000 : 0;

    rideSamples.shift();
    rideSamples.push(v);

    var smoothed = (rideSamples[0] + rideSamples[1] + rideSamples[2]) / 3;

    if (
      RUBBER &&
      !gesture &&
      !bodyYChannel.raf &&
      ((y <= 0 && smoothed < -400) || (y >= rideMax && smoothed > 400))
    ) {
      settle(bodyYChannel, 0, -smoothed * 0.3);
    }

    rideFrames = y === rideY ? rideFrames + 1 : 0;
    rideY = y;

    // The ride is over once the position has been still for a few frames.
    if (rideFrames > 6) {
      rideRaf = null;
      return;
    }

    rideRaf = window.requestAnimationFrame(function (next) {
      rideStep(next, next - now);
    });
  }

  window.addEventListener(
    "scroll",
    function () {
      // Every scroll event, not just the per-frame ride: a programmatic jump
      // fires exactly one and deserves its moment of pill too.
      showIndicator();

      if (rideRaf) return;

      rideY = window.scrollY;
      rideMax = maxScroll();
      rideFrames = 0;
      rideSamples = [0, 0, 0];
      rideRaf = window.requestAnimationFrame(function (now) {
        rideStep(now, 0);
      });
    },
    { passive: true }
  );
}

// Coming back through the back-forward cache restores this script's state
// exactly as the navigation froze it — possibly mid-gesture, with transforms
// still on the sheets. A restored page starts from zero.
window.addEventListener("pageshow", function (event) {
  if (!event.persisted) return;

  gesture = null;
  halt(bodyXChannel);
  halt(bodyYChannel);
  halt(innerChannel);
  halt(scrollChannel);
  setBodyX(0);
  setBodyY(0);

  if (innerEl) {
    innerEl.style.transform = "";
    innerEl = null;
  }
});
