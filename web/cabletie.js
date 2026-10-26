/**
 * ComfyUI Cable Tie
 * ---------------------------------------------------------------------------
 * Hold C and drag a line across wires to bundle them with a cable tie.
 * The band keeps itself square to the wires as nodes move; click a tie to
 * select it, drag the band to move it, and press Delete (or Backspace) to cut
 * it. The knob past the end of a selected band rotates it by hand — that pins
 * it, and double-clicking the knob hands it back to the wires.
 * Holding C and dragging across a tie, or double-clicking it, also cuts it.
 *
 * Tied wires are parallel offsets of one bundle centreline, so a ribbon keeps
 * the same gap all the way through. Bands and strands are springs: a new tie
 * grows out and gathers its wires in, a dragged tie trails and settles, and a
 * cut tie leaves a ghost that lets the wires fan back to their own curves.
 *
 * Built on "Zip Ties for ComfyUI" by Safzan Pirani (MIT):
 *   https://github.com/safzanpirani/comfyui-zip-ties
 * The ribbon routing, hit-testing, drag/cut gestures and undo integration are
 * theirs. The plain band, the C binding, selection, the rotate knob and the
 * automatic orientation are ours. Tie data uses the
 * same `extra.zipTies` records, so a workflow made with either extension shows
 * its ties in the other.
 */
import { app } from "../../scripts/app.js";

const EXTRA_KEY = "zipTies";
const ARM_CODE = "KeyC"; // physical key, so it works on any layout
const DIR = { NONE: 0, UP: 1, DOWN: 2, LEFT: 3, RIGHT: 4, CENTER: 5 };
const MARKER_NONE = 0;
const CONTROL_FACTOR = 0.25;
const SAMPLES = 32;
const BAR_HALF_WIDTH = 2.1; // half the band's thickness
const BAR_PAD = 3.2; // how far the band reaches past the outermost wire
const HANDLE_GAP_PX = 9; // gap between the band's end and the rotate knob
const HANDLE_RADIUS_PX = 4.5;
const ROTATE_SNAP = Math.PI / 12; // 15 degrees, while Shift is held
const DRAG_SLOP_PX = 3; // a click that drifts less than this is still a click
const HANDLE_COLOR = "#4da3ff";
const PINNED_COLOR = "#e8a33d"; // the knob after a hand rotation
const HIT_PAD_PX = 6;
const DOUBLE_CLICK_MS = 350;
const CINCH_START = 1.45; // how wide a new tie's bundle starts before it snaps in
const CINCH_MIN = 0.9; // the wires are never squeezed past this while it settles
const MAX_STEP = 1 / 15; // seconds; a stalled tab must not blow the springs up
// stiffness and damping, per second. Damping ratios land near 0.6, i.e. one
// clear overshoot and then still.
const SPRING = {
  pos: { k: 260, c: 20 },
  angle: { k: 150, c: 13 },
  cinch: { k: 210, c: 15 },
  release: { k: 120, c: 13 }, // how fast a tie lets go of, or takes hold of, its wires
};
const SETTLE = { pos: 0.02, angle: 0.002, cinch: 0.0015, release: 0.0015 };
const SETTLE_V = { pos: 0.6, angle: 0.05, cinch: 0.05, release: 0.05 };

const state = {
  keyHeld: false,
  hovered: null, // tie id
  selected: null, // tie id, the one showing the rotate knob
  drag: null, // { mode: "move" | "rotate", tie, ... }
  cut: null, // { start, end, pointerId }
  lastDown: { id: null, time: 0, pos: null },
  lastKnob: { id: null, time: 0 },
  rendering: false,
  endpoints: new Map(), // link id -> { a, b, sd, ed } captured from the last frame
  index: new Map(), // link id -> ties[]
  springs: new Map(), // tie -> the geometry actually drawn (see liveTie)
  ghosts: [], // ties that have been cut but are still letting go of their wires
  ghostCount: 0, // names the ghosts' springs, which outlive their tie's id
  lastFrame: 0,
  overlay: null,
};

// ---------- data ----------

function tiesOf(graph, create = false) {
  if (!graph) return [];
  graph.extra ??= {};
  let ties = graph.extra[EXTRA_KEY];
  if (!Array.isArray(ties)) {
    if (!create) return [];
    ties = graph.extra[EXTRA_KEY] = [];
  }
  return ties;
}

function getLink(graph, id) {
  return graph.getLink?.(id) ?? (graph.links instanceof Map ? graph.links.get(id) : graph.links?.[id]);
}

function allLinks(graph) {
  const links = graph.links;
  if (!links) return [];
  return links instanceof Map ? [...links.values()] : Object.values(links);
}

function nextTieId(ties) {
  let id = 1;
  for (const t of ties) id = Math.max(id, t.id + 1);
  // A ghost is still on screen holding that id, so a new tie must not take it.
  for (const g of state.ghosts) id = Math.max(id, g.id + 1);
  return id;
}

/** Drops link ids that no longer exist or now pass through reroutes, removes empty ties, rebuilds the index. */
function syncTies(graph) {
  state.index.clear();
  const ties = tiesOf(graph);
  for (let i = ties.length - 1; i >= 0; i--) {
    const tie = ties[i];
    tie.links = tie.links.filter((id) => {
      const link = getLink(graph, id);
      return link && link.parentId == null;
    });
    if (!tie.links.length) ties.splice(i, 1);
  }
  // Ask an empty list and the key goes too, so the workflow carries no trace of us.
  if (!ties.length) delete graph.extra[EXTRA_KEY];
  for (const tie of ties) indexTie(tie);
  // A tie that has just been cut still routes its wires while it lets go, so the
  // index carries the ghosts too. Nothing else does: they can't be picked,
  // dragged, cut or re-aimed (see stepSprings).
  for (const ghost of state.ghosts) indexTie(ghost);
}

