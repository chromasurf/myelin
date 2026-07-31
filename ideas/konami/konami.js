/*
 * Konami Confetti — the "react to a secret gesture" idea, and the shortest whole
 * script there is. Two triggers, because a kiosk usually has no keyboard: the
 * classic sequence, or five quick taps into the top-left corner.
 *
 * Plain canvas, no library. Note that navbar takes both top corners for its own
 * buttons, so the tap trigger does not survive alongside it.
 *
 * Configuration
 *   taps     taps into the corner that set it off      5
 *   corner   size of the corner in px                  80
 *   within   seconds the taps have to fall inside      2
 *
 * Events
 *   emits   konami
 */

var TAPS = ctx.config("taps", 5);
var CORNER_PX = ctx.config("corner", 80);
var WITHIN_MS = ctx.config("within", 2) * 1000;

var SEQUENCE = [
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
  "b", "a"
];
var COLOURS = ["#e94f37", "#f6c453", "#44bba4", "#3d7ea6", "#eec6ca"];
var PIECES = 140;
var LIFETIME_MS = 2600;

var progress = 0;
var taps = [];

/* --- confetti --------------------------------------------------------- */

function burst() {
  var canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);

  // `pen`, not `ctx`: that name belongs to the script's own argument.
  var pen = canvas.getContext("2d");
  var pieces = [];

  for (var i = 0; i < PIECES; i++) {
    pieces.push({
      x: canvas.width / 2,
      y: canvas.height * 0.45,
      vx: (Math.random() - 0.5) * 18,
      vy: Math.random() * -16 - 4,
      size: 5 + Math.random() * 7,
      spin: (Math.random() - 0.5) * 0.3,
      angle: Math.random() * Math.PI,
      colour: COLOURS[(Math.random() * COLOURS.length) | 0]
    });
  }

  var started = null;

  function frame(now) {
    if (started === null) started = now;
    var elapsed = now - started;

    pen.clearRect(0, 0, canvas.width, canvas.height);

    pieces.forEach(function (p) {
      p.vy += 0.45; // gravity
      p.vx *= 0.995; // drag
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;

      pen.save();
      pen.translate(p.x, p.y);
      pen.rotate(p.angle);
      pen.globalAlpha = Math.max(0, 1 - elapsed / LIFETIME_MS);
      pen.fillStyle = p.colour;
      pen.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      pen.restore();
    });

    if (elapsed < LIFETIME_MS) {
      window.requestAnimationFrame(frame);
      return;
    }

    canvas.remove();
  }

  window.requestAnimationFrame(frame);
  ctx.emit("konami");
}

/* --- triggers --------------------------------------------------------- */

window.addEventListener("keydown", function (event) {
  var wanted = SEQUENCE[progress];
  var hit =
    event.key === wanted || (wanted.length === 1 && event.key.toLowerCase() === wanted);

  // A wrong key restarts, but may itself be the first of a fresh attempt.
  if (hit) progress++;
  else progress = event.key === SEQUENCE[0] ? 1 : 0;

  if (progress < SEQUENCE.length) return;

  progress = 0;
  burst();
});

window.addEventListener("pointerdown", function (event) {
  if (event.clientX > CORNER_PX || event.clientY > CORNER_PX) {
    taps = [];
    return;
  }

  var now = Date.now();
  taps.push(now);

  taps = taps.filter(function (t) {
    return now - t < WITHIN_MS;
  });

  if (taps.length < TAPS) return;

  taps = [];
  burst();
});
