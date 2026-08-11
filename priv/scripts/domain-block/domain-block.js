/*
 * Domain Block — covers a page that is not on the allowlist, and offers the way
 * back to the app.
 *
 * ⚠ This is not a network filter. At document_end the page has already loaded: its
 * requests went out, its scripts ran, its trackers fired. What this does is stop
 * someone at the terminal from *using* it. For real blocking, Cog takes
 * --content-filter with a WebKitUserContentFilter rule set, which refuses the
 * requests in the first place. This is the visible half of that, not a substitute.
 *
 * It has to work on pages that know nothing about it, so everything comes from the
 * device — a visited page cannot configure it, and cannot switch it off either,
 * because meta tags only count on an origin the device trusts.
 *
 * Configuration
 *   allowlist   host patterns, see below                ()
 *   home        URL for the way back, "" for no link    ()
 *   message     what the panel says                     This page is not part of the terminal.
 *
 * Allowlist entries are host patterns, not the match patterns of "matches" — no
 * scheme, no path, because this is a host comparison and a second syntax to learn
 * would be a poor trade:
 *
 *   localhost:4000    that host on that port
 *   example.com       that host, any port
 *   *.example.com     any subdomain, and the bare domain too
 *
 * Events
 *   emits   domain-block:blocked — carries the host
 */

var ELEMENT_ID = "myelin-domain-block";
var ALLOWLIST = ctx.config("allowlist", []);

/* --- is this host allowed? -------------------------------------------- */

function hostMatches(pattern, host) {
  if (pattern === "*") return true;

  // A pattern without a port matches any port; with one it must be that port.
  if (pattern.indexOf(":") === -1) host = host.replace(/:\d+$/, "");

  pattern = pattern.toLowerCase();
  host = host.toLowerCase();

  if (pattern.slice(0, 2) === "*.") {
    var domain = pattern.slice(2);
    // "*.example.com" covers example.com as well, as in a match pattern.
    return host === domain || host.slice(-(domain.length + 1)) === "." + domain;
  }

  return host === pattern;
}

function allowed(host) {
  for (var i = 0; i < ALLOWLIST.length; i++) {
    if (hostMatches(ALLOWLIST[i], host)) return true;
  }

  return false;
}

if (!ALLOWLIST.length) {
  console.log("[domain-block] no allowlist configured, staying out of the way");
  return;
}

if (allowed(location.host)) return;

/* --- the block page --------------------------------------------------- */

// Mounted here rather than declared, because doing nothing is this script's
// normal outcome and its :host rules cover the screen.
//
// A shadow root, because this lands on pages whose CSS would otherwise reshape
// it — a `* { font-family: cursive }` or a `div { display: inline }` is enough.
// It cuts both ways: nothing in here touches the page either.
var host = document.createElement("div");
host.id = ELEMENT_ID;

var root = host.attachShadow({ mode: "open" });

// The stylesheet arrives as text rather than being injected into the page, because a
// <style> in the page's head would not reach inside a shadow root at all. That is
// what "shadow_css" in the manifest asks for.
var style = document.createElement("style");
style.textContent = ctx.css;
root.appendChild(style);

var panel = document.createElement("div");
panel.className = "panel";
panel.setAttribute("role", "alertdialog");
panel.setAttribute("aria-modal", "true");

var text = document.createElement("p");
text.className = "message";
text.textContent = ctx.config("message", "This page is not part of the terminal.");
panel.appendChild(text);

var where = document.createElement("p");
where.className = "host";
where.textContent = location.host;
panel.appendChild(where);

var HOME = ctx.config("home", "");

if (HOME) {
  var back = document.createElement("a");
  back.className = "home";
  back.href = HOME;
  back.textContent = "Back to the app";
  panel.appendChild(back);
}

root.appendChild(panel);
document.body.appendChild(host);

["click", "keydown", "wheel", "touchstart"].forEach(function (name) {
  window.addEventListener(
    name,
    function (event) {
      // event.target of anything inside the shadow root is retargeted to the
      // host out here, so this is also what lets Tab and Enter work *inside*
      // the panel while cancelling them everywhere else.
      if (host.contains(event.target)) return;

      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    },
    { capture: true, passive: false }
  );
});

// Nothing underneath should be reachable while this is up, including by
// keyboard. That takes two things: focus has to move *into* the panel, and it
// has to stay there. Nothing moves it on its own — the panel lives in a shadow
// root that nothing ever focused — and the listener above cancels keydown
// outside the host, which takes Tab's own focus navigation with it. So on a
// terminal with a physical keyboard attached, and a USB scanner or a keypad
// counts as one, the way back would be unreachable: not by Tab, not by Enter,
// touch only.
var focusTarget = panel.querySelector("a.home") || panel;

if (focusTarget === panel) panel.tabIndex = -1;
focusTarget.focus();

// Tab inside the panel eventually walks off its end and into the page, where
// there is nothing left to reach. Pull it back rather than trying to enumerate
// what is tabbable in a page this script knows nothing about.
window.addEventListener(
  "focusin",
  function (event) {
    if (host.contains(event.target)) return;
    focusTarget.focus();
  },
  true
);

ctx.emit("domain-block:blocked", { host: location.host });