function indexTie(tie) {
  for (const id of tie.links) {
    let list = state.index.get(id);
    if (!list) state.index.set(id, (list = []));
    list.push(tie);
  }
}

function commit(canvas) {
  canvas.setDirty(true, true);
  const ct = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  const capture = ct?.captureCanvasState ?? ct?.checkState;
  if (capture) capture.call(ct);
  else window.dispatchEvent(new MouseEvent("mouseup"));
}

// ---------- physics ----------

/**
 * A tie is never drawn straight from its stored geometry. Each one carries a
 * lagged copy of its position, angle and cinch that chases the real values
 * through a damped spring, and everything (the band, the wires through it, the
 * hit boxes) is drawn from that copy.
 *
 * That is the whole bounce: a tie you drag trails behind the cursor and
 * overshoots when you let go, a band swings as its wires are pulled around,
 * and a new tie snaps its bundle together instead of teleporting.
 */
function springOf(tie) {
  const key = springKey(tie);
  let s = state.springs.get(key);
  if (!s) {
    s = {
      px: tie.pos[0], py: tie.pos[1], pxVel: 0, pyVel: 0,
      angle: tie.angle ?? 0, angleVel: 0,
      cinch: 1, cinchVel: 0,
      release: 0, releaseVel: 0,
    };
    state.springs.set(key, s);
  }
  return s;
}

/** A ghost outlives the tie it came from, so it carries a key of its own. */
function springKey(tie) {
  return tie.key ?? tie.id;
}

/** The tie as it is actually drawn this frame. */
function liveTie(tie) {
  const s = springOf(tie);
  return {
    id: tie.id,
    links: tie.links,
    fixed: tie.fixed,
    pos: [s.px, s.py],
    angle: s.angle,
    cinch: s.cinch,
    release: s.release,
  };
}

/**
 * 0 while a tie holds its wires; 1 once it has let go of every one of them.
 * Clamped: the spring overshoots on purpose, but a release of 1.1 would push
 * the strands out the far side of the bundle and swap them over.
 */
function releaseOf(tie) {
  const r = tie?.release ?? 0;
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

/** A new tie arrives slack and loose, then cinches and gathers: the wires fan in. */
function seedCinch(tie) {
  const s = springOf(tie);
  s.px = tie.pos[0];
  s.py = tie.pos[1];
  s.angle = tie.angle ?? 0;
  s.cinch = CINCH_START;
  s.cinchVel = -1.5;
  s.release = 1;
  s.releaseVel = 0;
}

/**
 * A cut tie leaves a ghost behind: the record is gone from the workflow at
 * once, but the wires it held keep being routed through it while it springs
 * open, so they swing apart instead of snapping straight.
 */
function releaseTie(tie) {
  const s = springOf(tie);
  const ghost = {
    id: tie.id,
    key: `ghost-${state.ghostCount++}`,
    links: [...tie.links],
    fixed: true, // never re-aim: it is on its way out
    pos: [tie.pos[0], tie.pos[1]], // the spring target, which it keeps chasing
    angle: tie.angle ?? 0,
    ghost: true,
  };
  state.springs.set(ghost.key, {
    px: s.px, py: s.py, pxVel: s.pxVel, pyVel: s.pyVel,
    angle: s.angle, angleVel: s.angleVel,
    cinch: s.cinch, cinchVel: s.cinchVel,
    release: s.release, releaseVel: s.releaseVel,
  });
  state.ghosts.push(ghost);
  return ghost;
}

/**
 * One damped spring, semi-implicit Euler, sub-stepped so a slow frame behaves
 * like a fast one. Writes `o[key]` and `o[key + "Vel"]`, returns true while it
 * is still visibly moving.
 */
function springTo(o, key, target, cfg, dt, eps, maxVel, wrap) {
  const vkey = key + "Vel";
  let x = o[key];
  let v = o[vkey];
  let d = target - x;
  if (wrap) d = Math.atan2(Math.sin(d), Math.cos(d));
  const steps = Math.max(1, Math.ceil(dt * 120));
  const h = dt / steps;
  let moving = false;
  for (let i = 0; i < steps; i++) {
    v += (cfg.k * d - cfg.c * v) * h; // d already points at the target
    x += v * h;
    d = target - x;
    if (wrap) d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > eps || Math.abs(v) > maxVel) moving = true;
  }
  if (!moving) {
    o[key] = target;
    o[vkey] = 0;
    return false;
  }
  o[key] = x;
  o[vkey] = v;
  return true;
}

/** Moves every tie's drawn geometry one frame closer to its target. */
function stepSprings(graph, now) {
  let dt = (now - state.lastFrame) / 1000;
  state.lastFrame = now;
  if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
  dt = Math.min(dt, MAX_STEP);

  const seen = new Set();
  let busy = false;
  const step = (tie, releaseTarget) => {
    seen.add(springKey(tie));
    const s = springOf(tie);
    const moving =
      springTo(s, "px", tie.pos[0], SPRING.pos, dt, SETTLE.pos, SETTLE_V.pos, false) |
      springTo(s, "py", tie.pos[1], SPRING.pos, dt, SETTLE.pos, SETTLE_V.pos, false) |
      springTo(s, "angle", tie.angle ?? 0, SPRING.angle, dt, SETTLE.angle, SETTLE_V.angle, true) |
      springTo(s, "cinch", 1, SPRING.cinch, dt, SETTLE.cinch, SETTLE_V.cinch, false) |
      springTo(s, "release", releaseTarget, SPRING.release, dt, SETTLE.release, SETTLE_V.release, false);
    s.cinch = Math.max(CINCH_MIN, s.cinch);
    if (moving) busy = true;
    return s;
  };

  const ties = tiesOf(graph);
  for (const tie of ties) step(tie, 0); // a tie that exists is holding its wires

  // Ghosts let go: once one has fully released it is indistinguishable from an
  // untied wire, so it can go. One that has been undone out from under us (its
  // id is live again) goes at once, or the same band would be drawn twice.
  const live = new Set(ties.map((t) => t.id));
  for (let i = state.ghosts.length - 1; i >= 0; i--) {
    const ghost = state.ghosts[i];
    const s = step(ghost, 1);
    if (s.release >= 0.999 || live.has(ghost.id)) {
      state.springs.delete(ghost.key);
      seen.delete(ghost.key);
      state.ghosts.splice(i, 1);
    }
  }

  for (const key of state.springs.keys()) if (!seen.has(key)) state.springs.delete(key);
  return busy;
}

