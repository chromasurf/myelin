/*
 * cog_prelude.js — builds the `ctx` every userscript is wrapped around.
 *
 * The loader evaluates this to a function and calls it once per script, then hands
 * the result in as the script's only parameter. A userscript is otherwise plain
 * JavaScript: the file body is the script, because the loader already wraps it in a
 * function of its own.
 *
 * Three functions and one value, and that is on purpose — what a script can do with
 * the DOM, it does with the DOM:
 *
 *     ctx.config(name, default)   a setting, from the device or a trusted page
 *     ctx.on(name, handler)       listen for another script, or the application
 *     ctx.emit(name, detail)      announce to both
 *     ctx.css                     the manifest's shadow_css files, as text
 *
 * Each script sees its own settings and nothing else: not the page's, not another
 * script's. Nothing of it reaches `window`, which matters because the allowlist of
 * domain-block would otherwise be readable by every page the kiosk visits.
 *
 * This runs in the page's scope, like the script it serves, so it is no trust
 * boundary — `document.querySelector` and `JSON.parse` belong to the page and could
 * be anything. What carries the weight is `trusted`, which is decided in C and
 * arrives as a literal, and which is checked before the document is touched.
 *
 * Two consumers, one file: the Makefile turns it into a C byte array for the
 * extension, and the harness reads it to wrap the same way in a browser. Editing it
 * changes both.
 */
(function (id, trusted, device, css) {
  "use strict";

  /* --- settings ------------------------------------------------------------- */

  // A list-valued setting arrives in three shapes, depending on where it came from,
  // and all three look right where they are written:
  //
  //     <meta name="cog-statusbar-items" content="clock url">   "clock url"
  //     %{items: "clock url"}                                   "clock url"
  //     %{items: ["clock", "url"]}                              ["clock", "url"]
  //
  // Commas count as separators too, because a meta tag is typed into an HTML
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
  //
  // Two tag names are tried, this script's own and then the bare one. So cog-theme
  // reaches every script that asks for "theme", while cog-keyboard-theme overrides it
  // for the keyboard alone.
  function read(name, fallback) {
    if (device && Object.prototype.hasOwnProperty.call(device, name)) {
      fallback = device[name];
    }

    // Before any DOM access: a page that replaced querySelector cannot reach past
    // this, and neither can one that simply sets the tag.
    if (!trusted) return fallback;

    var el =
      document.querySelector('meta[name="cog-' + id + "-" + name + '"]') ||
      document.querySelector('meta[name="cog-' + name + '"]');

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
  //
  // Not exposed: emit covers it, and no script has wanted one without the other.
  function push(name, payload) {
    var socket = window.liveSocket;

    if (!socket || typeof socket.js !== "function") return false;

    var el = document.querySelector("[data-phx-main]");
    if (!el) return false;

    socket.js().push(el, "cog:" + name, { value: payload || {} });
    return true;
  }

  // What a script announces goes to the other scripts and to the application both,
  // without the script knowing whether either is listening. The name carries the
  // prefix in both directions, so an application deals in one spelling and can route
  // the whole layer through a single clause:
  //
  //     def handle_event("cog:" <> event, params, socket)
  //
  // Which it needs: an unmatched handle_event/3 is a FunctionClauseError in the view
  // process, not an ignored message. Returns whether the push happened — false on a
  // page with no LiveView, which is every foreign page the kiosk visits, and there it
  // is a no-op rather than a throw.
  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent("cog:" + name, { detail: detail || {} }));

    return push(name, detail);
  }

  // Both spellings of the same event, so a script does not care whether it was
  // another script or the application that sent it:
  //
  //     ctx.emit("screensaver:show")                       →  cog:screensaver:show
  //     push_event(socket, "cog:screensaver:show", %{})    →  phx:cog:screensaver:show
  function on(name, handler) {
    window.addEventListener("cog:" + name, handler);
    window.addEventListener("phx:cog:" + name, handler);
  }

  /* --- ran, which is not the same as built something ------------------------ */

  // Registered here rather than by each script, and before a single line of one has
  // run. This list means "was injected", not "put something on the screen" — a script
  // that looks at the page and decides to stay out of the way, as domain-block does
  // on a host it allows, must not read as one that failed to load.
  var registry = (window.cogUserscripts = window.cogUserscripts || { loaded: [] });
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
