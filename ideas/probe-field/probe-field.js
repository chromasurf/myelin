/*
 * Probe Field — a text field and a number field to tap, for trying the keyboard on
 * a page that has none of its own. It counts the input events, which is the part
 * worth watching: the keyboard writes through the native value setter and then
 * dispatches a bubbling "input" event, and without that a framework caching the
 * previous value would never notice the change. The counter going up is that
 * mechanism working.
 *
 * Both fields sit in one shadow root, which is the case worth having: focusin
 * bubbles out of a shadow root only when focus *enters* it, so moving from one field
 * inside to the other dispatches nothing outside the tree at all. Tap the number
 * field, then the text field — that is the case the keyboard's own focus tracking has
 * to catch, and it is also the pair that shows the keyboard changing layout without
 * going away in between.
 *
 * Pinned top right, because the bottom belongs to the keyboard. Give it a `left`
 * and that wins.
 *
 * Configuration
 *   top     CSS length             180px
 *   right   CSS length             40px
 *   left    CSS length, wins over right when set   ()
 */

var host = document.createElement("div");
host.id = "myelin-probe-field";
host.style.top = ctx.config("top", "180px");

var left = ctx.config("left", "");
if (left) host.style.left = left;
else host.style.right = ctx.config("right", "40px");

// A shadow root, so the page's CSS cannot reshape this and its own cannot reach the
// page. The stylesheet comes as text because a <style> in the page's head does not
// reach inside one — that is what "shadow_css" in the manifest asks for.
var root = host.attachShadow({ mode: "open" });

var style = document.createElement("style");
style.textContent = ctx.css;
root.appendChild(style);

var box = document.createElement("div");
box.className = "box";

var title = document.createElement("div");
title.className = "title";
title.textContent = "probe-field";
box.appendChild(title);

function field(labelText, type, hint) {
  var wrap = document.createElement("label");
  wrap.className = "field";

  var label = document.createElement("span");
  label.className = "label";
  label.textContent = labelText;

  var input = document.createElement("input");
  input.type = type;
  input.placeholder = hint;

  wrap.appendChild(label);
  wrap.appendChild(input);
  box.appendChild(wrap);
  return input;
}

var text = field("Text — letters", "text", "type here");
var number = field("Number — keypad", "number", "0");

var readout = document.createElement("div");
readout.className = "readout";
box.appendChild(readout);

var events = 0;

function show() {
  readout.textContent =
    "text: " +
    JSON.stringify(text.value) +
    "   number: " +
    JSON.stringify(number.value) +
    "   input events: " +
    events;
}

[text, number].forEach(function (input) {
  input.addEventListener("input", function () {
    events++;
    show();
  });
});

show();
root.appendChild(box);
document.body.appendChild(host);