// ---------- geometry ----------

function spacing(canvas) {
  return (canvas.connections_width ?? 3) + 1.5;
}

/** 1 at rest; wider than 1 while a freshly made tie is still cinching. */
function cinchOf(tie) {
  return tie.cinch ?? 1;
}

function tieAxes(tie) {
  const c = Math.cos(tie.angle ?? 0);
  const s = Math.sin(tie.angle ?? 0);
  return { t: [c, s], n: [-s, c] };
}

function tieHalfLength(canvas, tie) {
  const span = ((tie.links.length - 1) * spacing(canvas) * cinchOf(tie)) / 2 + BAR_PAD;
  // A tie that is letting go shrinks out of the way as its wires fan apart.
  return span * (1 - releaseOf(tie));
}

/** Where this wire sits along the band, from the tie's centre. */
function strandOffset(canvas, tie, linkId) {
  const i = tie.links.indexOf(linkId);
  const gap = (i - (tie.links.length - 1) / 2) * spacing(canvas) * cinchOf(tie);
  return gap * (1 - releaseOf(tie));
}

function strandPoint(canvas, tie, linkId) {
  const { n } = tieAxes(tie);
  const off = strandOffset(canvas, tie, linkId);
  return [tie.pos[0] + n[0] * off, tie.pos[1] + n[1] * off];
}

/** Ties on this link, ordered from output to input. */
function orderedTies(linkId, a, b) {
  const list = state.index.get(linkId);
  if (!list?.length) return [];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return [...list].sort(
    (p, q) => (p.pos[0] - a[0]) * dx + (p.pos[1] - a[1]) * dy - ((q.pos[0] - a[0]) * dx + (q.pos[1] - a[1]) * dy),
  );
}

/** Segments the link is drawn as, in renderLink terms. */
function route(canvas, linkId, a, b, sd, ed) {
  const ties = orderedTies(linkId, a, b);
  if (!ties.length) return [{ a, b, sd, ed }];
  const views = ties.map(liveTie);

  // The wire on its own. Every segment blends back toward its own piece of
  // this as the tie it belongs to lets go, so a cut tie hands the wires back
  // exactly where they would have been — moving them, not popping them.
  const natural = segmentCubic({ p: a, dir: null }, { p: b, dir: null }, sd, ed);
  const us = [];
  let floor = 0;
  for (const v of views) {
    const u = Math.min(0.985, Math.max(floor + 0.015, nearestT(natural, v.pos)));
    us.push(u);
    floor = u;
  }
  const naturalSegs = subCubics(natural, us);

  // The chain of anchors this wire passes through, from its output to its
  // input. Everything between two anchors is one cubic of the *bundle's*
  // centreline, which each wire is then pushed sideways off (see offsetCubic).
  const chain = [{ p: a, dir: null }];
  for (const v of views) chain.push({ p: v.pos, dir: tieAxes(v).t, tie: v });
  chain.push({ p: b, dir: null });

  const segs = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const A = chain[i];
    const B = chain[i + 1];
    const base = segmentCubic(A, B, sd, ed);
    const d0 = A.tie ? strandOffset(canvas, A.tie, linkId) : 0;
    const d1 = B.tie ? strandOffset(canvas, B.tie, linkId) : 0;
    const off = offsetCubic(base, d0, d1);

    let p0 = off.p0;
    let p3 = off.p3;
    let c0 = [off.p0[0] + off.startControl[0], off.p0[1] + off.startControl[1]];
    let c1 = [off.p3[0] + off.endControl[0], off.p3[1] + off.endControl[1]];

    const r0 = releaseOf(A.tie);
    const r1 = releaseOf(B.tie);
    if (r0 > 0 || r1 > 0) {
      const nat = naturalSegs[i];
      const rs = Math.max(r0, r1); // the curve only relaxes once both its ends have
      // Ends follow their own anchor, so neighbouring segments still meet.
      p0 = mixPoint(p0, nat.p0, r0);
      p3 = mixPoint(p3, nat.p3, r1);
      c0 = mixPoint(c0, nat.c0, rs);
      c1 = mixPoint(c1, nat.c1, rs);
    }

    segs.push({
      a: p0,
      b: p3,
      sd: A.dir ? DIR.CENTER : sd,
      ed: B.dir ? DIR.CENTER : ed,
      startControl: [c0[0] - p0[0], c0[1] - p0[1]],
      endControl: [c1[0] - p3[0], c1[1] - p3[1]],
    });
  }
  return segs;
}

