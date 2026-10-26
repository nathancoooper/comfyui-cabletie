# ComfyUI Cable Tie

Bundle wires on the ComfyUI canvas into a ribbon, cinched with a cable tie.

Hold **`C`** and drag a line across a bundle of wires — every wire the line
crosses is gathered into one tie. The wires keep their colours and run side by
side from then on.

| Action | Gesture |
|---|---|
| Tie wires together | Hold `C`, drag a line across the wires |
| Select a tie | Click it |
| Move a tie | Drag it |
| Rotate a tie by hand | Drag the knob above the band |
| Hand a rotated tie back to its wires | Double-click the knob |
| Remove a tie | Hold `C`, drag a line across it — or select it and press `Delete` / `Backspace` |
| Deselect | Click empty canvas, or press `Escape` |

Hovering or dragging a tie highlights every wire in it. A wire can pass through
several ties. When a wire is deleted or reconnected it leaves its ties, and a tie
with no wires left disappears. Moving a node drags the ribbon with it.

### Orientation

A tie keeps itself square to the wires as they move, so a ribbon always reads as
binding rather than a bar lying at a stray angle. Selecting a tie shows a knob on
one end of the band:

* **Auto** — hollow blue knob. The band follows the wires.
* **Pinned** — filled amber knob, set by dragging the knob. From then on the tie
  keeps the angle you gave it and ignores the wires.
* Double-click the knob to unpin, and the band snaps back onto the wires.
* Hold **`Shift`** while rotating to snap to 15° steps.

### Spacing

A tied bundle is routed from **one** centreline: each wire is the same curve
pushed sideways by a fixed amount along its own normal, so the strands run
parallel and keep the same gap the whole way through the tie — no crossing, no
pinching at the ends, and no wire slowly drifting into its neighbour as nodes
move. The offsets are sampled along the curve and fitted back to a single cubic,
so each wire is still drawn in one call.

### Feel

The bands and the wires are springs, not switches. A drag trails the cursor and
overshoots a little before it settles; a new tie grows out of nothing while its
wires are drawn in, and a deleted tie lets its wires go and they fan back out to
where they would have been. Nothing snaps, jumps or flickers at a boundary.

A cut tie animates on a **ghost** of itself: the record is gone from the workflow
immediately (save, load and undo all see it gone), but the wires keep routing
through it for the ~15 frames it takes to spring open, then it disappears. Add
the tie back before the animation ends (undo) and the ghost gives way at once.

The motion is tuned for a cable-tie-sized flick rather than a wobble — roughly
0.6 damping, so about one overshoot and done. If you want to change it, the
constants sit together near the top of `web/cabletie.js`:

| Constant | Effect |
|---|---|
| `SPRING.pos` / `.angle` / `.cinch` / `.release` | stiffness and damping per spring |
| `SETTLE`, `SETTLE_V` | how still a spring must be before it stops ticking |
| `CINCH_START` / `CINCH_MIN` | how much longer a brand-new band is than its rest length |
| `MAX_STEP` | longest timestep a frame may take (a stalled tab catches up, it doesn't leap) |

Ties draw on top of the wires, so a selected band never hides under a link. Only
one tie is selected at a time, and selecting a tie drops any node selection, so
`Delete` is never ambiguous.

Ties live in the workflow's `extra.zipTies`, so they save, load and undo with the
rest of the graph. A workflow opened without this extension still loads and its
wires draw normally.

## Notes and limits

* Wires routed through a **Reroute** node can't be tied — the geometry belongs to
  the reroute, not the link, so the tie would sit in the wrong place. Those wires
  are skipped.
* With **linear** or **straight** link rendering the cue/curve maths falls back to
  a straight line for hit testing. Use the default spline rendering for the best
  results.
* `C` is free in stock ComfyUI. If another extension binds it too, whichever
  handler runs first wins.

## Install

### ComfyUI Manager

Search for **ComfyUI-CableTie** in **Manager → Install Custom Nodes**, then restart.

### Manual

```sh
cd ComfyUI/custom_nodes
git clone https://github.com/nathancoooper/comfyui-cabletie.git
```

No Python dependencies, no models, no GPU work — this is a frontend-only
extension.

### ComfyUI Desktop (macOS / Windows)

Same thing: drop the folder in your install's `custom_nodes` folder. On macOS
that is usually `~/ComfyUI-Installs/ComfyUI/ComfyUI/custom_nodes/`, which you can
open from **ComfyUI Desktop → Settings → Open custom nodes folder**.

A **new** custom-node folder is only picked up when ComfyUI restarts (the Python
side has to load it). After that, changes to the JS alone need just a window
reload (`Cmd/Ctrl+R`).

After loading, the browser console prints:

```
[cabletie] ready — hold C and drag across wires. Click a tie to select, Delete to cut.
```

## Files

| File | Purpose |
|---|---|
| `__init__.py` | Registers `web/`; declares no compute nodes |
| `web/cabletie.js` | The whole extension |
| `pyproject.toml` | Metadata for the ComfyUI registry / Manager |
| `LICENSE` | MIT |

## How it works

Rather than painting over the canvas, this hooks the two places ComfyUI draws
links:

* **`LGraphCanvas.prototype.renderLink`** is wrapped so every tied link is drawn
  as several segments, each ending at a strand of the tie. Colours, borders,
  arrows and the moving-dot "flow" effect all still come from ComfyUI's own
  renderer — it is the same wire, just bent. The wrapper records each link's real
  endpoints as it goes, which is how the intersection test knows where the wires
  are without re-deriving node geometry.
* **`drawConnections`** clears that endpoint map, prunes dead ties and then draws
  the bands in graph space, so they pan and zoom with the wires. It is also where
  an unpinned tie re-derives its angle: the recorded endpoints say which way each
  wire is running through the tie, and the band turns square to that average. The
  angle is only rewritten when it has actually moved (more than half a degree), so
  a still graph doesn't redraw every frame.

Both wrappers bail out of anything they don't own — already-internal calls,
reroutes, custom control points, and a different graph on the same canvas — and
undo is registered through the workflow's own `changeTracker`, so `Cmd/Ctrl+Z`
reverts a tie exactly like any other graph edit.

Everything you see comes from the springs' **live** state, never from the stored
record: the record is only the target. `drawConnections` steps them (sub-stepped
at 120 Hz, with a `MAX_STEP` clamp so a backgrounded tab can't jump), re-routes
the wires from where they actually are, then draws. A tie that is letting go
blends its segment back toward the link's own curve — its endpoints, then the
shape of the curve, control points, and the strand offsets — so the wires are
handed back to the renderer exactly where it would have drawn them.

The redraw loop is ComfyUI's: a spring that is still moving marks the canvas
dirty and the next frame steps it again, so an idle graph costs nothing.

## Credits

Forked from [**Zip Ties for ComfyUI**](https://github.com/safzanpirani/comfyui-zip-ties)
by [Safzan Pirani](https://github.com/safzanpirani) (MIT). The ribbon routing,
hit-testing, drag/cut gestures and undo integration are his work; this fork adds
the plain cable-tie band (no buckle or tail), the `C` binding, selection with the
rotate knob and pin, automatic orientation, and `Delete` / `Escape` handling. The
original idea came from a
[prototype by @cmzw_](https://x.com/cmzw_/status/2114315567977107653).

Because the tie records share upstream's `extra.zipTies` format, a workflow made
with either extension displays correctly in the other.

## License

MIT — see `LICENSE`.
