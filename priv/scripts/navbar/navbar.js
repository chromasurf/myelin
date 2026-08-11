/*
 * Navbar — a browser bar for a kiosk: back, forward, home, reload and the address.
 *
 * **Back and forward do not use the browser's history.**
 * On this Cog/WPE stack a history
 * navigation leaves the panel showing the old page's last frame while the web
 * process has moved on — the compositor stops getting frames and the terminal
 * looks frozen; a plain location load repaints reliably. And a bar cannot keep a
 * history of its own in sessionStorage, which is per origin and gone the moment
 * the host changes.
 *
 * So it keeps its own trail of visited URLs in `window.name`, the one string that
 * survives a cross-origin navigation, and walks it with `location.href`. WebKit
 * wipes `window.name` at an origin boundary, so a fresh trail plants
 * `document.referrer` as its first entry — the way back across that boundary is
 * the referrer's origin, which is what the policy leaves of it. The cost:
 * `window.name` belongs to this script while it runs, forward never crosses an
 * origin boundary, every step is a real load, and the browser's own history grows
 * instead of unwinding.
 *
 * It claims the top edge by pushing the document down, and so does statusbar.
 * Neither knows about the other, so whichever is injected second wins the padding.
 * Run one.
 *
 * Configuration
 *   height     px, tap targets scale with it              56
 *   items      which controls, in order                   back forward home reload url go
 *   home       where home goes — an absolute URL          /
 *   accent     any CSS colour                             ()
 *   autohide   start collapsed                            false
 *   font       "system" drops the bundled font            ()
 *   theme      light | dark | auto — shared with keyboard    auto
 *
 * Events
 *   emits    navbar:ready — carries the height
 *   emits    navbar:back {to}, navbar:forward {to} — just before navigating
 *   listens  navbar:toggle
 */

var KNOWN = ["back", "forward", "home", "reload", "url", "go"];
var COLLAPSED = 6;
var HEIGHT = ctx.config("height", 56);
var ITEMS = ctx.config("items", ["back", "forward", "home", "reload", "url", "go"]);
// "/" is only right for a kiosk that never leaves its own application. The
// moment one visits a foreign page, "/" is *that site's* front page — so the
// button meant to bring someone back takes them further into wherever they got
// lost. Configure an absolute URL on any kiosk that browses.
var HOME = ctx.config("home", "/");
var ACCENT = ctx.config("accent", "");
var AUTOHIDE = ctx.config("autohide", false);
var THEME = ctx.config("theme", "auto");

var bar = document.createElement("div");
bar.id = "myelin-navbar";

/* --- navigation ------------------------------------------------------- */

function go(url) {
  if (url) location.href = url;
}

/* --- the trail back and forward walk ------------------------------------ */

// window.name, because it is the one string that survives navigation across
// origins. The invariant: the trail's top is always the current page — each page
// records itself when this script starts, never on the way out (a write during
// pagehide is lost in the very navigation it tries to describe). `myelinAhead` is
// what going back left behind, for forward to walk again; any ordinary
// navigation discards it, the way every browser does.
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

var arrival = readTrail();
var arrivalTrail = arrival.myelinTrail;

// The trail dies at every origin boundary: WebKit wipes window.name on a
// cross-origin navigation. The referrer still names where we came from — origin
// only, by policy, but that is exactly the step back — so a fresh trail gets it
// planted underneath. From there the same-origin part of the journey accumulates
// on top as usual.
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
  ctx.emit("navbar:back", { to: target });
  go(target);
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
  ctx.emit("navbar:forward", { to: target });
  go(target);
}

// Nothing to go back to on the first page of a session, and nothing forward
// until something has been left behind. A button that cannot do anything says so
// rather than looking broken when tapped.
function syncHistoryButtons() {
  var state = readTrail();
  var trail = state.myelinTrail;
  var behind = 0;

  for (var i = 0; i < trail.length; i++) {
    if (trail[i] !== location.href) behind++;
  }

  if (backButton) backButton.disabled = behind === 0;
  if (forwardButton) forwardButton.disabled = state.myelinAhead.length === 0;
}

// What someone types into an address bar is not a URL yet. "nerves-project.org"
// has to become https://, or the browser resolves it as a relative path and the
// kiosk lands on a 404 of the page it was already on. A leading slash is meant
// as a path and stays one.
function normalise(input) {
  var text = String(input || "").trim();

  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  if (text.charAt(0) === "/") return text;

  return "https://" + text;
}

/* --- the bar ---------------------------------------------------------- */

bar.setAttribute("role", "toolbar");
bar.setAttribute("aria-label", "Address bar");
bar.style.setProperty("--myelin-nav-h", HEIGHT + "px");
bar.style.setProperty("--myelin-nav-collapsed", COLLAPSED + "px");

if (ACCENT) bar.style.setProperty("--myelin-nav-accent", ACCENT);

if (ctx.config("font", "") === "system") {
  bar.style.setProperty("--myelin-nav-font", '"Liberation Mono", monospace');
}

if (THEME === "light" || THEME === "dark") {
  bar.className = "myelin-nav-" + THEME;
}

// Inline SVG rather than glyphs or border tricks: the kiosk images ship
// Liberation, which has no ⌂ ⟳ ▸ — and geometry built from borders bends as
// soon as a page's reset reaches into transform. currentColor keeps the theme
// in charge; the stroke styling lives in one CSS rule.
var ICONS = {
  home:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M3.5 11.5 12 4l8.5 7.5" />' +
    '<path d="M6 10.5V20h4.5v-5.5h3V20H18v-9.5" /></svg>',
  reload:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M20 12a8 8 0 1 1-2.34-5.66" />' +
    '<path d="M20 3.5v5h-5" /></svg>',
  go:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M5 12h13" /><path d="M12 6l6 6-6 6" /></svg>',
  back:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M19 12H6" /><path d="M12 6l-6 6 6 6" /></svg>',
  forward:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M5 12h13" /><path d="M12 6l6 6-6 6" /></svg>',
  clear:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M7 7l10 10" /><path d="M17 7 7 17" /></svg>'
};

