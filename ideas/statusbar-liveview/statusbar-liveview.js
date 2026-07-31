/*
 * Status Bar (LiveView) — embeds a LiveView served by your own application as a bar
 * across the top, on any page the kiosk visits. Not an iframe: it fetches the
 * statically rendered LiveView container and hangs it into the page, then lets the
 * LiveView client connect.
 *
 * ⚠ Read ideas/README.md before reaching for this. It needs cross-origin fetches
 * with credentials, a LiveView socket that accepts a foreign origin, and an asset
 * bundle that exposes the LiveView client as a global — three things a standard
 * Phoenix project does not do, and two of them weaken the application to get there.
 * On an https page it cannot work at all, because WebKit blocks mixed content to
 * loopback. The plain `statusbar` script needs no network and covers most of this.
 *
 * Configuration
 *   url      the LiveView, rendered with layout: false   http://localhost:4000/statusbar
 *   assets   LiveView client bundle, "" if the page has one   ()
 *   height   px                                          28
 *
 * Events
 *   emits   statusbar-liveview:ready, statusbar-liveview:failed
 */

var URL_ = ctx.config("url", "http://localhost:4000/statusbar");
var ASSETS = ctx.config("assets", "");
var HEIGHT = ctx.config("height", 28);

var host = document.createElement("div");
host.id = "cog-statusbar-lv";
document.body.appendChild(host);
host.style.height = HEIGHT + "px";
document.documentElement.style.paddingTop = HEIGHT + "px";

function fail(reason) {
  console.warn("[statusbar-liveview] " + reason);
  host.classList.add("is-failed");
  host.textContent = "statusbar: " + reason;
  ctx.emit("statusbar-liveview:failed", { reason: reason });
}

// Named for what it is: the one case that cannot be worked around from here.
function likelyMixedContent() {
  return location.protocol === "https:" && URL_.indexOf("http://") === 0;
}

function crossOrigin() {
  try {
    return new URL(URL_, location.href).origin !== location.origin;
  } catch (e) {
    return false;
  }
}

if (likelyMixedContent()) {
  fail("https page cannot reach " + URL_ + " (WebKit blocks mixed content, even to localhost)");
  return;
}

/* --- fetch the rendered container --------------------------------------- */

fetch(URL_, { credentials: "include", cache: "no-store" })
  .then(function (response) {
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.text();
  })
  .then(function (html) {
    // The response carries the statically rendered LiveView: a div with
    // data-phx-session (a signed token), data-phx-static and an id. Parsing
    // it out rather than assigning innerHTML keeps any surrounding markup —
    // and any <script> in it — from being executed.
    var doc = new DOMParser().parseFromString(html, "text/html");
    var container = doc.querySelector("[data-phx-session]");

    if (!container) {
      throw new Error("no LiveView container in the response — is layout: false set?");
    }

    host.appendChild(document.adoptNode(container));
    return loadClient();
  })
  .then(function () {
    connect();
  })
  .catch(function (err) {
    var message = String(err.message || err);

    // A CORS rejection arrives as a bare "Load failed" — the browser tells the
    // script nothing about why, on purpose. Mixed content and the page's CSP are
    // both ruled out by the time we get here, so name what is left rather than
    // leaving the one visible message pointing nowhere.
    if (crossOrigin() && /load failed|failed to fetch|networkerror/i.test(message)) {
      message +=
        " — " +
        URL_ +
        " is a different origin than this page, so it needs CORS headers that " +
        "allow this one; see ideas/README.md";
    }

    fail(message);
  });

/* --- LiveView client ----------------------------------------------------- */

function loadClient() {
  // Already on the page (we are on the app itself, or another script loaded
  // it) — nothing to do.
  if (window.liveSocket || !ASSETS) return Promise.resolve();

  return new Promise(function (resolve, reject) {
    var script = document.createElement("script");
    script.src = ASSETS;
    script.onload = resolve;
    // A CSP script-src violation lands here, as does a plain 404.
    script.onerror = function () {
      reject(new Error("could not load " + ASSETS + " (CSP or unreachable)"));
    };
    document.head.appendChild(script);
  });
}

function connect() {
  if (window.liveSocket) {
    // The page's own LiveSocket is already running and will adopt the
    // container on its next DOM scan.
    ctx.emit("statusbar-liveview:ready");
    return;
  }

  var LiveSocket = window.LiveSocket || (window.Phoenix && window.Phoenix.LiveSocket);
  var Socket = window.Phoenix && window.Phoenix.Socket;

  if (!LiveSocket || !Socket) {
    fail(
      "LiveView client not found — `assets` has to point at a bundle that puts " +
        "Phoenix.Socket and LiveSocket on window, which the default Phoenix " +
        "esbuild setup does not do"
    );
    return;
  }

  var origin = new window.URL(URL_, location.href).origin;
  var socket = new LiveSocket(origin + "/live", Socket, {});
  socket.connect();
  ctx.emit("statusbar-liveview:ready");
}
