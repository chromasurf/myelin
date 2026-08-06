/*
 * Navbar — a browser bar for a kiosk: home, reload and the address.
 *
 * No back and forward: this bar cannot keep a history of its own, because
 * sessionStorage is per origin and gone the moment the host changes. And no menu
 * button: a launcher or a tile grid is a full-screen view, and anything built that
 * way can listen for its own event while this stays a bar.
 *
 * It claims the top edge by pushing the document down, and so does statusbar.
 * Neither knows about the other, so whichever is injected second wins the padding.
 * Run one.
 *
 * It also takes both top corners, which is where debug-overlay's three-tap gesture
 * lives — a tap at 20,20 presses a button here instead of counting. Move such a
 * gesture to a bottom corner while this bar runs.
 *
 * Beta.
 *
 * Configuration
 *   height     px, tap targets scale with it              56
 *   items      which controls, in order: home reload url go   home reload url go
 *   home       where home goes                            /
 *   accent     any CSS colour                             ()
 *   autohide   start collapsed                            false
 *   font       "system" drops the bundled font            ()
 *   theme      light | dark | auto — shared with keyboard    auto
 *
 * Events
 *   emits    navbar:ready — carries the height
 *   listens  navbar:toggle
 */

var KNOWN = ["home", "reload", "url", "go"];
var COLLAPSED = 6;
var HEIGHT = ctx.config("height", 56);
var ITEMS = ctx.config("items", ["home", "reload", "url", "go"]);
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

// The clear button only earns its place while there is something to clear.
function syncClear() {
  if (clear && field) clear.classList.toggle("is-hidden", !field.value);
}

function addItem(name) {
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
