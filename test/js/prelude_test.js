// Tests for c_src/prelude.js — the `ctx` every script is wrapped around.
//
// The settings path needs no DOM: ctx.config checks `trusted` before it touches
// the document, so with trusted: false the whole coercion runs against nothing but
// the device configuration. That is why these tests need no jsdom and no browser.
// Only the meta-tag half gets a one-line querySelector stub.
//
// Not tested here: onFocus, which is seventy lines of shadow-root focus behaviour
// and needs a real DOM to say anything true about. That one lives in keyboard.js
// and is exercised by hand in the harness.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "c_src", "prelude.js"),
  "utf8"
);

// The file is a parenthesised function expression, exactly as injector.c evaluates
// it, so eval hands back the function itself.
const prelude = eval(SOURCE);

// A `document` whose only job is to answer for the tags a test sets up.
function withTags(tags) {
  return {
    querySelector(selector) {
      const name = /meta\[name="([^"]+)"\]/.exec(selector);
      if (!name) return null;

      const content = tags[name[1]];
      return content === undefined ? null : { content };
    }
  };
}

function ctxFor(config, opts) {
  const options = opts || {};

  global.document = withTags(options.tags || {});
  global.window = options.window || {};

  return prelude(options.id || "unit", options.trusted !== false, config || {}, "");
}

test("a number default coerces whatever arrives", () => {
  // A meta tag can only ever carry a string; the device configuration carries the
  // real thing. Both have to end up as a number.
  const ctx = ctxFor({ a: "300", b: 300, c: "12.5" }, { trusted: false });

  assert.equal(ctx.config("a", 120), 300);
  assert.equal(ctx.config("b", 120), 300);
  assert.equal(ctx.config("c", 120), 12.5);
  assert.equal(typeof ctx.config("a", 120), "number");
});

test("a number that cannot be read falls back rather than becoming NaN", () => {
  const ctx = ctxFor({ a: "abc", b: "", c: null }, { trusted: false });

  assert.equal(ctx.config("a", 120), 120);
  assert.equal(ctx.config("b", 120), 120);
  assert.equal(ctx.config("c", 120), 120);
});

test("zero is a value, not an absence", () => {
  // display-lock's `after: 0` means "only on request", so a falsy-but-set number
  // must survive.
  const ctx = ctxFor({ after: 0, other: "0" }, { trusted: false });

  assert.equal(ctx.config("after", 30), 0);
  assert.equal(ctx.config("other", 30), 0);
});

test("a boolean default accepts what a tag can say and what config can say", () => {
  const ctx = ctxFor(
    { a: "1", b: "true", c: true, d: "0", e: false, f: "yes" },
    { trusted: false }
  );

  assert.equal(ctx.config("a", false), true);
  assert.equal(ctx.config("b", false), true);
  assert.equal(ctx.config("c", false), true);
  assert.equal(ctx.config("d", false), false);
  assert.equal(ctx.config("e", true), false);
  assert.equal(ctx.config("f", false), false);
});

test("a list default takes an array as it is and splits a string", () => {
  const ctx = ctxFor(
    { a: ["clock", "url"], b: "clock url", c: "clock,url", d: "clock, url" },
    { trusted: false }
  );

  const expected = ["clock", "url"];
  assert.deepEqual(ctx.config("a", ["clock"]), expected);
  assert.deepEqual(ctx.config("b", ["clock"]), expected);
  assert.deepEqual(ctx.config("c", ["clock"]), expected);
  assert.deepEqual(ctx.config("d", ["clock"]), expected);
});

test("a string default stringifies, because config can carry a number", () => {
  const ctx = ctxFor({ pin: 4711, msg: "Locked" }, { trusted: false });

  // display-lock compares the PIN with ===, so %{pin: 4711} arriving as a number
  // would never match what someone typed.
  assert.equal(ctx.config("pin", "0000"), "4711");
  assert.equal(ctx.config("msg", "Locked"), "Locked");
});