function mixPoint(p, q, t) {
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/** Parameter of the point on `seg` nearest `p`: a coarse scan, then bisection. */
function nearestT(seg, p) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const q = cubicPoint(seg, t);
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  let step = 1 / SAMPLES;
  for (let k = 0; k < 8; k++) {
    step /= 2;
    for (const t of [best - step, best + step]) {
      if (t < 0 || t > 1) continue;
      const q = cubicPoint(seg, t);
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
  }
  return best;
}

/** De Casteljau: the same curve as two cubics, meeting at `t`. */
function splitCubic(seg, t) {
  const lerp = (p, q) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const q0 = lerp(seg.p0, seg.c0);
  const q1 = lerp(seg.c0, seg.c1);
  const q2 = lerp(seg.c1, seg.p3);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const mid = lerp(r0, r1);
  return [
    { p0: seg.p0, c0: q0, c1: r0, p3: mid },
    { p0: mid, c0: r1, c1: q2, p3: seg.p3 },
  ];
}

/** `seg` cut into `us.length + 1` pieces, in order. */
function subCubics(seg, us) {
  const out = [];
  let rest = seg;
  let base = 0;
  for (const u of us) {
    const span = 1 - base;
    const t = span > 1e-9 ? Math.min(1, Math.max(0, (u - base) / span)) : 1;
    const [left, right] = splitCubic(rest, t);
    out.push(left);
    rest = right;
    base = u;
  }
  out.push(rest);
  return out;
}

function unit(x, y) {
  const len = Math.hypot(x, y);
  return len < 1e-9 ? null : [x / len, y / len];
}

/**
 * One segment of the bundle's centreline, in the same terms the canvas
 * renderer uses: a cubic from `p0` to `p3` with the two control points pulled
 * out along each end's direction.
 */
function segmentCubic(A, B, sd, ed) {
  const dist = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]) * CONTROL_FACTOR;
  const c0 = A.dir
    ? [A.p[0] + A.dir[0] * dist, A.p[1] + A.dir[1] * dist]
    : offsetByDir(A.p, sd || DIR.RIGHT, dist);
  const c1 = B.dir
    ? [B.p[0] - B.dir[0] * dist, B.p[1] - B.dir[1] * dist]
    : offsetByDir(B.p, ed || DIR.LEFT, dist);
  // The normals each wire is offset along at either end. These are perpendicular
  // to the wire itself, so they match the band's own normal when the band is
  // square to the wires.
  const sdir = A.dir ?? unit(c0[0] - A.p[0], c0[1] - A.p[1]) ?? [1, 0];
  const edir = B.dir ?? unit(B.p[0] - c1[0], B.p[1] - c1[1]) ?? [1, 0];
  return { p0: A.p, c0, c1, p3: B.p, n0: [-sdir[1], sdir[0]], n3: [-edir[1], edir[0]] };
}

function cubicPoint(seg, t) {
  const u = 1 - t;
  const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  return [
    w0 * seg.p0[0] + w1 * seg.c0[0] + w2 * seg.c1[0] + w3 * seg.p3[0],
    w0 * seg.p0[1] + w1 * seg.c0[1] + w2 * seg.c1[1] + w3 * seg.p3[1],
  ];
}

/** Unit normal of the centreline at `t`, or null when the curve stalls. */
function cubicNormal(seg, t) {
  const u = 1 - t;
  const dx = 3 * u * u * (seg.c0[0] - seg.p0[0]) + 6 * u * t * (seg.c1[0] - seg.c0[0]) + 3 * t * t * (seg.p3[0] - seg.c1[0]);
  const dy = 3 * u * u * (seg.c0[1] - seg.p0[1]) + 6 * u * t * (seg.c1[1] - seg.c0[1]) + 3 * t * t * (seg.p3[1] - seg.c1[1]);
  return unit(-dy, dx);
}

/**
 * The same segment pushed sideways: `d0` at the start, `d1` at the end.
 *
 * Offsetting the *curve* along its own normal (rather than moving the two
 * endpoints) is what keeps the wires the same distance apart all the way
 * through a bend — offset endpoints alone converge in the middle and let the
 * bundle bunch up. The offset curve is sampled and then refitted to a cubic,
 * so the canvas can still draw each wire in a single call.
 */
function offsetCubic(seg, d0, d1) {
  const p0 = [seg.p0[0] + seg.n0[0] * d0, seg.p0[1] + seg.n0[1] * d0];
  const p3 = [seg.p3[0] + seg.n3[0] * d1, seg.p3[1] + seg.n3[1] * d1];
  if (!d0 && !d1) {
    return { p0, p3, startControl: [seg.c0[0] - seg.p0[0], seg.c0[1] - seg.p0[1]], endControl: [seg.c1[0] - seg.p3[0], seg.c1[1] - seg.p3[1]] };
  }

  // Least squares for the two free control points, with both ends pinned: for
  // each sample,  w1*C0 + w2*C1 = sample - w0*P0 - w3*P3.
  let a11 = 0, a12 = 0, a22 = 0, bx0 = 0, bx1 = 0, by0 = 0, by1 = 0;
  let nx = seg.n0[0], ny = seg.n0[1];
  for (let i = 1; i < SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    const q = cubicPoint(seg, t);
    const n = cubicNormal(seg, t);
    if (n) {
      nx = n[0];
      ny = n[1];
    }
    const d = d0 + (d1 - d0) * t;
    const rx = q[0] + nx * d - w0 * p0[0] - w3 * p3[0];
    const ry = q[1] + ny * d - w0 * p0[1] - w3 * p3[1];
    a11 += w1 * w1;
    a12 += w1 * w2;
    a22 += w2 * w2;
    bx0 += w1 * rx;
    bx1 += w2 * rx;
    by0 += w1 * ry;
    by1 += w2 * ry;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-9) {
    return { p0, p3, startControl: [seg.c0[0] - seg.p0[0], seg.c0[1] - seg.p0[1]], endControl: [seg.c1[0] - seg.p3[0], seg.c1[1] - seg.p3[1]] };
  }
  const c0 = [(bx0 * a22 - bx1 * a12) / det, (by0 * a22 - by1 * a12) / det];
  const c1 = [(a11 * bx1 - a12 * bx0) / det, (a11 * by1 - a12 * by0) / det];
  return { p0, p3, startControl: [c0[0] - p0[0], c0[1] - p0[1]], endControl: [c1[0] - p3[0], c1[1] - p3[1]] };
}

