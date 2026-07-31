/*
 * Screensaver — after a while without input, the Nerves logo drifts across a dark
 * screen and bounces off the edges, changing colour on every hit. Yes, like the
 * DVD logo.
 *
 * This dims the DOM, not the panel backlight. Backlight control goes through
 * /sys/class/backlight and belongs on the Elixir side — which is what the events
 * below are for: name them under `push` and your LiveView is told when to dim.
 *
 * Configuration
 *   idle    seconds without input before it shows      120
 *   mode    logo | clock | both                        both
 *   bg      any CSS colour                             #000
 *   speed   px per second                              70
 *   color   nerves | cycle | any CSS colour            cycle
 *
 * Events
 *   emits    screensaver:show, screensaver:hide
 *   listens  screensaver:show, screensaver:hide — so an application can put the
 *            screen to sleep or wake it without waiting for the timer. Sending
 *            one twice is harmless.
 */

var MODE = ctx.config("mode", "both");
var COLOR = ctx.config("color", "cycle");
var SPEED = ctx.config("speed", 70);
var IDLE_MS = ctx.config("idle", 120) * 1000;

var SHOW_LOGO = MODE === "logo" || MODE === "both";
var SHOW_CLOCK = MODE === "clock" || MODE === "both";

// Only genuine user input counts. LiveView patching the DOM must not keep the
// screen awake, which rules out MutationObserver and friends.
var WAKE_EVENTS = ["pointerdown", "pointermove", "mousemove", "keydown", "touchstart", "wheel"];

// How long after a wake a click still counts as part of that same tap. A tap
// is pointerdown, pointerup, click — well inside this; a second, deliberate
// tap is not.
var CLICK_GRACE_MS = 500;

// Inlined rather than fetched from nerves-project.org: a kiosk is usually
// offline, and on a foreign origin the request would be blocked anyway.
// Source: https://nerves-project.org/img/nerves.svg
var NERVES_SVG =
  '<svg viewBox="0 0 200 43" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nerves">' +
  '<g fill-rule="nonzero" fill="none">' +
  '<path d="M12.631.003H2.517A2.515 2.515 0 000 2.516v37.728a2.515 2.515 0 002.517 2.513h8.43a2.515 2.515 0 002.518-2.513v-1.51a2.515 2.515 0 00-2.518-2.513h-1.88a2.515 2.515 0 01-2.516-2.513V9.058a2.515 2.515 0 012.517-2.513h1.782c.531 0 1.046.167 1.476.477L35.673 23.9c1.664 1.203 3.994.016 3.994-2.036v-1.072c0-.793-.375-1.542-1.012-2.016L14.136.503a2.516 2.516 0 00-1.505-.5z" fill="#33647E"/>' +
  '<path d="M40.168 42.76h10.111a2.515 2.515 0 002.517-2.513V2.519A2.515 2.515 0 0050.28.006h-8.43a2.515 2.515 0 00-2.517 2.513v1.51a2.515 2.515 0 002.517 2.513h1.88a2.515 2.515 0 012.517 2.513v24.65a2.515 2.515 0 01-2.518 2.513h-1.781a2.525 2.525 0 01-1.477-.478L17.12 18.867c-1.664-1.203-3.994-.017-3.994 2.035v1.073c0 .793.375 1.541 1.013 2.016L38.66 42.263c.437.324.962.497 1.508.497z" fill="#42A7C6"/>' +
  '<g fill="#E8ECEE">' +
  '<path d="M70.727 20.319v8.43h-3.69V13.413h3.69l4.657 8.452v-8.452h3.69V28.75H75.27zM93.304 13.413h10.17v3.295h-6.182v2.682h5.35v3.273h-5.35v2.771h6.183v3.317H93.304V13.413zM126.93 13.413c.945 0 1.752.75 1.752 1.726v7.022c0 .932-.807 1.727-1.753 1.727h-.115l1.916 4.863h-3.921l-1.938-4.863h-1.708v4.863h-4.013V13.413h9.78zm-2.237 3.522c0-.114-.115-.227-.208-.227h-3.322v4.09h3.322c.093 0 .208-.114.208-.205v-3.658zM153.59 13.413l-4.634 15.338h-3.876l-4.52-15.338h4.289l2.169 9.749 2.607-9.75zM166.298 13.413h10.171v3.295h-6.182v2.682h5.35v3.273h-5.35v2.771h6.182v3.317H166.3zM189.82 25.434h5.837c.16 0 .253-.091.253-.205v-2.228c0-.114-.092-.205-.253-.205h-4.013c-1.083 0-1.823-.726-1.823-1.796v-5.794c0-1.067.737-1.796 1.823-1.796h8.05v3.295h-5.629c-.138 0-.23.113-.23.25v2.25c0 .091.092.205.23.205h4.014c1.083 0 1.823.726 1.823 1.795v5.75c0 1.068-.737 1.796-1.823 1.796h-8.258v-3.317z"/>' +
  "</g></g></svg>";

