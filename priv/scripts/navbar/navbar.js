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
 *   height     px, tap targets scale with it              48
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
var HEIGHT = ctx.config("height", 48);
var ITEMS = ctx.config("items", ["home", "reload", "url", "go"]);
var HOME = ctx.config("home", "/");
var ACCENT = ctx.config("accent", "");
var AUTOHIDE = ctx.config("autohide", false);
var THEME = ctx.config("theme", "auto");

var bar = document.createElement("div");
bar.id = "cog-navbar";

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
bar.style.setProperty("--cog-nav-h", HEIGHT + "px");
bar.style.setProperty("--cog-nav-collapsed", COLLAPSED + "px");

if (ACCENT) bar.style.setProperty("--cog-nav-accent", ACCENT);

if (ctx.config("font", "") === "system") {
  bar.style.setProperty("--cog-nav-font", '"Liberation Mono", monospace');
}

if (THEME === "light" || THEME === "dark") {
  bar.className = "cog-nav-" + THEME;
}

function button(name, label) {
  var el = document.createElement("button");
  el.type = "button";
  el.className = "cog-nav-btn cog-nav-" + name;
  el.setAttribute("aria-label", label);

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
  el.className = "cog-nav-sep";
  return el;
}

var field = null;

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

    field = document.createElement("input");
    field.type = "url";
    field.className = "cog-nav-url";
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

    field.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        go(normalise(field.value));
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        field.value = location.href;
        field.blur();
      }
    });

    bar.appendChild(field);
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
collar.className = "cog-nav-collar";
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
  if (!field || document.activeElement === field) return;
  if (location.href === shown) return;

  shown = location.href;
  field.value = shown;
}, 1000);

ctx.on("navbar:toggle", function () {
  setCollapsed(!collapsed);
});

ctx.emit("navbar:ready", { height: HEIGHT });
