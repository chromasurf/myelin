/*
 * Onscreen Keyboard — slides in when a field takes focus, as letters or as a
 * keypad depending on what the field wants.
 *
 * Writes through the native value setter and then dispatches a bubbling "input"
 * event, which is what LiveView and React listen for. Without the native setter a
 * framework that caches the previous value would not notice the change.
 *
 * It lives in the page rather than in a shadow root, so a page's CSS can reach it.
 * Recolour it by overriding the --osk-* custom properties.
 *
 * The letter block follows the physical layouts, not a phone's: ü + ö ä # and , . -
 * where a German keyboard has them, [ ] ; ' and , . / where a US one does. A phone
 * reaches those through a long press, and there is no long press on a panel — no
 * gestures, no second level for letters, one tap is all there is. Where the
 * *function* keys sit is iOS's arrangement, which suits a touch panel better than a
 * PC keyboard's. There are no caret keys: tapping into the text puts the caret
 * where the finger is, and the two arrows cost the space bar a third of its width.
 *
 * Under the :weston backend, weston.ini may also enable weston-keyboard
 * ([input-method] / overlay-keyboard=true). Turn that off, or two keyboards appear.
 * Under :cog_drm there is no compositor and this is the only option.
 *
 * Configuration
 *   layout    en | de                                          en
 *   numbers   digit row above the letters                      false
 *   start     "symbols" to open on ?123 instead of letters     ()
 *   keypad    CSS selector for fields that get the keypad      input[type=number], …
 *   skip      regular expressions of hosts to leave alone      ()
 *   theme     light | dark | auto — shared with navbar         auto
 *
 * The page can drive it: window.cogOsk.setLayout("en" | "de" | "numeric") and
 * window.cogOsk.hide().
 */

/* --- standing aside --------------------------------------------------- */

// A list, so a string arrives split on whitespace and commas. Write these as a
// list — as a bare string a pattern containing a comma, and {1,3} does, would be
// torn in two.
var SKIP = ctx.config("skip", []);

// Anchors are the caller's to write: "localhost" without them also matches
// "notlocalhost.com". A pattern that does not compile is dropped with a warning
// rather than thrown — a typo in runtime.exs must not take the keyboard down on
// every page of the kiosk, and it would, from here.
function skipsHost(host) {
  for (var i = 0; i < SKIP.length; i++) {
    try {
      if (new RegExp(SKIP[i]).test(host)) return true;
    } catch (e) {
      console.warn(
        "[keyboard] ignoring keyboard-skip " +
          JSON.stringify(SKIP[i]) +
          ": not a valid regular expression (" +
          e.message +
          ")"
      );
    }
  }

  return false;
}

if (skipsHost(location.hostname)) return;

var ELEMENT_ID = "cog-osk";
var DEFAULT_LAYOUT = ctx.config("layout", "en") === "de" ? "de" : "en";

/* --- layouts ---------------------------------------------------------- */