function offsetByDir(p, dir, d) {
  switch (dir) {
    case DIR.LEFT: return [p[0] - d, p[1]];
    case DIR.RIGHT: return [p[0] + d, p[1]];
    case DIR.UP: return [p[0], p[1] - d];
    case DIR.DOWN: return [p[0], p[1] + d];
    default: return [p[0], p[1]];
  }
}

/** Polyline of one segment, matching the spline the link adapter draws. */
function segmentPolyline(canvas, seg) {
  const { a, b } = seg;
  if (canvas.links_render_mode !== undefined && canvas.links_render_mode !== 2) {
    // LINEAR (1) and STRAIGHT (0) links: a polyline through the endpoints is close enough for hit tests.
    return [a, b];
  }
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]) * CONTROL_FACTOR;
  const c0 = seg.startControl ? [a[0] + seg.startControl[0], a[1] + seg.startControl[1]] : offsetByDir(a, seg.sd || DIR.RIGHT, dist);
  const c1 = seg.endControl ? [b[0] + seg.endControl[0], b[1] + seg.endControl[1]] : offsetByDir(b, seg.ed || DIR.LEFT, dist);
  const out = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    out.push([w0 * a[0] + w1 * c0[0] + w2 * c1[0] + w3 * b[0], w0 * a[1] + w1 * c0[1] + w2 * c1[1] + w3 * b[1]]);
  }
  return out;
}

