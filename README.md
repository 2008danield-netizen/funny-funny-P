# havavamama

A web-based 3D interior design studio. Draw a floor plan, put doors and windows
in it, paint the rooms, furnish it with real products, and walk through it — in
the browser, with no install.

**Live app:** https://2008danield-netizen.github.io/VR-home-design-project/

> **Status: session 3 — furniture with real collision.** You can now furnish a
> plan from a catalogue of real products at real sizes, and nothing you place can
> end up inside a wall or inside another piece. The AI design advisor and the VR
> walkthrough are next.

---

## What it does today

**Draw and reshape a floor plan, in 3D.**
Drag corners and walls with the pointer; the whole plan is a live wall graph, so
moving one corner moves every wall that meets it. Draw new walls corner by
corner, split a wall to bend it, delete a corner and the walls either side heal
into one. Snapping pulls corners onto the grid, onto other corners, and onto
15-degree angles, which is what makes rooms actually close.

**Any shape, any number of rooms.**
Rooms are not stored — they are *detected* from the walls you draw. Close a loop
and a room appears, with its own floor, wall colour, ceiling and name. Add a
partition and one room becomes two, both inheriting the colour of the room they
came from. L-shaped, U-shaped, open plan, or a whole apartment.

**Real doors and windows.**
Eight presets at real dimensions — single, double and sliding doors, an open
doorway, casement, picture, floor-to-ceiling and clerestory windows. They are
genuinely cut through the wall, with frames, glazing bars, sills and reveals.
Doors are drawn standing open so you can see the floor area their swing uses.

**Furnish it, with things that fit.**
A catalogue of real IKEA products at their real published sizes — sofas, chairs,
dining and coffee tables, bookcases, wardrobes, chests, beds, desks, rugs and
lamps. Pick one, click inside a room, and it drops in. Pieces that belong against
a wall find one, turn to face the room and seat themselves flush.

**Collision that actually holds.**
Furniture cannot be placed or dragged into a wall or into another piece — not
"is highlighted red", but genuinely cannot. Push a sofa at a wall and it slides
along it. Turn a long table in a space too tight for it and the rotation is
refused rather than silently burying it. Move a wall through a sofa and the sofa
is pushed clear afterwards, so editing the plan never breaks the furniture. A
doorway is a real gap: you can push a chair from one room into another through
it, but not through the wall beside it. Rugs are the one exception — they lie on
the floor and everything stands on top of them.

**Materials and light.**
Nine procedurally generated floor materials (oak, walnut, ash, porcelain,
checkerboard, marble, concrete, two carpets), 16 curated wall paints plus a free
colour picker, four paint finishes, and four lighting moods with soft shadows.
Each room is painted independently, and any single wall face can override its
room's colour to become an accent.

**Precision without a 2D editor.**
Every drag projects the pointer onto the floor plane, so a wall tracks the
cursor exactly at any camera angle. Combined with the top-down **Plan** viewpoint
(press `4`), editing is as precise as a dedicated 2D plan editor. Every dimension
also has a numeric field in the inspector for when you need exactly 3.6 m.

**Never lose work.** Continuous autosave, full undo/redo, JSON export/import, PNG
screenshots — and designs saved by session 1 are migrated forward automatically.

---

## Running it locally