test("a key nobody configured keeps its default", () => {
  const ctx = ctxFor({}, { trusted: false });

  assert.equal(ctx.config("idle", 120), 120);
  assert.equal(ctx.config("mode", "both"), "both");
  assert.deepEqual(ctx.config("items", ["clock"]), ["clock"]);
  assert.equal(ctx.config("numbers", false), false);
});

test("the script's own tag wins, and a shared tag is the fallback", () => {
  // myelin-theme reaches every script that asks for "theme"; myelin-keyboard-theme
  // overrides it for the keyboard alone.
  const shared = ctxFor({}, { id: "keyboard", tags: { "myelin-theme": "dark" } });
  assert.equal(shared.config("theme", "auto"), "dark");

  const own = ctxFor(
    {},
    { id: "keyboard", tags: { "myelin-theme": "dark", "myelin-keyboard-theme": "light" } }
  );
  assert.equal(own.config("theme", "auto"), "light");
});

test("a tag beats the device configuration", () => {
  const ctx = ctxFor({ idle: 300 }, { id: "screensaver", tags: { "myelin-screensaver-idle": "30" } });

  assert.equal(ctx.config("idle", 120), 30);
});

test("a tag can carry JSON, so a list or an object survives one", () => {
  const ctx = ctxFor(
    {},
    { id: "keyboard", tags: { "myelin-keyboard-skip": '["^localhost$", "^10\\\\."]' } }
  );

  assert.deepEqual(ctx.config("skip", []), ["^localhost$", "^10\\."]);
});

test("an untrusted page cannot configure anything", () => {
  // The property the whole design rests on. Its C counterpart is
  // test_untrusted_page_cannot_disable; this is the JS half.
  const ctx = ctxFor(
    { idle: 300 },
    {
      id: "screensaver",
      trusted: false,
      tags: { "myelin-screensaver-idle": "1", "myelin-theme": "dark" }
    }
  );

  assert.equal(ctx.config("idle", 120), 300, "the device still decides");
  assert.equal(ctx.config("theme", "auto"), "auto", "the page does not");
});

test("emit dispatches the prefixed name", () => {
  const seen = [];
  const window = {
    dispatchEvent(event) {
      seen.push(event);
    }
  };

  global.CustomEvent = class {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts && opts.detail;
    }
  };

  const ctx = ctxFor({}, { id: "screensaver", window });
  ctx.emit("screensaver:show", { from: "test" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "myelin:screensaver:show");
  assert.deepEqual(seen[0].detail, { from: "test" });
});

test("emit pushes the same name to a LiveView, and shrugs without one", () => {
  const pushed = [];
  const el = {};

  global.CustomEvent = class {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts && opts.detail;
    }
  };

  // No liveSocket: emit must report false rather than throw, because every foreign
  // page the kiosk visits takes this path.
  const bare = ctxFor({}, { window: { dispatchEvent() {} } });
  assert.equal(bare.emit("a:b", {}), false);

  const window = {
    dispatchEvent() {},
    liveSocket: {
      js: () => ({
        push(element, name, opts) {
          pushed.push([element, name, opts]);
        }
      })
    }
  };

  global.document = withTags({});
  global.document.querySelector = (selector) =>
    selector === "[data-phx-main]" ? el : null;

  const ctx = prelude("screensaver", true, {}, "");
  global.window = window;

  assert.equal(ctx.emit("screensaver:show", { a: 1 }), true);
  assert.deepEqual(pushed, [[el, "myelin:screensaver:show", { value: { a: 1 } }]]);
});

test("on listens for a script's name and for the application's", () => {
  const listeners = [];
  const window = {
    addEventListener(type) {
      listeners.push(type);
    }
  };

  const ctx = ctxFor({}, { window });
  ctx.on("screensaver:show", () => {});

  assert.deepEqual(listeners, ["myelin:screensaver:show", "phx:myelin:screensaver:show"]);
});

test("the surface is three functions and one value", () => {
  // The API is meant to be small enough to hold in your head. If something is
  // added here, it should be because a script needs it — this is the reminder.
  const ctx = ctxFor({}, { trusted: false });

  assert.deepEqual(Object.keys(ctx).sort(), ["config", "css", "emit", "on"]);
});
