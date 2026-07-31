/*
 * Display Lock — covers the screen until a PIN is entered.
 *
 * ⚠ This is a *visual* lock, not access control. The PIN sits in the DOM, and anyone
 * who can reach a keyboard, the browser's inspector, or simply another URL walks
 * around it. It exists so a display in a public spot is not adjusted in passing.
 * Real protection belongs on the Elixir side, in front of the pages themselves.
 *
 * Configuration
 *   pin        the PIN                                    0000
 *   after      seconds idle before locking, 0 = never     0
 *   on-load    lock immediately                           false
 *   message    what the panel says                        Locked
 *   attempts   wrong tries before a pause                 3
 *   timeout    seconds of pause after that                30
 *
 * Events
 *   emits    display-lock:locked, display-lock:unlocked, display-lock:failed
 *   listens  display-lock:lock, display-lock:unlock
 */

// The PIN is a string even when it arrives as %{pin: 4711} from the device
// config, or `entered === PIN` compares "4711" with 4711 and is false however
// carefully it is typed — with nothing to say why, until the attempt penalty
// takes over and a visual lock nobody can open needs a firmware restart.
var PIN = String(ctx.config("pin", "0000"));
var IDLE_S = ctx.config("after", 0);
var MESSAGE = ctx.config("message", "Locked");
var MAX_ATTEMPTS = ctx.config("attempts", 3);
var PENALTY_S = ctx.config("timeout", 30);

var entered = "";
var attempts = 0;
var penaltyUntil = 0;
var idleTimer = null;

/* --- markup ------------------------------------------------------------ */

// The lock lives in a shadow root, declared above. It has to look the same
// wherever the kiosk has ended up, and a `* { font-family: cursive }` or a
// `div { display: inline }` from the page underneath is enough to take it
// apart. It cuts both ways — nothing in here reaches the page either.
var overlay = document.createElement("div");
overlay.id = "myelin-lock";

var root = overlay.attachShadow({ mode: "open" });

// The stylesheet comes as text rather than being injected into the page: a <style> in
// the page's head does not reach inside a shadow root.
var style = document.createElement("style");
style.textContent = ctx.css;
root.appendChild(style);

// The dialog semantics belong to the panel now. On the host they would be
// announced from outside the shadow boundary, where the content they describe
// is not reachable.
var dialog = document.createElement("div");
dialog.className = "myelin-lock-root";
dialog.setAttribute("role", "dialog");
dialog.setAttribute("aria-modal", "true");
dialog.setAttribute("aria-label", MESSAGE);

var box = document.createElement("div");
box.className = "myelin-lock-box";

var title = document.createElement("div");
title.className = "myelin-lock-title";
title.textContent = MESSAGE;

var dots = document.createElement("div");
dots.className = "myelin-lock-dots";

var hint = document.createElement("div");
hint.className = "myelin-lock-hint";

var pad = document.createElement("div");
pad.className = "myelin-lock-pad";

["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "ok"].forEach(function (key) {
  var el = document.createElement("div");
  el.setAttribute("role", "button");
  el.className = "myelin-lock-key";
  el.dataset.key = key;
  el.textContent = key === "clear" ? "C" : key === "ok" ? "OK" : key;
  if (key === "clear" || key === "ok") el.classList.add("myelin-lock-key-special");
  pad.appendChild(el);
});

box.appendChild(title);
box.appendChild(dots);
box.appendChild(pad);
box.appendChild(hint);
dialog.appendChild(box);
root.appendChild(dialog);
document.body.appendChild(overlay);

/* --- state -------------------------------------------------------------- */

function locked() {
  return overlay.classList.contains("is-visible");
}

function renderDots() {
  dots.textContent = "";
  var count = Math.max(entered.length, PIN.length);

  for (var i = 0; i < count; i++) {
    var dot = document.createElement("span");
    dot.className = "myelin-lock-dot" + (i < entered.length ? " is-filled" : "");
    dots.appendChild(dot);
  }
}