// Each entry is a plain string, or [label, action] where a single-character
// action is the literal to type.
//
// Labels are words, not the usual ⇧/⌫/⏎ pictographs: the kiosk images ship
// Liberation fonts, which have no glyphs for those codepoints, so they
// render as tofu boxes on the device.
//
// No caret keys. Tapping into the text puts the caret where the finger is,
// which is the gesture people reach for anyway, and the two arrows cost the
// space bar a third of its width — the one key that is hit blind.
// Three forms of entry:
//
//   "q"                a character key, labelled with itself
//   ["Shift", "shift"] an action — anything whose second entry is a word
//   ["+", "+", "*"]    label, character, and the character Shift produces
//
// The third form is what a real keyboard needs and toUpperCase cannot give:
// Shift+, is ; on a German layout and < on an English one, and no amount of
// case conversion will say so.
//
// The letter block follows the physical layouts, not a phone's: ü + ö ä # and
// , . - where a German keyboard has them, [ ] ; ' and , . / where a US one
// does. A phone hides all of these behind ?123 and a long press, neither of
// which exists on a panel with no gestures and no second level for letters.
// The letters are the physical layouts; where the *function* keys sit is iOS's
// arrangement, which is a better fit for a touch panel than a PC keyboard's.
//
// The shape is two columns of function keys with the letters inset between them,
// and that is the part worth getting right — every row starts and ends in the
// same place, so the eye finds Del or Enter by position rather than by reading:
//
//     Tab   q w e r t z u i o p ü +   Del
//     Caps  a s d f g h j k l ö ä #   Enter
//     Shift y x c v b n m ß , . -     Shift
//     ?123  [        space        ]   ?123  ⌨
//
// The bottom row carries nothing that types. Enter sat there beside the dismiss
// key for one afternoon, and reaching for Enter put the keyboard away instead;
// iOS keeps the row someone reaches for blind free of anything with consequences.
// ?123 twice is iOS's too — either hand can reach one without crossing the bar.
//
// Not taken from iOS: the globe (there is one letter layout at a time; the host
// page switches with cogOsk.setLayout) and the microphone (no dictation).
var LAYOUTS = {
  de: [
    [["Tab", "tab"], "q", "w", "e", "r", "t", "z", "u", "i", "o", "p", "ü", ["+", "+", "*"], ["Del", "backspace"]],
    [["Caps", "caps"], "a", "s", "d", "f", "g", "h", "j", "k", "l", "ö", "ä", ["#", "#", "'"], ["Enter", "enter"]],
    // ß is a letter, not a symbol: without it there is no Straße, no Maß, no
    // groß. A German keyboard has it in the number row, which is optional here,
    // and a phone hides it behind a long press on s, which does not exist here
    // either — so it sits at the end of the letters.
    [
      ["Shift", "shift"],
      "y", "x", "c", "v", "b", "n", "m", "ß",
      [",", ",", ";"],
      [".", ".", ":"],
      ["-", "-", "_"],
      ["Shift", "shift"]
    ],
    [["?123", "symbols"], [" ", "space"], ["?123", "symbols"], ["", "dismiss"]]
  ],
  en: [
    [["Tab", "tab"], "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", ["[", "[", "{"], ["]", "]", "}"], ["Del", "backspace"]],
    [["Caps", "caps"], "a", "s", "d", "f", "g", "h", "j", "k", "l", [";", ";", ":"], ["'", "'", "\""], ["Enter", "enter"]],
    [
      ["Shift", "shift"],
      "z", "x", "c", "v", "b", "n", "m",
      [",", ",", "<"],
      [".", ".", ">"],
      ["/", "/", "?"],
      ["Shift", "shift"]
    ],
    [["?123", "symbols"], [" ", "space"], ["?123", "symbols"], ["", "dismiss"]]
  ]
};