var overlay = document.createElement("div");
overlay.id = "cog-screensaver";
overlay.setAttribute("aria-hidden", "true");
overlay.style.background = ctx.config("bg", "#000");

var clock = null;
var date = null;
var logo = null;

if (SHOW_CLOCK) {
  var clockBox = document.createElement("div");
  // With the logo drifting over it, a full-strength clock turns both into an
  // unreadable tangle — so it steps back and lets the logo lead.
  clockBox.className = "cog-screensaver-clockbox" + (SHOW_LOGO ? " has-logo" : "");

  clock = document.createElement("div");
  clock.className = "cog-screensaver-time";

  date = document.createElement("div");
  date.className = "cog-screensaver-date";

  clockBox.appendChild(clock);
  clockBox.appendChild(date);
  overlay.appendChild(clockBox);
}

if (SHOW_LOGO) {
  logo = document.createElement("div");
  logo.className = "cog-screensaver-logo";
  logo.innerHTML = NERVES_SVG;
  if (COLOR !== "nerves" && COLOR !== "cycle") logo.style.color = COLOR;
  overlay.appendChild(logo);
}

document.body.appendChild(overlay);

var idleTimer = null;
var tickTimer = null;
var frame = null;
var active = false;

/* --- clock ------------------------------------------------------------ */

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function render() {
  if (!clock) return;

  var now = new Date();

  // Follow the page's language rather than the system locale: Nerves images
  // typically run with LANG=en_US.UTF-8, which would print an English date
  // under a German kiosk app.
  var locale = document.documentElement.lang || undefined;

  clock.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes());
  date.textContent = now.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long"
  });
}

/* --- bouncing logo ---------------------------------------------------- */

var pos = { x: 0, y: 0 };
var vel = { x: 0, y: 0 };
var hue = 0;
var lastFrame = null;

function logoSize() {
  return { w: logo.offsetWidth || 240, h: logo.offsetHeight || 52 };
}

function startBouncing() {
  var size = logoSize();
  var maxX = Math.max(0, window.innerWidth - size.w);
  var maxY = Math.max(0, window.innerHeight - size.h);

  pos.x = Math.random() * maxX;
  pos.y = Math.random() * maxY;

  // A diagonal that is never axis-aligned, so it actually traverses the screen
  // instead of sliding along one edge.
  var angle = (Math.random() * 0.5 + 0.25) * Math.PI;
  var dir = Math.random() < 0.5 ? -1 : 1;
  vel.x = Math.cos(angle) * SPEED * dir;
  vel.y = Math.sin(angle) * SPEED * (Math.random() < 0.5 ? -1 : 1);

  lastFrame = null;
  frame = window.requestAnimationFrame(step);
}

function bounced() {
  if (COLOR !== "cycle") return;
  hue = (hue + 47) % 360;
  logo.style.filter = "hue-rotate(" + hue + "deg)";
}

