# havavamama

A web-based 3D interior design studio. Build a room, paint the walls, lay the
floor, and walk through it — in the browser, with no install.

**Live app:** https://2008danield-netizen.github.io/VR-home-design-project/

> **Status: session 1 — the room viewer.** This is the foundation: an empty,
> fully-adjustable room with real-time materials and lighting. Furniture,
> collision, the AI design advisor and VR walkthrough are the roadmap below.

---

## What it does today

- **A real room.** Four walls, floor, ceiling and skirting boards, built from
  live dimensions rather than a hardcoded box.
- **Resize anything.** Width, depth, ceiling height and wall thickness update the
  geometry as you drag, with floor area, perimeter and volume computed live.
- **Metric or imperial.** Everything is stored in metres; the unit toggle only
  changes what you read, never the design.
- **Paint each wall separately.** 16 curated interior colours, a free colour
  picker, four paint finishes (matte → gloss), and an "apply to all" shortcut.
- **Nine floor materials.** Oak, walnut and ash plank; porcelain, checkerboard
  and Carrara marble; polished concrete; wool and charcoal carpet. All generated
  procedurally in code — no texture files, no licensing, ~700 KB total download.
- **Four lighting moods.** Daylight, overcast, evening and studio, with a
  brightness dial and toggleable soft shadows.
- **Navigate naturally.** Orbit, pan and zoom, plus four one-click viewpoints
  including a plan view and standing inside at eye height. Walls between you and
  the room hide themselves automatically as you orbit.
- **Never lose work.** The design autosaves to your browser continuously, with
  full undo/redo, JSON export/import and PNG screenshot capture.

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
| `npm run build` | Type-check and produce the production build in `dist/` |
| `npm run preview` | Serve `dist/` exactly as GitHub Pages will |
| `npm run typecheck` | Type-check without building |

### Keyboard

| Key | Action |
| --- | --- |
| `1` `2` `3` `4` | Overview / Corner / Inside / Plan viewpoints |
| `Ctrl`/`⌘` + `Z` | Undo |
| `Ctrl`/`⌘` + `Shift` + `Z` | Redo |
| Drag | Orbit · Right-drag or two fingers: pan · Scroll: zoom |

---

## Deploying

Deployment is automatic: every push to `main` builds the app and publishes it to
GitHub Pages via `.github/workflows/deploy.yml`.

**One-time setup**, needed once before the first deploy works:

1. Go to the repository's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.

That's it — no branch or folder to pick. The next push to `main` goes live at the
URL at the top of this file. You can also trigger a rebuild by hand from the
**Actions** tab without pushing anything.

If you later move havavamama to its own domain, change `BASE_PATH` in
`vite.config.ts` to `'/'`.

---

## How the code is organised

The guiding rule: **the 3D engine and the UI are separate programs that share one
piece of state.** React never touches Three.js objects, and the renderer never
re-renders a React component. Both subscribe to the same store.

```
UI panel  ──edit()──▶  designStore  ──notify──▶  Engine ──▶ Room / Lighting
                            │
                            └──notify──▶  React panels (via useSyncExternalStore)
```

```
src/
├── state/            The design document — the single source of truth
│   ├── types.ts        Document shape + the conventions everything depends on
│   ├── store.ts        Observable store with undo/redo history
│   ├── defaults.ts     Starting document + validation of untrusted input
│   ├── units.ts        Metric ⇄ imperial, display-layer only
│   └── persistence.ts  Autosave, JSON export/import
│
├── core/             Rendering infrastructure
│   ├── Renderer.ts     WebGL setup, colour management, tone mapping, resizing
│   └── Engine.ts       Scene graph owner + render loop; the React⇄Three seam
│
├── scene/            What is actually in the room
│   ├── roomGeometry.ts Model → geometry. THE SEAM for future editable walls
│   ├── Room.ts         Floor, ceiling, walls, skirting; rebuild vs. restyle
│   ├── Lighting.ts     Lighting presets, IBL environment, shadow fitting
│   └── materials/      Procedural texture generation
│       ├── noise.ts            Seeded value noise + fBm
│       ├── generators.ts       Wood, tile, concrete, carpet, marble
│       ├── presets.ts          The catalogue shown in the UI
│       ├── textureUtils.ts     Canvas helpers, height → normal map
│       └── MaterialLibrary.ts  Material creation, caching and disposal
│
├── controls/
│   └── CameraController.ts  Orbit controls, limits, eased viewpoint transitions
│
├── bridge/           The React ⇄ store adapters
│   ├── useDesign.ts            Subscribe to the document or a slice of it
│   ├── useAutosave.ts          Debounced persistence
│   └── useKeyboardShortcuts.ts Global keys
│
└── ui/               React interface
    ├── App.tsx         Shell and layout
    ├── Viewport.tsx    Owns the engine's lifetime; renders no 3D itself
    ├── components/     Reusable controls
    ├── panels/         Room, Walls, Floor, Ceiling & Light, View, Project
    └── theme.css       Design tokens and all styling
```

### Conventions worth knowing before you edit anything

1. **All lengths are stored in metres.** Y is up, the floor is `y = 0`, and the
   room is centred on the origin. Feet and inches exist only in `state/units.ts`
   at the point a human reads or types a number. IKEA and every other furniture
   catalogue publishes metric data, so metric storage means zero conversion where
   it matters most.

2. **The design document must stay JSON-serialisable.** No class instances, no
   Three.js objects, no functions. It is what gets autosaved, exported, handed to
   the AI advisor, and eventually synced to a server.

3. **Colour changes are free; dimension changes are not.** `Room.update()` only
   rebuilds geometry when a dimension actually changed. Keep it that way — it is
   why dragging a colour picker feels instant.

4. **Dispose everything.** WebGL resources are not garbage-collected. Every
   geometry, material and texture created has a matching `dispose()`. The room
   can be rebuilt hundreds of times a second while a slider is dragged, so a leak
   here exhausts GPU memory in minutes.

5. **`scene/roomGeometry.ts` is the seam.** Nothing downstream reads `width` and
   `depth` directly — it all consumes `WallSegment[]`. When editable, arbitrary
   room shapes arrive, that one file changes and the rest keeps working.

---

## Roadmap

Session 1 (this) is the foundation. The order below is roughly dependency order.

- **Session 2 — editable walls.** Click to select a wall, drag it to move or
  resize, add and remove walls, L-shaped and open-plan rooms. Doors and window
  openings. This is what `roomGeometry.ts` was designed around.
- **Session 3 — furniture.** A catalogue with real IKEA dimensions, drag and drop
  placement, selection and transform gizmos, saved into the design document.
- **Session 4 — collision.** Furniture that physically cannot overlap a wall or
  another piece, plus clearance rules (walkways, door swings, drawer pull-out).
- **Session 5 — AI design advisor.** Reads the design document, critiques layout,
  circulation and colour, and suggests alternatives.
- **Session 6 — VR walkthrough.** WebXR immersive mode with teleport locomotion.
- **Later** — accounts, cloud sync, shared project links, subscription tiers, and
  a native app wrapping this same codebase.

---

## Licence

Private project. All rights reserved.
