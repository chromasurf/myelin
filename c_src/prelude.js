/*
 * prelude.js — builds the `ctx` every script is wrapped around.
 *
 * The loader evaluates this to a function and calls it once per script, then hands
 * the result in as the script's only parameter. A script is otherwise plain
 * JavaScript: the file body is the script, because the loader already wraps it in a
 * function of its own.
 *
 *     ctx.config(name, default)   a setting, from the device or a trusted page
 *     ctx.on(name, handler)       listen for another script, or the application
 *     ctx.emit(name, detail)      announce to both
 *     ctx.css                     the manifest's shadow_css files, as text
 *
 */
(function (id, trusted, device, css) {
  "use strict";

  /* --- settings ------------------------------------------------------------- */

  // A list-valued setting arrives in three shapes
  //
  //     <meta name="myelin-statusbar-items" content="clock url">   "clock url"
  //     %{items: "clock url"}                                   "clock url"
  //     %{items: ["clock", "url"]}                              ["clock", "url"]
  //
  // Commas count as separators, because a meta tag is typed into an HTML
  // attribute where "clock,url" is natural.
  function toWords(value) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);

    return String(value == null ? "" : value)
      .split(/[\s,]+/)
      .filter(Boolean);
  }

  // The default decides how a value is read, which is the whole reason to pass one.
  // A meta tag can only ever carry a string, while the device configuration carries
  // real numbers, booleans and lists — so %{numbers: true} and content="1" have to
  // mean the same thing, and no script should have to remember that.
  function coerce(value, fallback) {
    if (typeof fallback === "number") {
      var n = parseFloat(value);
      return isFinite(n) ? n : fallback;
    }

    if (typeof fallback === "boolean") {
      return value === true || value === "1" || value === "true";
    }

    if (Array.isArray(fallback)) return toWords(value);

    return value == null ? fallback : String(value);
  }

  // Where a value comes from, least specific first: the default the script passed,
  // then the device configuration, then a <meta> tag — and the tag only on an origin
  // the device trusts.
  function read(name, fallback) {
    if (device && Object.prototype.hasOwnProperty.call(device, name)) {
      fallback = device[name];
    }

    // Before any DOM access: a page that replaced querySelector cannot reach past
    // this, and neither can one that simply sets the tag.
    if (!trusted) return fallback;

    var el =
      document.querySelector('meta[name="myelin-' + id + "-" + name + '"]') ||
      document.querySelector('meta[name="myelin-' + name + '"]');

    var v = el && el.content.trim();
    if (!v) return fallback;

    // A value that looks like JSON is parsed, so a tag can carry a list or an object.
    // Anything else stays the string it was.
    if (v[0] === "{" || v[0] === "[") {
      try {
        return JSON.parse(v);
      } catch (e) {
        /* fall through to the raw string */
      }
    }

    return v;
  }

  function config(name, fallback) {
    return coerce(read(name, fallback), fallback);
  }

  /* --- events --------------------------------------------------------------- */

  // Pushes into a LiveView on the page. Needs an element that belongs to it —
  // liveSocket resolves the receiving view from the element it is given — and
  // [data-phx-main] is the one every LiveView page has.
  function push(name, payload) {
    var socket = window.liveSocket;

    if (!socket || typeof socket.js !== "function") return false;

    var el = document.querySelector("[data-phx-main]");
    if (!el) return false;

    socket.js().push(el, "myelin:" + name, { value: payload || {} });
    return true;
  }

  // Emit JS CustomEvent and LiveView Events
  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent("myelin:" + name, { detail: detail || {} }));

    return push(name, detail);
  }

  // Listen to JavaScript Events and accept both prefixes
  //
  //     ctx.emit("screensaver:show")                       →  myelin:screensaver:show
  //     push_event(socket, "myelin:screensaver:show", %{})    →  phx:myelin:screensaver:show
  function on(name, handler) {
    window.addEventListener("myelin:" + name, handler);
    window.addEventListener("phx:myelin:" + name, handler);
  }

  // Registered globally rather than by each script, and before a single line of one has
  // run.
  var registry = (window.myelin = window.myelin || { loaded: [] });
  if (registry.loaded.indexOf(id) === -1) registry.loaded.push(id);

  return {
    config: config,
    on: on,
    emit: emit,
    // Contents of the manifest's shadow_css files, for a script that puts them in a
    // shadow root itself. Empty unless the manifest lists any.
    css: css || ""
  };
})