You need [Node.js](https://nodejs.org) 20 or newer — the LTS installer from that
page is all it takes. Check what you have with `node --version`.

```bash
git clone https://github.com/2008danield-netizen/VR-home-design-project.git
cd VR-home-design-project

npm install     # once, after cloning (and after any dependency change)
npm run dev     # start the dev server
```

Then open the URL it prints — **http://localhost:5173/VR-home-design-project/**.
Note the path on the end; the app is served from a sub-path so that local
development matches GitHub Pages exactly.

Edit any file under `src/` and the browser updates instantly without a refresh.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload — what you'll use day to day |
| `npm test` | Run the test suite (a couple of seconds, no browser needed) |
| `npm run build` | Type-check, test, and produce the production build |
| `npm run preview` | Serve the build exactly as GitHub Pages will |

### Tools and keys

| Key | Tool |
| --- | --- |
| `V` | **Select** — click to select, orbit freely |
| `M` | **Move** — drag corners, walls, doors and windows |
| `W` | **Wall** — click to place corners; walls chain as you go |
| `D` / `N` | **Door** / **Window** — click a wall to cut one |
| `F` | **Furnish** — pick from the catalogue, then click in a room |
| `G` | Toggle snapping |

| Key | Action |
| --- | --- |
| `1` `2` `3` `4` | Overview / Corner / Inside / Plan viewpoints |
| `R` / `Shift`+`R` | Rotate the selected furniture by 15° |
| `Ctrl`/`⌘` + `D` | Duplicate the selected furniture |
| `Delete` | Remove the selected wall, corner, opening or furniture |
| `Esc` | Cancel the current wall, tool, or selection |
| `Ctrl`/`⌘` + `Z` | Undo (add `Shift` to redo) |

Drag to orbit · right-drag or two fingers to pan · scroll to zoom.

---

## Deploying

Deployment is automatic: every push to `main` type-checks, runs the tests, builds
the app and publishes it to GitHub Pages via `.github/workflows/deploy.yml`.

**One-time setup**, needed once before the first deploy works:

1. Go to the repository's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.

That's it — no branch or folder to pick. If you later move havavamama to its own
domain, change `BASE_PATH` in `vite.config.ts` to `'/'`.

---

## How the code is organised

The guiding rule: **the 3D engine and the UI are separate programs that share one
piece of state.** React never touches Three.js objects, and the renderer never
re-renders a React component. Both subscribe to the same store.

```
UI panel  ──edit()──▶  designStore  ──notify──▶  Engine ──▶ Building / Lighting
Viewport  ──▶ EditController ──edit()──▶ designStore   (same loop)
                             └────────▶ editorStore ──▶ selection & tools
```

```
src/
├── state/            The design document — the single source of truth
│   ├── types.ts        Document shape + the conventions everything depends on
│   ├── store.ts        Observable store with undo/redo history
│   ├── planOps.ts      Structural edits: draw, split, delete, heal, normalise
│   ├── furnitureOps.ts Placing, moving, rotating — all through the solver
│   ├── selection.ts    Tool and selection state (view state, never saved)
│   ├── migrate.ts      Schema upgrades — session 1 designs still open
│   ├── defaults.ts     Starting document + validation of untrusted input
│   ├── units.ts        Metric ⇄ imperial, display-layer only
│   └── persistence.ts  Autosave, JSON export/import
│
├── core/             Rendering infrastructure
│   ├── Renderer.ts     WebGL setup, colour management, tone mapping, resizing
│   └── Engine.ts       Scene graph owner + render loop; the React⇄Three seam
│
├── physics/          Collision
│   ├── collision.ts    Oriented boxes, separating-axis tests, the solver
│   └── colliders.ts    Turning walls and furniture into colliders
│
├── furniture/        The catalogue
│   ├── catalog.ts      Real products, real dimensions, retailer-link fields
│   └── builders.ts     Procedural geometry, built from each piece's dimensions
│
├── interaction/      Direct 3D editing
│   ├── EditController.ts  Picking, dragging, drawing, placing openings
│   └── snapping.ts        Vertex / alignment / angle / grid snapping
│
├── scene/            What is actually in the world
│   ├── planGraph.ts    Wall graph maths + ROOM DETECTION (planar faces)
│   ├── Building.ts     Walls, floors, ceilings, skirtings, handles
│   ├── Furnishings.ts  Furniture meshes, shape cache, collision tinting
│   ├── wallBuilder.ts  Wall extrusion with holes; door and window furniture
│   ├── floorBuilder.ts Polygon floors, ceilings and skirting ribbons
│   ├── Lighting.ts     Lighting presets, IBL environment, shadow fitting
│   ├── openings/       Door and window catalogue
│   └── materials/      Procedural texture generation (noise → PBR maps)
│
├── controls/
│   └── CameraController.ts  Orbit controls, limits, eased viewpoints
│
├── bridge/           The React ⇄ store adapters
└── ui/               React interface (shell, toolbar, inspector, panels)
```

### Conventions worth knowing before you edit anything

1. **All lengths are stored in metres.** Y is up and the floor is `y = 0`. Feet
   and inches exist only in `state/units.ts`, at the point a human reads or types
   a number. IKEA and every other furniture catalogue publishes metric data.

2. **IDs are stable and opaque.** Never address a wall or corner by array index.
   Inserting a corner must not shuffle the colours the user already chose.

3. **The design document must stay JSON-serialisable.** No class instances, no
   Three.js objects, no functions. It is what gets autosaved, exported, handed to
   the AI advisor, and eventually synced to a server.

4. **Rooms are derived, never stored.** `findRegions` recomputes them from the
   walls, so they can never drift out of sync. Only their *appearance* is stored,
   keyed by which walls enclose them.

5. **Colour changes are free; geometry changes are not.** `Building.update()`
   only rebuilds meshes when a structural signature changes. Keep it that way.

6. **Dispose everything.** WebGL resources are not garbage-collected, and the
   plan can be rebuilt on every frame of a drag.

7. **Every structural edit ends with `normalizePlan`.** It merges coincident
   corners, drops degenerate and duplicate walls, prunes orphans and refits
   openings. Without it, a few minutes of dragging corrupts the graph.

8. **Every furniture move goes through the solver.** There is no code path in
   `furnitureOps` that writes a position without collision-checking it first.
   That is what makes the guarantee hold regardless of how the user got there.

9. **Furniture geometry is cached by SHAPE, not by item.** Twenty identical
   chairs share one set of buffers. Never dispose a shape's geometry when
   removing an item — the cache owns it.

### Tests

```bash
npm test
```

80 tests covering the parts where a bug is invisible on screen: room detection
(L-shapes, partitions, disconnected structures, winding, stable identity),
collision (penetration depth, sliding, wall-snap orientation, wedged pieces),
furniture placement end to end, structural plan edits, document validation, and
the schema migrations. They are pure logic — no browser, no GPU — so they run in
under a second and gate every deploy.

They have earned their place: they caught a separating-axis test that
under-reported penetration whenever one box's projection contained the other's
(so a sofa dropped on a thin wall never escaped it), a solver that never
terminated on exact contact, and a wall-snap that seated furniture facing into
the wall.

---

## Roadmap

- ~~**Session 1** — the room viewer.~~ ✅
- ~~**Session 2** — editable multi-room plans, doors and windows.~~ ✅
- ~~**Session 3** — furniture catalogue and hard collision.~~ ✅
- **Session 4 — clearance and ergonomics.** Collision keeps furniture out of
  solid things; clearance is the next layer — walkway widths, door-swing zones
  (the arcs are already drawn), drawer pull-out, and the distance from a sofa to
  a television. Plus a shopping list totalling a room's contents.
- **Session 5 — AI design advisor.** Reads the design document, critiques layout,
  circulation and colour, and suggests alternatives.
- **Session 6 — VR walkthrough.** WebXR immersive mode with teleport locomotion.
- **Later** — accounts, cloud sync, shared project links, subscription tiers, and
  a native app wrapping this same codebase.

---

## Catalogue data and trademarks

The furniture catalogue names real IKEA products. IKEA and those product names
are trademarks of Inter IKEA Systems B.V.; havavamama is not affiliated with,
endorsed by, or sponsored by IKEA. The names are used descriptively so a user can
recognise the piece they own or intend to buy.

The dimensions were **not** scraped — IKEA's terms prohibit that, and there is no
public API. They are written from general knowledge of the published nominal
sizes, so every entry carries `verifiedAt: null` to record that nobody has
checked it against a current listing. **Before this backs a paid product**, verify
each entry and settle the trademark position; IKEA runs affiliate and partner
programmes, which is the ordinary route to using product data properly. The
`retailer`, `sku` and `url` fields on every entry exist so a licensed feed can
fill them in later without touching any other code.

---

## Licence

Private project. All rights reserved.