/** Intersection parameter (along p→q) of segments p→q and r→s, or null. */
function intersect(p, q, r, s) {
  const d1x = q[0] - p[0], d1y = q[1] - p[1];
  const d2x = s[0] - r[0], d2y = s[1] - r[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const ex = r[0] - p[0], ey = r[1] - p[1];
  const t = (ex * d2y - ey * d2x) / den;
  const u = (ex * d1y - ey * d1x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function tieBar(canvas, tie) {
  const h = tieHalfLength(canvas, tie);
  const { n } = tieAxes(tie);
  return [
    [tie.pos[0] - n[0] * h, tie.pos[1] - n[1] * h],
    [tie.pos[0] + n[0] * h, tie.pos[1] + n[1] * h],
  ];
}

function tieAt(canvas, graph, p) {
  const pad = HIT_PAD_PX / canvas.ds.scale;
  const ties = tiesOf(graph);
  for (let i = ties.length - 1; i >= 0; i--) {
    const tie = ties[i];
    const view = liveTie(tie);
    const { t, n } = tieAxes(view);
    const dx = p[0] - view.pos[0], dy = p[1] - view.pos[1];
    const along = dx * t[0] + dy * t[1];
    const across = dx * n[0] + dy * n[1];
    if (Math.abs(along) <= BAR_HALF_WIDTH + pad && Math.abs(across) <= tieHalfLength(canvas, view) + pad) return tie;
  }
  return null;
}

// ---------- selection ----------

function selectedTie(graph) {
  if (state.selected == null) return null;
  return tiesOf(graph).find((t) => t.id === state.selected) ?? null;
}

function selectTie(canvas, id) {
  if (state.selected === id) return;
  state.selected = id;
  // One selection at a time: picking a tie drops any selected nodes so Delete
  // can't be ambiguous.
  if (id != null) canvas.deselectAllNodes?.();
  canvas.setDirty(true, true);
}

function dropSelectionIfGone(graph) {
  if (state.selected == null) return;
  if (!tiesOf(graph).some((t) => t.id === state.selected)) state.selected = null;
}

function deleteTie(canvas, graph, tie) {
  // The record goes now; the ghost stays on the wires while they spring apart.
  releaseTie(tie);
  graph.extra[EXTRA_KEY] = tiesOf(graph).filter((t) => t !== tie);
  if (state.selected === tie.id) state.selected = null;
  if (state.hovered === tie.id) state.hovered = null;
  if (state.drag?.tie === tie) state.drag = null;
  syncTies(graph);
  commit(canvas);
}

/** Centre of the rotate knob: just past the top end of the band. */
function handlePoint(canvas, tie) {
  const k = 1 / (canvas.ds?.scale || 1);
  const { n } = tieAxes(tie);
  const d = tieHalfLength(canvas, tie) + (HANDLE_GAP_PX + HANDLE_RADIUS_PX) * k;
  return [tie.pos[0] - n[0] * d, tie.pos[1] - n[1] * d];
}

/** The selected tie, when `p` is on its rotate knob. */
function handleAt(canvas, graph, p) {
  const tie = selectedTie(graph);
  if (!tie) return null;
  const [hx, hy] = handlePoint(canvas, liveTie(tie));
  const reach = (HANDLE_RADIUS_PX + HIT_PAD_PX) / canvas.ds.scale;
  return Math.hypot(p[0] - hx, p[1] - hy) <= reach ? tie : null;
}

// ---------- orientation ----------

/**
 * The two anchors either side of this tie on one link: the previous tie's
 * strand (or the output end), and the next tie's strand (or the input end).
 * The wire's local direction at the tie is `next - prev`.
 */
function neighbours(canvas, graph, tie, linkId, ep) {
  const along = orderedTies(linkId, ep.a, ep.b);
  const i = along.indexOf(tie);
  if (i < 0) return [ep.a, ep.b];
  const at = (t) => strandPoint(canvas, liveTie(t), linkId);
  return [i > 0 ? at(along[i - 1]) : ep.a, i < along.length - 1 ? at(along[i + 1]) : ep.b];
}

/**
 * Wire direction at the tie, averaged over the wires it holds, or null when
 * nothing has been drawn yet. Independent of the tie's own angle, so this can
 * run every frame without feeding back on itself.
 */
function autoAngle(canvas, graph, tie) {
  let tx = 0, ty = 0, seen = 0;
  for (const id of tie.links) {
    const ep = state.endpoints.get(id);
    if (!ep) continue;
    const [prev, next] = neighbours(canvas, graph, tie, id, ep);
    const dx = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    tx += dx / len;
    ty += dy / len;
    seen++;
  }
  if (!seen || Math.hypot(tx, ty) < 1e-6) return null;
  return Math.atan2(ty, tx);
}

/**
 * Re-orients every tie that has not been rotated by hand, so the band stays
 * square to the wires as nodes move. Returns true if anything turned, which
 * asks the canvas for one more frame so the wires are redrawn on the new axes.
 */
function applyAutoAngles(canvas, graph) {
  let turned = false;
  for (const tie of tiesOf(graph)) {
    if (tie.fixed) continue;
    const angle = autoAngle(canvas, graph, tie);
    if (angle == null) continue;
    const delta = Math.atan2(Math.sin(angle - (tie.angle ?? 0)), Math.cos(angle - (tie.angle ?? 0)));
    if (Math.abs(delta) < 0.0087) continue; // under half a degree: leave it alone
    tie.angle = angle;
    turned = true;
  }
  return turned;
}

// ---------- cutting ----------

function applyCut(canvas, graph, p, q) {
  if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 4 / canvas.ds.scale) return;
  const ties = tiesOf(graph);

  // Cutting across an existing tie removes it.
  const cutTies = ties.filter((tie) => {
    const [r, s] = tieBar(canvas, liveTie(tie));
    return intersect(p, q, r, s) !== null;
  });
  if (cutTies.length) {
    for (const tie of cutTies) releaseTie(tie); // they let go of their wires as they go
    graph.extra[EXTRA_KEY] = ties.filter((t) => !cutTies.includes(t));
    syncTies(graph);
    dropSelectionIfGone(graph);
    commit(canvas);
    return;
  }

  // Otherwise tie every visible wire the line crosses.
  const hits = [];
  for (const link of allLinks(graph)) {
    if (link.parentId != null) continue;
    const ep = state.endpoints.get(link.id);
    if (!ep) continue;
    let best = null;
    for (const seg of route(canvas, link.id, ep.a, ep.b, ep.sd, ep.ed)) {
      const poly = segmentPolyline(canvas, seg);
      for (let i = 1; i < poly.length; i++) {
        const t = intersect(p, q, poly[i - 1], poly[i]);
        if (t === null || (best && t >= best.t)) continue;
        const dx = poly[i][0] - poly[i - 1][0], dy = poly[i][1] - poly[i - 1][1];
        const len = Math.hypot(dx, dy) || 1;
        best = { t, link, tangent: [dx / len, dy / len] };
      }
    }
    if (best) hits.push(best);
  }
  if (!hits.length) return;

  const point = (h) => [p[0] + (q[0] - p[0]) * h.t, p[1] + (q[1] - p[1]) * h.t];
  let tx = 0, ty = 0, cx = 0, cy = 0;
  for (const h of hits) {
    tx += h.tangent[0];
    ty += h.tangent[1];
    const pt = point(h);
    cx += pt[0];
    cy += pt[1];
  }
  const angle = Math.hypot(tx, ty) > 1e-6 ? Math.atan2(ty, tx) : 0;
  const n = [-Math.sin(angle), Math.cos(angle)];
  const pos = [cx / hits.length, cy / hits.length];
  hits.sort((h1, h2) => {
    const a = point(h1), b = point(h2);
    return (a[0] - b[0]) * n[0] + (a[1] - b[1]) * n[1];
  });

  // Keep the ribbon straight between ties: if an existing tie holds every new wire,
  // reuse its strand order so the wires cross outside the bundle, not inside it.
  const ids = hits.map((h) => h.link.id);
  const twin = tiesOf(graph).find((t) => ids.every((id) => t.links.includes(id)));
  if (twin) hits.sort((h1, h2) => twin.links.indexOf(h1.link.id) - twin.links.indexOf(h2.link.id));

  const all = tiesOf(graph, true);
  const tie = { id: nextTieId(all), pos, angle, links: hits.map((h) => h.link.id) };
  all.push(tie);
  seedCinch(tie); // arrives slack, then snaps shut
  syncTies(graph);
  commit(canvas);
}

// ---------- overlay for the sweep line ----------

const SWEEP_COLOR = "#4da3ff"; // about to gather wires
const CUT_COLOR = "#ff3b3b"; // about to remove a tie

function overlay() {
  if (state.overlay) return state.overlay;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;display:none";
  const line = document.createElementNS(svgNS, "line");
  line.setAttribute("stroke", SWEEP_COLOR);
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("opacity", "0.9");
  svg.appendChild(line);
  document.body.appendChild(svg);
  state.overlay = { svg, line };
  return state.overlay;
}

/** True when the sweep line crosses a tie, i.e. releasing would cut one. */
function sweepHitsTie(canvas, graph, p, q) {
  return tiesOf(graph).some((tie) => {
    const [r, s] = tieBar(canvas, liveTie(tie));
    return intersect(p, q, r, s) !== null;
  });
}

function showSweepLine(x1, y1, x2, y2, cutting) {
  const { svg, line } = overlay();
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("stroke", cutting ? CUT_COLOR : SWEEP_COLOR);
  svg.style.display = "block";
}

function hideSweepLine() {
  if (state.overlay) state.overlay.svg.style.display = "none";
}

// ---------- input ----------

function graphPoint(canvas, e) {
  const rect = canvas.canvas.getBoundingClientRect();
  return canvas.ds.convertCanvasToOffset([e.clientX - rect.left, e.clientY - rect.top]);
}

function isTyping(e) {
  const el = e.target;
  if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return true;
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
}

function setHovered(canvas, id) {
  if (state.hovered === id) return;
  state.hovered = id;
  canvas.setDirty(true, true);
}

function installInput(canvas) {
  const el = canvas.canvas;

  window.addEventListener("keydown", (e) => {
    if (isTyping(e)) return;

    if (e.code === ARM_CODE && !e.ctrlKey && !e.metaKey && !e.altKey) state.keyHeld = true;

    if (e.code === "Escape" && state.selected != null) {
      selectTie(canvas, null);
      return;
    }

    if ((e.code === "Delete" || e.code === "Backspace") && state.selected != null && canvas.graph) {
      const tie = selectedTie(canvas.graph);
      if (!tie) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      deleteTie(canvas, canvas.graph, tie);
    }
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.code === ARM_CODE) state.keyHeld = false;
  }, true);
  window.addEventListener("blur", () => (state.keyHeld = false));

  window.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !canvas.graph) return;
    const graph = canvas.graph;

    // A press anywhere off the canvas drops the tie selection, so Delete then
    // belongs to whatever the user just clicked.
    if (e.target !== el) {
      if (state.selected != null) selectTie(canvas, null);
      return;
    }

    const p = graphPoint(canvas, e);

    if (state.keyHeld) {
      e.preventDefault();
      e.stopImmediatePropagation();
      state.cut = { start: p, client: [e.clientX, e.clientY], pointerId: e.pointerId };
      showSweepLine(e.clientX, e.clientY, e.clientX, e.clientY, false);
      return;
    }

    const knob = handleAt(canvas, graph, p);
    if (knob) {
      e.preventDefault();
      e.stopImmediatePropagation();

      // Double-clicking the knob hands the tie back to the wires.
      const now = performance.now();
      if (state.lastKnob.id === knob.id && now - state.lastKnob.time < DOUBLE_CLICK_MS && knob.fixed) {
        state.lastKnob = { id: null, time: 0 };
        knob.fixed = false;
        const angle = autoAngle(canvas, graph, knob);
        if (angle != null) knob.angle = angle;
        commit(canvas);
        return;
      }
      state.lastKnob = { id: knob.id, time: now };

      // Measure the grab against the knob as it is drawn, not the stored pose,
      // so a tie that is still settling doesn't jump when you take hold of it.
      const live = springOf(knob);
      state.drag = {
        mode: "rotate",
        tie: knob,
        pointerId: e.pointerId,
        down: p,
        grabAngle: Math.atan2(p[1] - live.py, p[0] - live.px),
        startAngle: live.angle,
        moved: false,
      };
      el.style.cursor = "grabbing";
      return;
    }

    const tie = tieAt(canvas, graph, p);
    if (!tie) {
      // Empty canvas: drop the selection and let ComfyUI have the click.
      if (state.selected != null) selectTie(canvas, null);
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    selectTie(canvas, tie.id);

    const now = performance.now();
    const near = state.lastDown.pos;
    const sameSpot = near && Math.hypot(p[0] - near[0], p[1] - near[1]) <= 6 / canvas.ds.scale;
    if (state.lastDown.id === tie.id && sameSpot && now - state.lastDown.time < DOUBLE_CLICK_MS) {
      state.lastDown = { id: null, time: 0, pos: null };
      deleteTie(canvas, graph, tie);
      return;
    }
    state.lastDown = { id: tie.id, time: now, pos: p };
    state.drag = { mode: "move", tie, dx: tie.pos[0] - p[0], dy: tie.pos[1] - p[1], pointerId: e.pointerId, down: p, moved: false };
    el.style.cursor = "grabbing";
  }, true);

  window.addEventListener("pointermove", (e) => {
    if (state.cut && e.pointerId === state.cut.pointerId) {
      e.stopImmediatePropagation();
      const to = canvas.graph ? graphPoint(canvas, e) : state.cut.start;
      const cutting = canvas.graph ? sweepHitsTie(canvas, canvas.graph, state.cut.start, to) : false;
      showSweepLine(state.cut.client[0], state.cut.client[1], e.clientX, e.clientY, cutting);
      return;
    }
    if (state.drag && e.pointerId === state.drag.pointerId) {
      e.stopImmediatePropagation();
      const d = state.drag;
      const p = graphPoint(canvas, e);
      if (!d.moved && Math.hypot(p[0] - d.down[0], p[1] - d.down[1]) * canvas.ds.scale < DRAG_SLOP_PX) return;
      d.moved = true;
      if (d.mode === "rotate") {
        const live = springOf(d.tie);
        let delta = Math.atan2(p[1] - live.py, p[0] - live.px) - d.grabAngle;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        let angle = d.startAngle + delta;
        if (e.shiftKey) angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
        d.tie.angle = angle;
        d.tie.fixed = true; // rotated by hand: stop following the wires
      } else {
        d.tie.pos = [p[0] + d.dx, p[1] + d.dy];
      }
      canvas.setDirty(true, true);
      return;
    }
    if (e.target !== el || !canvas.graph || e.buttons) return;
    const graph = canvas.graph;
    const p = graphPoint(canvas, e);
    const tie = handleAt(canvas, graph, p) ?? tieAt(canvas, graph, p);
    setHovered(canvas, tie?.id ?? null);
    if (tie) {
      // Litegraph sets the cursor while handling the move; set ours afterwards.
      requestAnimationFrame(() => (el.style.cursor = "grab"));
    }
  }, true);

  const end = (e) => {
    if (state.cut && e.pointerId === state.cut.pointerId) {
      e.stopImmediatePropagation();
      const cut = state.cut;
      state.cut = null;
      hideSweepLine();
      if (e.type === "pointerup" && canvas.graph) applyCut(canvas, canvas.graph, cut.start, graphPoint(canvas, e));
      return;
    }
    if (state.drag && e.pointerId === state.drag.pointerId) {
      e.stopImmediatePropagation();
      const moved = state.drag.moved;
      state.drag = null;
      el.style.cursor = "";
      if (moved) commit(canvas);
      else canvas.setDirty(true, true);
    }
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}