// The two symbol levels are not shared between the layouts, because on real
// keyboards they are not: a German one carries € on the first level and $ on
// the second, an English one the other way round. Sharing them gave an English
// kiosk a Euro sign and buried the Dollar one level down.
//
// § and ° are on the German second level and are the reason it is not simply a
// copy: both sit on a German keyboard (Shift+3, Shift+^) and neither is on an
// English one. ¥ made room for them — a German terminal needs a paragraph sign
// far more than a Yen sign, and ¥ is still there under `en`.
// Same two columns as the letters: Tab and Del on the top row, the level switch
// and Enter on the row below, so nothing a hand has learned moves when the level
// does. There is no Caps and no Shift here — a symbol level has no case — and the
// switch back to the letters takes the left column of the third row instead.
var SYMBOLS = {
  de: {
    symbols: [
      [["Tab", "tab"], "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ["Del", "backspace"]],
      [["#+=", "more"], "-", "/", ":", ";", "(", ")", "€", "&", "@", "\"", ["Enter", "enter"]],
      [["ABC", "letters"], ".", ",", "?", "!", "'", "+", "*"],
      [["ABC", "letters"], [" ", "space"], ["ABC", "letters"], ["", "dismiss"]]
    ],
    more: [
      [["Tab", "tab"], "[", "]", "{", "}", "#", "%", "^", "*", "+", "=", ["Del", "backspace"]],
      [["?123", "symbols"], "_", "\\", "|", "~", "<", ">", "$", "£", "§", "°", ["Enter", "enter"]],
      [["ABC", "letters"], ".", ",", "?", "!", "'", "\"", "`"],
      [["ABC", "letters"], [" ", "space"], ["ABC", "letters"], ["", "dismiss"]]
    ]
  },
  en: {
    symbols: [
      [["Tab", "tab"], "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ["Del", "backspace"]],
      [["#+=", "more"], "-", "/", ":", ";", "(", ")", "$", "&", "@", "\"", ["Enter", "enter"]],
      [["ABC", "letters"], ".", ",", "?", "!", "'", "+", "*"],
      [["ABC", "letters"], [" ", "space"], ["ABC", "letters"], ["", "dismiss"]]
    ],
    more: [
      [["Tab", "tab"], "[", "]", "{", "}", "#", "%", "^", "*", "+", "=", ["Del", "backspace"]],
      [["?123", "symbols"], "_", "\\", "|", "~", "<", ">", "€", "£", "¥", "°", ["Enter", "enter"]],
      [["ABC", "letters"], ".", ",", "?", "!", "'", "\"", "`"],
      [["ABC", "letters"], [" ", "space"], ["ABC", "letters"], ["", "dismiss"]]
    ]
  }
};

// Optional row above the letters. Costs a row of height on a 1280px portrait
// panel, which is why it is off unless the page asks for it.
//
// With the shifted characters a real number row carries — which is where § and
// the German ", / ( ) = actually live, and where an English keyboard keeps
// @ # ^ & *. Reachable with Shift, exactly as on the physical thing.
var NUMBER_ROWS = {
  de: [
    ["1", "1", "!"], ["2", "2", "\""], ["3", "3", "§"], ["4", "4", "$"], ["5", "5", "%"],
    ["6", "6", "&"], ["7", "7", "/"], ["8", "8", "("], ["9", "9", ")"], ["0", "0", "="]
  ],
  en: [
    ["1", "1", "!"], ["2", "2", "@"], ["3", "3", "#"], ["4", "4", "$"], ["5", "5", "%"],
    ["6", "6", "^"], ["7", "7", "&"], ["8", "8", "*"], ["9", "9", "("], ["0", "0", ")"]
  ]
};

var WITH_NUMBERS = ctx.config("numbers", false);

/* --- the keypad ------------------------------------------------------- */

var DEFAULT_NUMERIC_SELECTOR =
  'input[type="number"], input[inputmode="numeric"], input[inputmode="decimal"]';
var NUMERIC_SELECTOR = usable(ctx.config("keypad", DEFAULT_NUMERIC_SELECTOR));

// A CSS typo in runtime.exs — a trailing comma is the one to expect, since the
// default here is a list — makes Element.matches() throw, and not once: on every
// focus change for the life of the page, from inside the focus callback, so no
// field would ever raise a keyboard again and every tap would log afresh. The C
// side degrades a malformed configuration on purpose ("a typo in runtime.exs must
// not take every script down with it"); a CSS typo deserves the same, said out
// loud once.
//
// Note that an *unclosed* bracket is not one of these: CSS closes open blocks at
// the end of the input, so "input[type=number" parses as if the bracket were
// there. What throws is a stray comma, an empty :not(), a leading digit.
function usable(selector) {
  try {
    document.createDocumentFragment().querySelector(selector);
    return selector;
  } catch (e) {
    console.warn(
      "[keyboard] ignoring keyboard-keypad " +
        JSON.stringify(selector) +
        ": not a valid CSS selector (" +
        e.message +
        ")"
    );
    return DEFAULT_NUMERIC_SELECTOR;
  }
}

function isNumericField(el) {
  return !!el && typeof el.matches === "function" && el.matches(NUMERIC_SELECTOR);
}

// Digits, a separator, and the two ways out. Three per row, so the keys come
// out thumb-sized rather than stretched across the panel.
//
// The decimal separator follows the field, and it has to: a comma is not part of
// a valid floating-point number, so assigning "1,5" to an <input type="number">
// assigns nothing at all and the element reports "" — every decimal silently
// lost, on the one field type a keypad is written for. Anywhere else —
// inputmode="numeric" on a text field, which is what a LiveView form usually
// carries — a comma is what a German terminal expects.
//
// A point is not the whole fix on a number field: see `carried` below for the
// half-typed "12." the element also refuses.
function numericRows() {
  var separator = target && target.type === "number" ? "." : ",";

  return [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    [separator, "0", ["Del", "backspace"]],
    [["ABC", "letters"], ["Enter", "enter"], ["", "dismiss"]]
  ];
}

function rowsFor(name) {
  // The two symbol levels belong to a language, not to the keyboard as a whole
  // — see SYMBOLS. Everything else here is a letter layout.
  if (name === "symbols" || name === "more") return SYMBOLS[letterLayout][name];

  // No number row above the keypad: NUMBER_ROWS has no entry for it, and a row
  // of digits over a block of digits is not what anyone asked for.
  if (name === "numeric") return numericRows();

  var rows = LAYOUTS[name];
  if (WITH_NUMBERS) return [NUMBER_ROWS[name]].concat(rows);
  return rows;
}

// Rows of equal, full-width keys, or a narrow centred block. The difference is
// geometry only — colours, states and the input path are shared.
function shapeFor(name) {
  return name === "numeric" ? "keypad" : "full";
}

/* --- state ------------------------------------------------------------ */

var target = null;
var letterLayout = DEFAULT_LAYOUT; // which of de/en to return to from symbols

// Which layer the keyboard opens on, and returns to when it closes. A terminal
// whose fields are serials, codes and part numbers spends its day behind ?123,
// and reaching for it at every single field is a tap wasted.
function startLayout() {
  return ctx.config("start", "") === "symbols" ? "symbols" : letterLayout;
}

var layout = startLayout();
var shifted = false;
var capsLock = false;

// Built here rather than at the top, so a host this keyboard was told to skip does
// not get an empty panel appended to it.
var root = document.createElement("div");
root.id = ELEMENT_ID;
document.body.appendChild(root);
root.setAttribute("role", "application");
root.setAttribute("aria-label", "Onscreen keyboard");

/* --- theme ------------------------------------------------------------ */

var darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  var wanted = ctx.config("theme", "auto");
  if (wanted !== "light" && wanted !== "dark") {
    wanted = darkQuery.matches ? "dark" : "light";
  }
  root.dataset.theme = wanted;
}

applyTheme();

// Follow the system setting while "auto" is in effect. addEventListener on a
// MediaQueryList is the modern form; addListener is the pre-2020 fallback.
if (darkQuery.addEventListener) {
  darkQuery.addEventListener("change", applyTheme);
} else if (darkQuery.addListener) {
  darkQuery.addListener(applyTheme);
}

/* --- writing into the field ------------------------------------------- */

function isEditable(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return !el.readOnly && !el.disabled;
  if (el.tagName !== "INPUT") return false;

  return (
    !el.readOnly &&
    !el.disabled &&
    /^(text|search|url|tel|email|password|number|)$/i.test(el.type || "")
  );
}

// Frameworks track the previous value on the element, so assigning .value
// directly can be swallowed. Going through the prototype's setter is what
// makes the change visible to them.
function setNativeValue(el, value) {
  var proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  var descriptor = Object.getOwnPropertyDescriptor(proto, "value");

  if (descriptor && descriptor.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
}

function notify(el) {
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// What the field was meant to hold while it is refusing to hold it, or null.
//
// An <input type="number"> will not keep a half-typed decimal: assigning "12."
// empties it, because that is not a valid floating-point number — measured on
// WPE WebKit 2.50 and in Playwright's WebKit, where "12" and "12.5" both stick
// and "12." reads back as "". Typing into the real thing does not hit this,
// because the element keeps the raw text alongside the parsed value; a keyboard
// writing through .value has no access to that.
//
// Without this, "12.5" on the keypad produced "5": the separator wiped the
// field, and the digit after it started from nothing. So the rejected value is
// remembered and the next keystroke is appended to *it* rather than to the empty
// field, which the element then accepts as a whole.
var carried = null;

function heldValue() {
  return carried === null ? target.value : carried;
}

function clearCarried() {
  carried = null;
}

// The tail a number field is known to refuse: separators, exponent markers and
// signs, none of which parse as a float on their own. Recognising them up front
// saves more than the round trip — WebKit logs "the specified value cannot be
// parsed" for every one, which on a kiosk is a console warning per separator
// keystroke.
var INCOMPLETE_NUMBER = /[.,eE+-]+$/;

// Assign, then check whether it survived. Only the appending path needs this:
// where there is a caret there is no number field.
//
// The check after the assignment stays even with the test above, because that one
// only covers what is *known* to fail — min, max and step are all refused too,
// and they must not leave the carry claiming a value the field never took.
function appendValue(value) {
  if (target.type === "number" && INCOMPLETE_NUMBER.test(value)) {
    // Show the part the element can hold and remember the whole of it: the field
    // reads "12" while "12." is pending, so every keystroke has a visible effect
    // — a Del that took the 5 off "12.5" shows "12" rather than sitting there
    // unchanged — and the next digit still completes what was typed.
    setNativeValue(target, value.replace(INCOMPLETE_NUMBER, ""));
    carried = value;
    return;
  }

  setNativeValue(target, value);
  carried = target.value === value ? null : value;
}

function insertText(text) {
  if (!target) return;

  if (target.isContentEditable) {
    // Deprecated, but still the only call that inserts into a
    // contenteditable while keeping the caret and the undo stack intact.
    document.execCommand("insertText", false, text);
    return;
  }

  var start = target.selectionStart;
  var end = target.selectionEnd;

  if (start === null || start === undefined) {
    appendValue(heldValue() + text);
  } else {
    setNativeValue(target, target.value.slice(0, start) + text + target.value.slice(end));
    target.selectionStart = target.selectionEnd = start + text.length;
  }

  notify(target);
}

function deleteBackward() {
  if (!target) return;

  if (target.isContentEditable) {
    document.execCommand("delete", false, null);
    return;
  }

  var start = target.selectionStart;
  var end = target.selectionEnd;

  if (start === null || start === undefined) {
    // Backspacing out of a half-typed decimal: "12." goes back to "12", which
    // the element takes, so the carry clears itself.
    appendValue(heldValue().slice(0, -1));
  } else if (start !== end) {
    setNativeValue(target, target.value.slice(0, start) + target.value.slice(end));
    target.selectionStart = target.selectionEnd = start;
  } else if (start > 0) {
    setNativeValue(target, target.value.slice(0, start - 1) + target.value.slice(end));
    target.selectionStart = target.selectionEnd = start - 1;
  } else {
    return;
  }

  notify(target);
}

// Tab has to walk the fields itself. A synthesised keydown moves no focus — the
// browser's own tabbing is a default action, and defaults only follow events the
// user really produced — so dispatching one would do nothing at all and look like
// a dead key.
//
// Document order, not tabindex order: a positive tabindex reorders tabbing, and
// honouring that properly means sorting three groups against each other for a case
// that a kiosk form does not have. Filtering out tabindex="-1" is the part that
// matters, since that is how a page says "not with the keyboard".
var TABBABLE =
  'input:not([type="hidden"]), textarea, select, [contenteditable=""], ' +
  '[contenteditable="true"], button, a[href], [tabindex]';

function moveToNextField() {
  if (!target) return;

  var fields = [].filter.call(document.querySelectorAll(TABBABLE), function (el) {
    if (el.disabled || el.getAttribute("tabindex") === "-1") return false;
    if (root.contains(el)) return false;
    // offsetParent is null for anything display:none, and for fixed elements —
    // hence the second test, or a fixed toolbar's fields would be skipped.
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });

  var here = fields.indexOf(target);
  // Wrap, and cope with a target that is not in the list at all (index -1 lands
  // on 0, the first field, which is the useful answer).
  var next = fields[(here + 1) % fields.length];

  if (next && typeof next.focus === "function") next.focus();
}

// Returns whether that was a confirmation — true for a single-line field, where
// Enter means "done" and the caller puts the keyboard away, false where it just
// inserted a newline and there is more typing to come.
function pressEnter() {
  if (!target) return false;

  if (target.tagName === "TEXTAREA" || target.isContentEditable) {
    insertText("\n");
    return false;
  }

  // For single-line fields Enter means "confirm": let the page decide by
  // dispatching real key events, then submit the form if nobody objected.
  var options = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  };

  var notCancelled = target.dispatchEvent(new KeyboardEvent("keydown", options));
  target.dispatchEvent(new KeyboardEvent("keyup", options));

  if (notCancelled && target.form && typeof target.form.requestSubmit === "function") {
    target.form.requestSubmit();
  }

  return true;
}

/* --- rendering -------------------------------------------------------- */

function keyParts(entry) {
  if (typeof entry === "string") return { label: entry, action: "char", value: entry };

  var label = entry[0];
  var action = entry[1];

  if (action === "space") return { label: "", action: "char", value: " ", wide: "space" };

  // Three entries: label, character, and what Shift makes of it.
  if (entry.length === 3) {
    return { label: label, action: "char", value: action, shift: entry[2] };
  }

  if (action.length === 1) return { label: label, action: "char", value: action };

  return { label: label, action: action };
}

// What a key produces in the current state.
//
// Two rules from the physical keyboard, and they differ: Caps Lock only ever
// affects letters — Caps+, is a comma, not a semicolon — while Shift reaches
// the paired character. And "ß".toUpperCase() is "SS", two characters on one
// key: correct German for a capital ß, but a key that grows a second glyph and
// types two of them is not what anyone reaches for, so it stays as it is.
function charFor(value, pair) {
  if (pair) return shifted ? pair : value;
  if (!shifted && !capsLock) return value;

  var upper = value.toUpperCase();
  return upper.length === value.length ? upper : value;
}

function render() {
  root.textContent = "";
  root.dataset.shape = shapeFor(layout);

  rowsFor(layout).forEach(function (row) {
    var rowEl = document.createElement("div");
    rowEl.className = "cog-osk-row";

    row.forEach(function (entry) {
      var key = keyParts(entry);
      // A <div>, not a <button>: buttons take focus when tapped, which pulls
      // it out of the field being typed into and slides the keyboard away
      // again. preventDefault alone did not reliably stop that on the touch
      // panel, so the keys are simply not focusable to begin with.
      var button = document.createElement("div");

      button.setAttribute("role", "button");
      button.className = "cog-osk-key";
      button.dataset.action = key.action;

      if (key.action === "char") {
        button.dataset.value = key.value;
        if (key.shift) button.dataset.shift = key.shift;
        button.textContent = charFor(key.value, key.shift);
      } else {
        button.textContent = key.label;
        button.classList.add("cog-osk-key-special");
        // Also one class per action — cog-osk-key-enter, -shift, -dismiss — so
        // that giving a single key its own width or icon is a CSS rule and not
        // another branch in here.
        button.classList.add("cog-osk-key-" + key.action);
      }

      if (key.wide === "space") button.classList.add("cog-osk-key-space");

      // Shift shows the one-shot, Caps shows the lock, and each shows only its
      // own state: one shared indicator makes a locked keyboard look like a
      // shifted one.
      if (key.action === "shift" && shifted) button.classList.add("is-active");
      if (key.action === "caps" && capsLock) {
        button.classList.add("is-active", "is-locked");
      }

      // The one key with no label at all — it is drawn in CSS — so it needs the
      // name spelled out for anything that reads the tree rather than looks at it.
      if (key.action === "dismiss") {
        button.setAttribute("aria-label", "Hide the keyboard");
      }

      rowEl.appendChild(button);
    });

    root.appendChild(rowEl);
  });
}

/* --- input ------------------------------------------------------------ */

// Pressing a key must not move focus away from the field being typed into.
// Both events are covered: touch input synthesises mousedown from pointer
// events, and preventing only one of them still let focus slip on the panel.
["pointerdown", "mousedown"].forEach(function (name) {
  root.addEventListener(name, function (event) {
    event.preventDefault();
  });
});

root.addEventListener("click", function (event) {
  var button = event.target.closest(".cog-osk-key");
  if (!button || !target) return;

  // Last line of defence: if focus escaped anyway, put it back before
  // writing, or the keystroke would go nowhere. Compared through shadow
  // boundaries, or a field inside one would be refocused on every keystroke —
  // document.activeElement stops at the host.
  if (activeField() !== target) {
    target.focus();
  }

  switch (button.dataset.action) {
    case "char": {
      var value = button.dataset.value;
      insertText(charFor(value, button.dataset.shift));
      if (shifted) {
        shifted = false; // one-shot shift, as on a phone
        render();
      }
      break;
    }
    case "backspace":
      deleteBackward();
      break;
    case "enter":
      // Enter on a single-line field means "done", so it puts the keyboard away
      // like the dismiss key does — a panel has no other moment where "I am
      // finished with this field" is that clearly stated. A textarea keeps it:
      // there Enter added a line and the next one is still coming.
      //
      // After pressEnter(), not before: the form has to see the value, and a
      // submit that navigates makes the rest moot anyway.
      if (pressEnter()) {
        if (target && typeof target.blur === "function") target.blur();
        hide();
      }
      break;
    case "shift":
      // One-shot only. Caps has a key of its own, so Shift does not need to
      // cycle off → one-shot → locked to reach a lock — and it should not, or a
      // second tap on Shift, a common enough slip, locks the keyboard into
      // capitals with nothing to say it did.
      shifted = !shifted;
      render();
      break;
    case "caps":
      capsLock = !capsLock;
      shifted = false;
      render();
      break;
    case "tab":
      moveToNextField();
      break;
    case "symbols":
    case "more":
      layout = button.dataset.action;
      shifted = false;
      render();
      break;
    case "letters":
      layout = letterLayout;
      shifted = false;
      render();
      break;
    case "dismiss":
      // Blur, not just hide. The field would otherwise keep focus, and a second
      // tap into that same field fires no focusin — so nothing would bring the
      // keyboard back and the panel would be stuck with no way to type. iOS does
      // the same: the caret goes away with the keyboard.
      //
      // Before hide(), which clears target.
      if (target && typeof target.blur === "function") target.blur();
      hide();
      break;
  }
});

/* --- show and hide ---------------------------------------------------- */

// Only the keypad/letters distinction follows the field. Which symbol level
// someone is on is theirs to keep while they move from one text field to the
// next — but coming back from the keypad there is nothing to keep, so that
// returns to whatever the keyboard opens on.
function layoutFor(el, appearing) {
  if (isNumericField(el)) return "numeric";
  if (appearing || layout === "numeric") return startLayout();
  return layout;
}

function show(el) {
  var changedField = target !== el;

  // Before target moves: a value the previous field would not hold belongs to
  // that field and must not follow the caret to the next one.
  if (changedField) clearCarried();
  target = el;

  var appearing = !root.classList.contains("is-visible");
  var wanted = layoutFor(el, appearing);

  // Re-rendered on a layout change even when the keyboard is already up: focus
  // moving from a text field to a number field is the whole point of having the
  // two variants in one script, and it happens without the keyboard ever
  // sliding away.
  if (appearing || wanted !== layout) {
    layout = wanted;
    shifted = false;
    if (appearing) applyTheme();
    render();
  } else if (changedField && layout === "numeric") {
    // Same layout, different field — which still changes a key, because the
    // keypad's separator belongs to the field and not to the layout: a point for
    // an <input type="number">, a comma for everything else. Moving between two
    // numeric fields of different kinds otherwise kept the first one's.
    render();
  }

  if (appearing) {
    root.classList.add("is-visible");
    window.dispatchEvent(
      new CustomEvent("cog:keyboard:show", { detail: { layout: layout } })
    );
  }

  // Keep the field the user is typing into above the keyboard.
  window.setTimeout(function () {
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, 250);
}

function hide() {
  if (!root.classList.contains("is-visible")) return;

  clearCarried();
  target = null;
  shifted = false;
  capsLock = false;
  layout = startLayout();
  root.classList.remove("is-visible");
  window.dispatchEvent(new CustomEvent("cog:keyboard:hide"));
}

/* --- watching focus, including inside shadow roots --------------------- */

// This lives here rather than in ctx because the keyboard is the only script that
// needs it: seventy lines of measured browser behaviour serve exactly one caller.
// ideas/probe-field is the fixture that demonstrates the case.

// Which field has focus, walked into shadow roots: document.activeElement stops
// at the host and would report the component, not the field inside it.
function activeField() {
  var el = document.activeElement;

  while (el && el.shadowRoot && el.shadowRoot.activeElement) {
    el = el.shadowRoot.activeElement;
  }

  return el;
}

// Calls handler(field) whenever the focused field changes, with the field walked
// into shadow roots, or null when nothing holds focus.
//
// Why this is not one document.addEventListener("focusin"): between two fields
// inside the *same* shadow root, both events retarget to the same host and the
// browser dispatches nothing outside that tree — not focusin, not focusout. So a
// keyboard watching only the document never learns the field changed and stays
// over the wrong one. Every shadow root the focus passes through therefore gets
// its own pair of listeners, discovered from composedPath() on pointerdown as
// well as focusin: a tap reports the whole path before focus moves, which also
// covers the first field in a root that was never entered from outside.
function onFocus(handler) {
  // A WeakSet, not an array: it answers "already registered" without holding the
  // root alive. On a LiveView page that patches the DOM for hours, an array
  // keeps every root of every component ever removed, and the membership scan
  // grows with it — on every node of every composedPath of every pointerdown.
  var roots = new WeakSet();
  var timer = null;
  var last;

  // focusout arrives before the next focusin, so the state worth reporting is
  // the one after the move, not the gap inside it. A zero timeout lands on the
  // far side of both.
  function settle() {
    window.clearTimeout(timer);

    timer = window.setTimeout(function () {
      var field = activeField();

      if (!field || field === document.body || field === document.documentElement) {
        field = null;
      }

      // Entering a shadow root fires on the root and on the document both, so
      // the same field would otherwise be announced twice.
      if (field === last) return;

      last = field;
      handler(field);
    }, 0);
  }

  // A shadow root is a DocumentFragment that carries a host. Both halves are
  // needed: an <a> or an <area> has a .host of its own — the host part of its
  // URL — so "carries a host" alone accepts every link in the composedPath. The
  // nodeType number rather than Node.DOCUMENT_FRAGMENT_NODE or instanceof
  // ShadowRoot, because both of those are globals the page can replace.
  function register(node) {
    if (!node || node.nodeType !== 11 || !node.host || !node.addEventListener) {
      return;
    }

    if (roots.has(node)) return;

    roots.add(node);
    node.addEventListener("focusin", settle);
    node.addEventListener("focusout", settle);
  }

  function discover(event) {
    var path = (event.composedPath && event.composedPath()) || [];

    for (var i = 0; i < path.length; i++) {
      register(path[i]);
    }
  }

  // A field inside a shadow root can already hold focus before this runs — the
  // page focused it, or the script was injected into a page in use. Nothing will
  // ever announce that root: the events it fires stay inside it, and the one
  // document event that would have named it is long past. So walk what holds
  // focus now and register on the way in.
  for (var el = document.activeElement; el && el.shadowRoot; el = el.shadowRoot.activeElement) {
    register(el.shadowRoot);
  }

  document.addEventListener("pointerdown", discover, true);
  document.addEventListener("focusin", discover, true);
  document.addEventListener("focusin", settle, true);
  document.addEventListener("focusout", settle, true);
}

// onFocus, not a focusin listener on the document: inside a shadow root the
// document is told nothing when focus moves from one field to the next, so a
// keyboard watching only the document stays down over the second field. The
// prelude listens in every root the focus passes through and reports the field
// itself, already walked past the host, and only once the move has settled.
onFocus(function (field) {
  if (isEditable(field)) {
    show(field);
    return;
  }

  // Focus landing inside the keyboard is not the user leaving the field. The
  // keys are deliberately not focusable, so this is a safety net, not a path
  // that is normally taken.
  if (field && root.contains(field)) {
    return;
  }

  hide();
});

// Expose the layout switch for the host page: cogOsk.setLayout("en"), or
// "numeric" for a field the selector does not catch. hide() is there for an
// application that needs the panel clear for a moment — a modal, a scan, a
// confirmation.
window.cogOsk = {
  setLayout: function (name) {
    if (name === "de" || name === "en") {
      letterLayout = name;
      layout = name;
    } else if (name === "numeric") {
      layout = "numeric";
    } else {
      return false;
    }

    if (root.classList.contains("is-visible")) render();
    return true;
  },
  hide: hide
};