function renderHint() {
  var left = Math.ceil((penaltyUntil - Date.now()) / 1000);

  if (left > 0) {
    hint.textContent = "Too many attempts — " + left + "s";
    hint.className = "myelin-lock-hint is-error";
    return;
  }

  if (attempts > 0) {
    hint.textContent = "Wrong PIN (" + attempts + "/" + MAX_ATTEMPTS + ")";
    hint.className = "myelin-lock-hint is-error";
    return;
  }

  hint.textContent = "";
  hint.className = "myelin-lock-hint";
}

function lock() {
  if (locked()) return;

  entered = "";
  renderDots();
  renderHint();
  overlay.classList.add("is-visible");
  window.clearTimeout(idleTimer);
  ctx.emit("display-lock:locked");
}

function unlock() {
  if (!locked()) return;

  entered = "";
  attempts = 0;
  penaltyUntil = 0;
  overlay.classList.remove("is-visible");
  restartIdleTimer();
  ctx.emit("display-lock:unlocked");
}

function submit() {
  if (Date.now() < penaltyUntil) return;

  if (entered === PIN) {
    unlock();
    return;
  }

  attempts++;
  entered = "";

  if (attempts >= MAX_ATTEMPTS) {
    penaltyUntil = Date.now() + PENALTY_S * 1000;
    attempts = 0;

    // Count the pause down visibly, so it does not look like a dead screen.
    var countdown = window.setInterval(function () {
      renderHint();
      if (Date.now() >= penaltyUntil) {
        window.clearInterval(countdown);
        renderHint();
      }
    }, 500);
  }

  box.classList.remove("is-shaking");
  // Reading offsetWidth forces a reflow, so the animation restarts even when
  // the class is re-added within the same frame.
  void box.offsetWidth;
  box.classList.add("is-shaking");

  renderDots();
  renderHint();
  ctx.emit("display-lock:failed");
}

function press(key) {
  if (Date.now() < penaltyUntil) return;

  if (key === "clear") {
    entered = "";
  } else if (key === "ok") {
    submit();
    return;
  } else if (entered.length < 32) {
    entered += key;
  }

  renderDots();

  // Auto-submit once the entered length matches the PIN — one less tap, and
  // it matches what people expect from a phone lock screen.
  if (entered.length === PIN.length) submit();
}

/* --- input -------------------------------------------------------------- */

// On the shadow root, not on the host. A listener on the host sees a
// *retargeted* event.target — the host itself — so closest() would look for a
// key outside the shadow tree and never find one. Inside the root the target
// is the element that was actually hit.
root.addEventListener("pointerdown", function (event) {
  event.preventDefault();
});

root.addEventListener("click", function (event) {
  var key = event.target.closest(".myelin-lock-key");
  if (key) press(key.dataset.key);
});

window.addEventListener(
  "keydown",
  function (event) {
    if (!locked()) return;

    // While locked, the page must not see any keystrokes.
    event.stopPropagation();

    if (/^[0-9]$/.test(event.key)) press(event.key);
    else if (event.key === "Backspace" || event.key === "Escape") press("clear");
    else if (event.key === "Enter") press("ok");
    else return;

    event.preventDefault();
  },
  true
);

/* --- triggers ----------------------------------------------------------- */

function restartIdleTimer() {
  if (!IDLE_S) return;
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(lock, IDLE_S * 1000);
}

if (IDLE_S) {
  ["pointerdown", "keydown", "touchstart", "wheel", "mousemove"].forEach(function (name) {
    window.addEventListener(
      name,
      function () {
        if (!locked()) restartIdleTimer();
      },
      { capture: true, passive: true }
    );
  });

  restartIdleTimer();
}

ctx.on("display-lock:lock", lock);
ctx.on("display-lock:unlock", unlock);

if (ctx.config("on-load", false)) lock();