function step(now) {
  if (!active) return;
  if (lastFrame === null) lastFrame = now;

  var dt = Math.min((now - lastFrame) / 1000, 0.1); // clamp after a stall
  lastFrame = now;

  var size = logoSize();
  var maxX = Math.max(0, window.innerWidth - size.w);
  var maxY = Math.max(0, window.innerHeight - size.h);

  pos.x += vel.x * dt;
  pos.y += vel.y * dt;

  if (pos.x <= 0) {
    pos.x = 0;
    vel.x = Math.abs(vel.x);
    bounced();
  } else if (pos.x >= maxX) {
    pos.x = maxX;
    vel.x = -Math.abs(vel.x);
    bounced();
  }

  if (pos.y <= 0) {
    pos.y = 0;
    vel.y = Math.abs(vel.y);
    bounced();
  } else if (pos.y >= maxY) {
    pos.y = maxY;
    vel.y = -Math.abs(vel.y);
    bounced();
  }

  logo.style.transform =
    "translate(" + Math.round(pos.x) + "px," + Math.round(pos.y) + "px)";
  frame = window.requestAnimationFrame(step);
}

/* --- show and hide ---------------------------------------------------- */

function show() {
  if (active) return;
  active = true;

  render();
  overlay.classList.add("is-visible");

  // On the minute: nothing below it is displayed, and a kiosk that is idle
  // should stay idle.
  if (clock) tickTimer = window.setInterval(render, 60000);
  if (logo) startBouncing();

  ctx.emit("screensaver:show");
}

function hide() {
  if (!active) return;
  active = false;

  overlay.classList.remove("is-visible");
  window.clearInterval(tickTimer);
  tickTimer = null;

  if (frame) {
    window.cancelAnimationFrame(frame);
    frame = null;
  }

  ctx.emit("screensaver:hide");
}

function restartIdleTimer() {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(show, IDLE_MS);
}

var wokeAt = 0;

function onActivity(event) {
  if (active) {
    // Swallow the gesture that wakes the screen, so the tap does not also
    // press whatever sits underneath. Pointer movement has nothing to
    // swallow, so it only wakes.
    if (event.cancelable && event.type !== "mousemove" && event.type !== "pointermove") {
      event.preventDefault();
      event.stopPropagation();
    }

    hide();
    wokeAt = Date.now();
  }

  restartIdleTimer();
}

// Preventing the pointerdown above is not enough. click is a separate event
// dispatched after pointerup, by which time the overlay is gone — so it
// hit-tests to whatever was underneath and a link or a button activates. On a
// kiosk that is the whole problem in one sentence: someone taps a dark panel
// to wake it and thereby presses the button their finger was over.
window.addEventListener(
  "click",
  function (event) {
    if (!wokeAt || Date.now() - wokeAt > CLICK_GRACE_MS) return;

    wokeAt = 0;
    event.preventDefault();
    event.stopPropagation();
  },
  true
);

WAKE_EVENTS.forEach(function (name) {
  // Capture phase, so the overlay sees the event before the page does.
  window.addEventListener(name, onActivity, { capture: true, passive: false });
});

/* --- being told, rather than deciding --------------------------------- */

// show() and hide() emit the very names these listen for, so each re-enters
// its own function once. The `active` guard at the top of both makes that a
// no-op — which is also why an application can send show twice.
ctx.on("screensaver:show", function () {
  show();
});

ctx.on("screensaver:hide", function () {
  hide();
  // hide() leaves the countdown alone on purpose: onActivity restarts it after
  // a wake, because a wake is activity. Being told to go away is not, so
  // without this the screensaver would leave and never come back.
  restartIdleTimer();
});

// Pausing the countdown while the page is hidden avoids coming back to a
// screensaver that ran down in the background.
document.addEventListener("visibilitychange", function () {
  if (document.hidden) window.clearTimeout(idleTimer);
  else restartIdleTimer();
});

window.addEventListener("resize", function () {
  if (active && logo) startBouncing();
});

restartIdleTimer();
