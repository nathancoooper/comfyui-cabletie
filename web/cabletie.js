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
  return id;
}

/** Drops link ids that no longer exist or now pass through reroutes, removes empty ties, rebuilds the index. */
function syncTies(graph) {
  state.index.clear();
  const ties = tiesOf(graph);
  if (!ties.length) {
    // Ask an empty list and the key goes too, so the workflow carries no trace of us.
    delete graph.extra[EXTRA_KEY];
    return;
  }
  for (let i = ties.length - 1; i >= 0; i--) {
    const tie = ties[i];
    tie.links = tie.links.filter((id) => {
      const link = getLink(graph, id);
      return link && link.parentId == null;
    });
    if (!tie.links.length) ties.splice(i, 1);
  }
  for (const tie of ties) {
    for (const id of tie.links) {
      let list = state.index.get(id);
      if (!list) state.index.set(id, (list = []));
      list.push(tie);
    }
  }
  if (!ties.length) delete graph.extra[EXTRA_KEY];
}

function commit(canvas) {
  canvas.setDirty(true, true);
  const ct = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  const capture = ct?.captureCanvasState ?? ct?.checkState;
  if (capture) capture.call(ct);
  else window.dispatchEvent(new MouseEvent("mouseup"));
}

// ---------- geometry ----------

function spacing(canvas) {
  return (canvas.connections_width ?? 3) + 1.5;
}

function tieAxes(tie) {
  const c = Math.cos(tie.angle ?? 0);
  const s = Math.sin(tie.angle ?? 0);
  return { t: [c, s], n: [-s, c] };
}

function tieHalfLength(canvas, tie) {
  return ((tie.links.length - 1) * spacing(canvas)) / 2 + BAR_PAD;
}

function strandPoint(canvas, tie, linkId) {
  const i = tie.links.indexOf(linkId);
  const off = (i - (tie.links.length - 1) / 2) * spacing(canvas);
  const { n } = tieAxes(tie);
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
  const pts = ties.map((t) => ({ p: strandPoint(canvas, t, linkId), dir: tieAxes(t).t }));
  const segs = [];
  let prev = { p: a, dir: null };
  for (const cur of [...pts, { p: b, dir: null }]) {
    const dist = Math.hypot(cur.p[0] - prev.p[0], cur.p[1] - prev.p[1]) * CONTROL_FACTOR;
    const seg = { a: prev.p, b: cur.p, sd: prev.dir ? DIR.CENTER : sd, ed: cur.dir ? DIR.CENTER : ed };
    if (prev.dir) seg.startControl = [prev.dir[0] * dist, prev.dir[1] * dist];
    if (cur.dir) seg.endControl = [-cur.dir[0] * dist, -cur.dir[1] * dist];
    segs.push(seg);
    prev = cur;
  }
  return segs;
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
    const { t, n } = tieAxes(tie);
    const dx = p[0] - tie.pos[0], dy = p[1] - tie.pos[1];
    const along = dx * t[0] + dy * t[1];
    const across = dx * n[0] + dy * n[1];
    if (Math.abs(along) <= BAR_HALF_WIDTH + pad && Math.abs(across) <= tieHalfLength(canvas, tie) + pad) return tie;
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
  const [hx, hy] = handlePoint(canvas, tie);
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
  const at = (t) => strandPoint(canvas, t, linkId);
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
    const [r, s] = tieBar(canvas, tie);
    return intersect(p, q, r, s) !== null;
  });
  if (cutTies.length) {
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
  all.push({ id: nextTieId(all), pos, angle, links: hits.map((h) => h.link.id) });
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
    const [r, s] = tieBar(canvas, tie);
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

      state.drag = {
        mode: "rotate",
        tie: knob,
        pointerId: e.pointerId,
        down: p,
        grabAngle: Math.atan2(p[1] - knob.pos[1], p[0] - knob.pos[0]),
        startAngle: knob.angle ?? 0,
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
        let delta = Math.atan2(p[1] - d.tie.pos[1], p[0] - d.tie.pos[0]) - d.grabAngle;
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
  const ties = tiesOf(graph);
  if (!ties.length) return;
  // Square the bands up to the wires before drawing, then ask for one more
  // frame when a band turned so the wires are redrawn on the new axes.
  if (applyAutoAngles(canvas, graph)) canvas.setDirty(true, true);
  ctx.save();
  for (const tie of ties) {
    const active = tie.id === state.hovered || tie.id === state.selected || state.drag?.tie === tie;
    drawTie(canvas, ctx, tie, active);
  }
  const selected = selectedTie(graph);
  if (selected) drawHandle(canvas, ctx, selected);
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
    state.endpoints.clear();
    syncTies(graph);
    dropSelectionIfGone(graph);
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
    console.info("[cabletie] ready \u2014 hold C and drag across wires. Click a tie to select, Delete to cut.");
  },
});