function button(name, label) {
  var el = document.createElement("button");
  el.type = "button";
  el.className = "myelin-nav-btn myelin-nav-" + name;
  el.setAttribute("aria-label", label);
  el.innerHTML = ICONS[name] || "";

  // Without this, tapping a button moves focus out of the address field first;
  // the field's own blur handling would then run before the click and Go would
  // read a value that is already being reverted. The keyboard needs the same
  // guard over its keys, for the same reason.
  el.addEventListener("pointerdown", function (event) {
    event.preventDefault();
  });

  return el;
}

function separator() {
  var el = document.createElement("span");
  el.className = "myelin-nav-sep";
  return el;
}

var field = null;
var clear = null;
var backButton = null;
var forwardButton = null;

// The clear button only earns its place while there is something to clear.
function syncClear() {
  if (clear && field) clear.classList.toggle("is-hidden", !field.value);
}

function addItem(name) {
  if (name === "back") {
    backButton = button("back", "Back");
    backButton.addEventListener("click", goBack);
    bar.appendChild(backButton);
    return;
  }

  if (name === "forward") {
    forwardButton = button("forward", "Forward");
    forwardButton.addEventListener("click", goForward);
    bar.appendChild(forwardButton);
    return;
  }

  if (name === "home") {
    var home = button("home", "Home");
    home.addEventListener("click", function () {
      go(HOME);
    });
    bar.appendChild(home);
    return;
  }

  if (name === "reload") {
    var reload = button("reload", "Reload");
    reload.addEventListener("click", function () {
      location.reload();
    });
    bar.appendChild(reload);
    return;
  }

  if (name === "url") {
    bar.appendChild(separator());

    // Field and clear button share a wrapper, so the button can sit inside the
    // field's right edge without leaving the flex row.
    var wrap = document.createElement("div");
    wrap.className = "myelin-nav-urlwrap";

    field = document.createElement("input");
    field.type = "url";
    field.className = "myelin-nav-url";
    field.setAttribute("aria-label", "Address");
    field.setAttribute("spellcheck", "false");
    field.setAttribute("autocomplete", "off");
    field.setAttribute("autocapitalize", "off");
    field.dir = "ltr";
    field.value = location.href;

    field.addEventListener("focus", function () {
      // Select all: on a touch panel the caret lands wherever the finger did,
      // and appending to an existing URL is never what someone wants.
      field.select();
    });

    field.addEventListener("input", syncClear);

    field.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        go(normalise(field.value));
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        field.value = location.href;
        syncClear();
        field.blur();
      }
    });

    // The pointerdown guard in button() keeps the field's focus through the
    // tap, so clearing leaves the keyboard up and the caret in the empty field.
    clear = button("clear", "Clear the address");
    clear.addEventListener("click", function () {
      field.value = "";
      syncClear();
      field.focus();
    });

    wrap.appendChild(field);
    wrap.appendChild(clear);
    bar.appendChild(wrap);
    syncClear();
    return;
  }

  if (name === "go") {
    var submit = button("go", "Open address");
    submit.addEventListener("click", function () {
      if (field) go(normalise(field.value));
    });
    bar.appendChild(submit);
  }
}

ITEMS.forEach(function (name) {
  if (KNOWN.indexOf(name) >= 0) addItem(name);
});

syncHistoryButtons();

/* --- collapsing ------------------------------------------------------- */

var collapsed = false;

function setCollapsed(next) {
  collapsed = !!next;
  bar.classList.toggle("is-collapsed", collapsed);

  // Pushing the document down rather than floating above it: the covered first
  // row of a kiosk app would otherwise be permanently unreachable. On the root
  // element, so a page managing its own body padding is unaffected.
  document.documentElement.style.paddingTop = (collapsed ? COLLAPSED : HEIGHT) + "px";

  if (collapsed && field) field.blur();
}

// The collar is what is left of the bar when it is collapsed, and the only way
// back — so it exists whether autohide is on or not.
var collar = document.createElement("button");
collar.type = "button";
collar.className = "myelin-nav-collar";
collar.setAttribute("aria-label", "Show the address bar");
collar.addEventListener("click", function () {
  setCollapsed(false);
});
bar.appendChild(collar);
document.body.appendChild(bar);

setCollapsed(AUTOHIDE);

// One frame later, so the transition has a state to come from.
window.requestAnimationFrame(function () {
  bar.classList.add("is-in");
});

/* --- staying in step with the page ------------------------------------ */

// A poll, not a listener: pushState fires no event, and a kiosk app doing
// client-side routing changes the address without any of popstate, hashchange
// or load. Skipping it while the field has focus keeps it from overwriting what
// someone is typing.
var shown = location.href;

window.setInterval(function () {
  // A page that rebuilds its body takes the bar with it — put it back. The
  // padding goes with the re-attach, because whatever replaced the body has
  // usually reset the root's inline style too.
  if (!bar.isConnected) {
    document.body.appendChild(bar);
    setCollapsed(collapsed);
  }

  if (!field || document.activeElement === field) return;
  if (location.href === shown) return;

  shown = location.href;
  field.value = shown;
  syncClear();
}, 1000);

ctx.on("navbar:toggle", function () {
  setCollapsed(!collapsed);
});

ctx.emit("navbar:ready", { height: HEIGHT });