// ---------- rendering ----------

/** `ctx.roundRect` is Chromium 99+; fall back to arcTo so the strap still draws. */
function roundedRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/**
 * A plain band across the bundle: one rounded bar, drawn in the tie's local
 * frame where the band runs along +y and the wires run along +x.
 *
 * The stroke is a full device pixel, so the band keeps a crisp silhouette at
 * any zoom level and on both the dark and the light ComfyUI canvas.
 */
function drawTie(canvas, ctx, tie, active) {
  const h = tieHalfLength(canvas, tie);
  if (h < 0.5) return; // on its way out: too short to be a band any more
  const k = 1 / (canvas.ds?.scale || 1); // 1 device pixel in graph units

  ctx.save();
  ctx.translate(tie.pos[0], tie.pos[1]);
  ctx.rotate(tie.angle ?? 0);
  ctx.lineWidth = Math.max(0.5, k);
  ctx.beginPath();
  roundedRect(ctx, -BAR_HALF_WIDTH, -h, BAR_HALF_WIDTH * 2, h * 2, BAR_HALF_WIDTH);
  ctx.fillStyle = active ? "#ffffff" : "#dfe4ec";
  ctx.strokeStyle = active ? "#4da3ff" : "rgba(12, 16, 24, 0.72)";
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** The rotate knob, drawn only for the selected tie. Filled means hand-set. */
function drawHandle(canvas, ctx, tie) {
  const k = 1 / (canvas.ds?.scale || 1); // 1 device pixel in graph units
  const { n } = tieAxes(tie);
  const h = tieHalfLength(canvas, tie);
  const [hx, hy] = handlePoint(canvas, tie);
  const colour = tie.fixed ? PINNED_COLOR : HANDLE_COLOR;

  ctx.beginPath();
  ctx.moveTo(tie.pos[0] - n[0] * h, tie.pos[1] - n[1] * h);
  ctx.lineTo(hx, hy);
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(0.5, k);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(hx, hy, HANDLE_RADIUS_PX * k, 0, Math.PI * 2);
  ctx.fillStyle = tie.fixed ? colour : "#ffffff";
  ctx.fill();
  ctx.strokeStyle = tie.fixed ? "#ffffff" : colour;
  ctx.lineWidth = Math.max(0.5, 1.4 * k);
  ctx.stroke();
}

function drawTies(canvas, ctx, graph) {
  const live = tiesOf(graph);
  // Ghosts are drawn too, shrinking: the band leaves as the wires fan out.
  const ties = state.ghosts.length ? [...live, ...state.ghosts] : live;
  if (!ties.length) return;
  ctx.save();
  for (const tie of ties) {
    const active = tie.id === state.hovered || tie.id === state.selected || state.drag?.tie === tie;
    drawTie(canvas, ctx, liveTie(tie), active);
  }
  const selected = selectedTie(graph);
  if (selected) drawHandle(canvas, ctx, liveTie(selected));
  ctx.restore();
}

function installRendering(canvas) {
  const proto = Object.getPrototypeOf(canvas);
  const origRenderLink = proto.renderLink;
  const origDrawConnections = proto.drawConnections;

  proto.renderLink = function (ctx, a, b, link, skipBorder, flow, color, sd, ed, opts = {}) {
    if (state.rendering || !link || link.parentId != null || opts.reroute || opts.startControl || opts.endControl || this.graph !== canvas.graph) {
      return origRenderLink.apply(this, arguments);
    }
    state.endpoints.set(link.id, { a: [a[0], a[1]], b: [b[0], b[1]], sd, ed });
    const ties = state.index.get(link.id);
    if (!ties?.length) return origRenderLink.apply(this, arguments);

    const active = ties.some((t) => t.id === state.hovered || t.id === state.selected || state.drag?.tie === t);
    const segColor = color ?? (active ? "#ffffff" : null);
    const segs = route(this, link.id, a, b, sd, ed);
    const marker = this.linkMarkerShape;
    state.rendering = true;
    try {
      // Draw every segment after the first without a centre marker, then the first one
      // last so the link's hit path and centre marker belong to the output-side segment.
      this.linkMarkerShape = MARKER_NONE;
      for (let i = 1; i < segs.length; i++) {
        const s = segs[i];
        origRenderLink.call(this, ctx, s.a, s.b, link, skipBorder, flow, segColor, s.sd, s.ed, { ...opts, startControl: s.startControl, endControl: s.endControl });
      }
      this.linkMarkerShape = marker;
      const s = segs[0];
      origRenderLink.call(this, ctx, s.a, s.b, link, skipBorder, flow, segColor, s.sd, s.ed, { ...opts, startControl: s.startControl, endControl: s.endControl });
    } finally {
      this.linkMarkerShape = marker;
      state.rendering = false;
    }
  };

  proto.drawConnections = function (ctx, ...rest) {
    const graph = this.graph;
    if (this !== canvas || !graph) return origDrawConnections.call(this, ctx, ...rest);
    syncTies(graph);
    dropSelectionIfGone(graph);
    // Re-aim the bands at the wires (using the endpoints measured last frame),
    // then let every spring take one step toward its target. Both happen before
    // the wires are drawn, so bands and wires always come from one pose.
    const turned = applyAutoAngles(canvas, graph);
    const ghostCount = state.ghosts.length;
    const moving = stepSprings(graph, performance.now());
    // A ghost that finished (or was undone) must leave the index before the
    // wires are drawn, or this one frame would draw the bundle twice.
    if (state.ghosts.length !== ghostCount) syncTies(graph);
    if (turned || moving) canvas.setDirty(true, true);
    const r = origDrawConnections.call(this, ctx, ...rest);
    drawTies(this, ctx, graph);
    return r;
  };
}

app.registerExtension({
  name: "nathan.cableTie",
  async setup() {
    const canvas = app.canvas;
    if (!canvas?.canvas) return;
    installRendering(canvas);
    installInput(canvas);
    window.__cabletie = state; // console handle: __cabletie.springs, .hovered, .selected
    console.info("[cabletie] ready \u2014 hold C and drag across wires. Click a tie to select, Delete to cut.");
  },
});
