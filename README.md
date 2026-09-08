# havavamama

A web-based 3D interior design studio. Draw a floor plan, put doors and windows
in it, paint the rooms, furnish it with real products that genuinely fit, and
walk through it — in the browser, with no install.

**Live app:** https://2008danield-netizen.github.io/funny-funny-P/

> **Status: session 8 — it can be your actual house.** Bring in the floor plan
> you already have — a PDF from an agent or an architect, a scan, or a
> photograph of a printed sheet — set its scale from one length you know, and
> the app finds the walls for you to accept. Everything from the previous seven
> sessions then applies to a real building: rooms, furniture, storeys and
> stairs, a roof that follows the footprint, and the code checks with the
> section number printed beside every finding. Next come the services:
> electrical, water, drainage and heating.

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

**Does it work, not just does it fit.**
Collision answers whether a wardrobe fits in an alcove. Clearance answers whether
its doors can open once it is there. The app checks door swings, drawer and door
pull-out space, legroom in front of seating, room to pull a dining chair out and
walk behind it, access down the sides of a bed, and the width of the route
through each room. Problems are listed in plain language with the measurement
that failed — *"narrows to 62 cm; the guideline is 90 cm"* — and drawn as zones
on the floor so you can see what they mean. Click any issue to select the piece
causing it.

Guidance is **advisory by default**, because a tight walkway in a small flat may
be exactly the right trade and the app has no business refusing it. A strict mode
turns the hard rules — door swings, pull-out space — into constraints the solver
enforces as it does walls. Advisory guidance is never enforced, even then.

**A shopping list that totals up.**
Every piece in the plan, grouped by product, with quantities, dimensions, which
rooms they are in, and a running total. Prices ship as rough estimates so the
totals work immediately, and **every estimated figure is labelled as one** — at
the line, at the total and in the CSV export. Type a real price over any of them
and it counts as confirmed.

**A building, not a single floor.**
Add storeys, each with its own walls, rooms, furniture and ceiling height. A new
floor traces the one below so you are editing a plan rather than redrawing it,
and the storey underneath shows as a faint outline to line new walls up against.
You work on one level at a time; everything else — the inspector, the catalogue,
the clearance report, the advisor — follows you to it.

**Staircases that are checked, not just drawn.**
Straight, L-shaped, U-shaped, winder and spiral, each cutting its own opening
through the floor above — derived from where **headroom** actually runs out, so
the cupboard under the stairs stays solid floor and the staircase never arrives
at a ceiling.

The riser height is never stored, only derived: the floor-to-floor rise divided
by however many steps you want. That makes the most-cited stair defect in the
country — a step out of pattern with the others — impossible rather than merely
reported, and it means raising a ceiling re-proportions the stairs instead of
silently invalidating them.

Then every one is checked against the **2021 IRC**, with the section printed
beside the finding: riser height (R311.7.5.1), tread depth (R311.7.5.2), winder
depth at the walkline (R311.7.5.2.1), spirals under their own rules
(R311.7.10.1), width (R311.7.1), landings (R311.7.6), flight rise (R311.7.3),
handrails (R311.7.8) and guards around the opening (R312.1). Each says what it
measured, what the limit is, where that comes from, and the arithmetic that
would fix it — *"three winders across a 90° turn need a 7 in newel to hold 10 in
at the walkline"*, not *"this does not comply"*.

**A design advisor that shows its working.**
Fourteen rules drawn from published interior-design guidance — focal points,
conversation distance, coffee-table reach, rug sizing, visual balance, scale,
alignment, layered lighting, colour contrast and temperature, bed and desk
placement, and a laid dining table. Every finding states **the measurement and
the guideline it failed** (*"the reach is 82 cm; the guideline is 30–45 cm"*),
the principle behind it, and — where the app is confident the change is safe —
a button that makes it for you. It praises what is right as well as flagging
what is not, gives the design a score out of 100, and says plainly that it is a
list of rules rather than an opinion about your taste.

It is deliberately **not** an LLM. It runs offline, instantly, for free, gives
the same answer twice, and is explicit enough about its arithmetic that a model
added later has something to check itself against rather than something to
replace.

**Furnish a room for me.**
Pick living room, bedroom, dining room or workspace, a palette and an optional
budget, and the app lays the room out from an empty floor: the anchor piece on
the best wall for it, then everything defined relative to that — coffee table at
a proper reach, rug reaching under the whole seating group, bedsides flanking
the headboard, chairs set round the table, the desk turned so daylight falls to
the side of the screen. Then it **takes pieces back out** until you can walk
through the room, and tells you what it removed and why. It arrives as one undo
step.

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

**Trace the plan you already have.**
Nobody draws their own house from memory. Import a PDF page, an image, or a
photograph of a printed sheet; if it is a photograph, mark the four corners and
it is redrawn as though the camera had been square on. Then click the two ends
of something whose length you know — an outside wall, or a dimension already
printed on the plan — and everything after that is in real metres.

**And let it find the walls.**
A Hough transform over the ink finds the lines, which survives dashes, speckle
and the arrows drawn across a wall. A wall on a plan is drawn as its two faces,
so parallel pairs the right distance apart are recombined into one centreline
with a real thickness — otherwise tracing gives you two walls per wall and every
room measures wrong. What comes back is *proposed*, never applied: you tick the
ones that are right and they arrive as a single change, so one undo takes the
whole trace back out. Accepting turns walls that are nearly on the grid exactly
onto it — a two-degree scan otherwise gives a house with no square corners
anywhere — and joins corners that nearly meet, which is what makes the rooms
close.

**A roof that follows the plan.**
Hip, gable, shed and flat. The ridges, hips and valleys are not drawn — they are
computed from the walls by a straight skeleton, so an L-shaped house gets its
valley and a cross-shaped one gets all four, and the roof still fits after you
drag a wall. Pitch, overhang, covering and colour; gable any end you like, or
let the app gable the ends of the main ridge, which is what most people mean.
Eaves stand off the outside of each wall by that wall's own thickness.

**Dormers and skylights.**
Gable, shed and hipped dormers, each with its own window; fixed or venting
skylights on a curb. How far a dormer reaches back up the slope is *not* a
setting — a dormer's roof runs back until it dies into the roof it is cut into,
and where that happens follows from the face height and the two pitches. Put one
somewhere it cannot be built and the app says so instead of drawing it anyway.

**The site.**
Ground that is flat, falls one way, or is interpolated between surveyed spot
heights — with the cut and fill volumes for levelling a pad under the building,
because a sloping plot costs money and that is worth knowing early. A plot
boundary, a north point that everything else is measured from, and zoning
setbacks with the buildable area drawn on the ground. Lot coverage, in percent.

**The outside of the building.**
Seven exterior finishes — lap siding, board and batten, shingle, brick, stone,
stucco and fibre cement — at real exposures, so a rendered elevation is the same
size as the building. Any wall can differ from the rest. Then the takeoff a
builder would price from: wall area net of its openings, gable ends, roof
measured on the slope rather than in plan, and the eave, ridge, hip, valley and
rake lengths that fascia and flashing are sold by.

**Wire it, to the code.**
Press one button and the app lays out receptacles, switches, lights and smoke
alarms to satisfy the NEC's spacing rules — the six-foot rule walked wall by
wall, not "an outlet every twelve feet" — then groups them onto circuits room by
room, with the two small-appliance circuits, the bathroom circuit and the laundry
circuit Article 210 demands, GFCI and AFCI where the code names them. Everything
it placed is then yours: click a device in the 3D view to drag it, retype it or
delete it, and a receptacle or a switch stays flush against the nearest wall and
turns to face into the room.

**All the way to the panel schedule.**
Every circuit with its breaker, its conductor, its protection and how hard it is
worked; and the service sized by a full Article 220 optional-method calculation
that shows its working line by line — 3 VA a square foot, the small-appliance
and laundry circuits, the fixed appliances, then the demand factor that is the
whole point of the method. Heating and cooling are yours to enter, and the
calculation says so rather than quietly assuming zero.

**Fit the kitchen and the bathroom.**
Press one button and the app reads the room's shape, doors and windows and
proposes cabinetry — the sink under the window, the hob on a different run,
nothing across a doorway, and a corner unit where the run turns so two doors
don't open into the same square. The units are real module widths, and the run
is solved rather than filled greedily: 3.05 m comes out 1000 + 1000 + 600 + 450
exactly, where taking the widest that fits each time leaves 50 mm of blank panel
in the middle of the kitchen. Or draw it yourself, a run at a time — a rough
drag near a wall snaps onto it and fills as it goes.

A bathroom is the opposite problem, and is solved the opposite way: three large
objects into a room that is usually too small, each needing clear floor the code
specifies to the inch. Fixtures are placed hardest-first and each is checked
against its clearance *before* it is committed, so the app never draws a
bathroom that cannot be built and then apologises underneath.

**And the electrical stops guessing.**
Two things the wiring used to have to assume — where the counter is and where
the basin is — are now things the model knows. Counter receptacles follow the
real worktop under NEC 210.52(C), the basin receptacle goes at the basin under
210.52(D), and the cooker, oven, dishwasher and washing machine each get their
own circuit sized from their nameplate and their load into the Article 220
calculation. The two apologies are withdrawn when they no longer apply, and
still printed when they do.

**Water and drainage, to the IPC.**
The one discipline that starts with its inputs already modelled: every fixture
placed by session 10 already carries what it connects to — hot, cold, its trap
size, whether it is soil — so the router begins with real loads rather than
assumptions.

It works backwards from the only fixed elevation in the whole system, the invert
of the public sewer. The stack goes where the water closets are, on a wall that
exists on every storey it has to pass through; the building drain runs back from
the sewer at the minimum fall its size allows, which fixes the height of the
foot of the stack; and every branch then hangs off that stack at its own
minimum fall. A branch it cannot give the fall to is *not drawn* — it says which
fixture, and how many millimetres short it was.

Sizing is by fixture unit, both currencies kept strictly apart: drainage fixture
units off IPC Table 709.1 for the drains, water supply fixture units off Table
E103.3(2) for the pipes, and the type system will not let one be passed where
the other is wanted. Nothing stores a diameter — a stored pipe size is right
when it is written and wrong the moment a bath is added upstream — so every size
on the screen, on the drawing and in the checks is derived from the same
function.

The supply is then checked properly rather than off the table: Hunter's curve
for the flow, Hazen–Williams for the friction, 9.8 kPa for every metre of rise,
and a walk from the street to every outlet to find the one with the least left.
Where the calculation and the table disagree, the calculation wins and the
finding says which is which — because "the table says 3/4 in but you will have
12 psi at the top shower" is the sentence that is actually useful.

Vents are sized off the drains they serve, the stack vent is the stack carried
on full size through the real roof surface, and any trap further from the stack
than Table 906.1 allows gets a vent of its own.

**A printable drawing set, drawn to scale.**
Not a screenshot: a real set, written by a PDF writer built from scratch for
this. A cover, a dimensioned plan of every storey, an elevation of each side, an
electrical plan per storey with its legend, the panel schedule and the load
calculation, a plumbing plan per storey, a drainage riser diagram, an elevation
of every run of cabinetry dimensioned unit by unit — the drawing a joiner
actually works from — and schedules of the doors, windows, rooms, cabinets,
sanitaryware, fittings, pipes and fixture units. Walls are
poché, doors show their swing on the side they open, dimensions run in two
strings, and each sheet carries a title block, a north point and a printed scale
bar — so you can measure the bar and know whether the print is true.

**Never lose work.** Continuous autosave, full undo/redo, JSON export/import, PNG
screenshots — and designs saved by session 1 are migrated forward automatically.

---

## Running it locally

You need [Node.js](https://nodejs.org) **22 or newer** — the LTS installer from
that page is all it takes. Check what you have with `node --version`.

22 rather than 20 because `pdfjs`, which the drawing-set tests use to open the
generated PDF with a real reader, calls `Promise.withResolvers` — an API that
does not exist before Node 22. On Node 20 the app builds and runs fine and the
test suite dies at that one line.

```bash
git clone https://github.com/2008danield-netizen/funny-funny-P.git
cd funny-funny-P

npm install     # once, after cloning (and after any dependency change)
npm run dev     # start the dev server
```

Then open the URL it prints — **http://localhost:5173/funny-funny-P/**.
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
│   ├── levels.ts       Storeys: elevations (derived), stairwells, naming
│   ├── buildingOps.ts  Adding and removing storeys and staircases
│   ├── planOps.ts      Structural edits: draw, split, delete, heal, normalise
│   ├── traceOps.ts     Turning a trace into a wall graph, as one undo step
│   ├── imageStore.ts   Plan images in IndexedDB, kept out of the document
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
├── code/             The building code, with its section numbers
│   └── irc.ts          IRC limits: every one cites where it comes from
│
├── plan/             Getting somebody's real floor plan into the app
│   ├── underlay.ts     Image pixels to metres: placement, calibration, alignment
│   ├── perspective.ts  Straightening a photographed sheet (projective transform)
│   ├── detect.ts       Ink, Hough lines, segments, and pairing faces into walls
│   ├── pdf.ts          A PDF page, rendered on demand
│   └── pixels.ts       The one place that reads an image's pixels
│
├── building/         The building itself, above the level of one plan
│   ├── stairs.ts       Stair geometry: flights, turns, winders, spirals
│   ├── stairCode.ts    Checking one against the IRC, citing every section
│   ├── skeleton.ts     The straight skeleton — where every ridge and valley goes
│   ├── footprint.ts    The outline a roof sits on, derived from the walls
│   ├── roof.ts         Hip, gable, shed and flat, in three dimensions
│   ├── dormer.ts       Dormers and skylights, and the holes they cut
│   ├── roofCode.ts     Slope, ventilation, access and the plot line, cited
│   ├── site.ts         Ground, plot, setbacks, earthworks, the compass
│   └── exterior.ts     What the outside is made of, and how much of it
│
├── advisor/          Does the room WORK, and is it any good?
│   ├── types.ts        Findings, fixes, and every guideline number in one place
│   ├── rules.ts        The fourteen rules — the design knowledge lives here
│   ├── advise.ts       Running them, and the score
│   ├── fixes.ts        Applying a suggestion, through the ordinary edit path
│   ├── generate.ts     Laying a room out from an empty floor
│   ├── rooms.ts        What a piece is FOR, and therefore what a room is for
│   ├── colour.ts       Contrast, temperature and hue families
│   └── geometry.ts     The measuring tape: room walls, blank spans, legality
│
├── clearance/        Does the room work?
│   ├── zones.ts        Floor each piece needs kept clear, and door swings
│   ├── circulation.ts  Occupancy grid, distance transform, widest-path search
│   └── analyze.ts      The report: issues in plain language with measurements
│
├── furniture/        The catalogue
│   ├── catalog.ts      Real products, real dimensions, clearances, prices
│   ├── builders.ts     Procedural geometry, built from each piece's dimensions
│   └── pricing.ts      Shopping list, price provenance, CSV export
│
├── interaction/      Direct 3D editing
│   ├── EditController.ts  Picking, dragging, drawing, placing openings
│   └── snapping.ts        Vertex / alignment / angle / grid snapping
│
├── scene/            What is actually in the world
│   ├── planGraph.ts    Wall graph maths + ROOM DETECTION (planar faces)
│   ├── Building.ts     Walls, floors, ceilings, skirtings, handles
│   ├── Furnishings.ts  Furniture meshes, shape cache, collision tinting
│   ├── ClearanceOverlay.ts  Zones drawn flat on the floor
│   ├── Staircases.ts   Stair meshes, extruded from the derived geometry
│   ├── Roofs.ts        Roof planes with their openings cut out, in world space
│   ├── PlanUnderlay.ts The scan being traced, and the walls proposed on it
│   ├── Electrical.ts   Devices at their real mounting heights, and home runs
│   ├── Plumbing.ts     Pipes as real tubes at their computed size and fall
│   ├── Fittings.ts     Carcasses, fronts, handles, worktops and fixtures
│   ├── Ground.ts       The terrain surface, the plot line, the north arrow
│   ├── GhostLevel.ts   The storey below, as an outline to align to
│   ├── wallBuilder.ts  Wall extrusion with holes; door and window furniture
│   ├── floorBuilder.ts Polygon floors, ceilings and skirting ribbons
│   ├── Lighting.ts     Lighting presets, IBL environment, shadow fitting
│   ├── openings/       Door and window catalogue
│   └── materials/      Procedural texture generation (noise → PBR maps)
│
├── fittings/         Kitchens and bathrooms
│   ├── modules.ts      Cabinet module widths, carcass sizes, worktops, finishes
│   └── fixtures.ts     Sanitaryware and appliances, with what they connect to
│
├── services/         The building's systems
│   ├── rooms.ts        What a room is FOR, from the name the user typed
│   ├── layout.ts       Where the outlets, switches and lights go
│   ├── circuits.ts     Grouping onto breakers, the panel schedule, Article 220
│   ├── drainage.ts     The stack, the branches, the falls, the drain to the sewer
│   ├── supply.ts       The service, the heater, and the hot and cold trees
│   ├── plumbingSize.ts Fixture units in, pipe diameters out — the only copy
│   ├── plumbingCheck.ts Falls, traps, vents, pressure and velocity, to the IPC
│   ├── necCheck.ts     The NEC checks, each citing its article
│   ├── kitchen.ts      Laying a kitchen out: runs, sink, hob, fridge
│   ├── bathroom.ts     Packing a bathroom: hardest fixture first, checked first
│   └── fittingCheck.ts R307, R303, and the working triangle as ergonomics
│
├── drawing/          The printable set
│   ├── pdf.ts          A PDF writer, from scratch — no dependency
│   ├── scale.ts        Architectural scales, and metres onto paper
│   ├── sheet.ts        Border, title block, scale bar, north point, dimensions
│   ├── floorPlan.ts    Poché walls, door swings, room labels, dimension chains
│   ├── elevation.ts    Each side, from the storey envelopes and the roof
│   ├── kitchenElevation.ts  One run flat on, dimensioned unit by unit
│   ├── electricalSheet.ts  Plan symbols, legend, panel schedule
│   ├── schedules.ts    Doors, windows, rooms, fittings
│   └── set.ts          The whole set, assembled and numbered
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

10. **Collision is physics; clearance is advice.** Keep them apart. Collision is
    never optional and never negotiable. Clearance is guidance the user may
    knowingly ignore, and only the rules marked `required` are ever enforced,
    and only in strict mode.

11. **The advisor never writes a position directly.** Every fix and every piece
    the generator places goes through `state/furnitureOps.ts`, the same path a
    mouse drag takes. A suggestion that buries a bed in a wall is far worse than
    no suggestion, because afterwards the user cannot tell which of the app's
    guarantees still hold.

12. **A rule offers no fix it has not checked.** Fixes are validated against the
    real collision and containment tests *before* the button is rendered. An
    Apply button that does nothing is experienced as the app being broken.

13. **Every finding carries a measurement.** "The room feels unbalanced" is
    horoscope writing. "84% of the furniture mass is on the north half" is a
    fact somebody can disagree with — and disagreeing with it is allowed.

14. **The advisor is renderer-free.** Nothing under `advisor/` may import
    Three.js. It runs under Node in the tests today and could run on a server
    tomorrow; that is worth one duplicated table of swatch colours, which a test
    keeps honest.

15. **A storey's height above the ground is derived, never stored.** It is the
    sum of the wall heights and slabs beneath it (`state/levels.ts`). Storing it
    as well would be the same fact written twice, and the two part company the
    first time somebody raises a ground-floor ceiling. Same principle as rooms.

16. **A stair's riser height is derived too, from the floor-to-floor rise.** Not
    the ceiling height — the rise includes the thickness of the floor above, and
    a stair built to the wrong one of the two arrives a step short. Deriving it
    makes every riser in a flight identical to the last floating-point bit,
    which is the most-cited stair defect in the country made impossible rather
    than merely checked.

17. **The stairwell opening is derived from headroom, not from the footprint.**
    The lower steps pass under the ceiling with room to spare and want solid
    floor over them. Cutting the whole footprint out throws away floor for
    nothing; cutting none of it out builds a staircase into a slab.

18. **Every code limit cites its section, and keeps its original wording.** A
    number without a reference cannot be checked, argued with, or updated when
    the code changes — and 7 3/4 in is what somebody can look up, where 0.197 m
    is not. If you cannot name the section, you do not yet know the rule.

19. **A price carries its provenance everywhere.** `PriceBasis` travels from the
    catalogue entry through the line item into the total and out to the CSV.
    Never display or export a figure without it — a guessed number that reads
    like a quoted one is how somebody budgets a room wrong.

20. **A room's purpose comes from its name, not from its furniture.** Almost
    every NEC requirement is conditional on the kind of room, and a house traced
    from a plan has no furniture in it at all — which is exactly the case the
    classifier exists for. The name is what the user typed and what appears on
    the drawing; if they call it a kitchen then it is a kitchen.

21. **The layout satisfies the code; the checks are written separately.** The
    two never share a function. When they disagree, one of them has the code
    wrong and a test says so — which is the point, and is how the six-foot rule
    stays honest rather than merely self-consistent.

22. **The drawing set is derived at the moment of export.** There is no stored
    drawing state at all: no saved layouts, no cached sheets, no remembered
    scales. A plan that could drift from the model it documents is worse than no
    plan, and the only way to guarantee it cannot is to have nothing to drift.

23. **A drawing states its scale, and the scale is true.** One module converts
    metres to points and the same object carries both the arithmetic and the
    name printed in the title block, so they cannot part company. Scales come
    from the standard architectural series — a drawing at 1:63.7 fits the sheet
    perfectly and is useless, because nobody owns that rule. Every sheet carries
    a printed scale bar, because a PDF printed "fit to page" is no longer at its
    stated scale and the bar is the only thing on it that stays true.

24. **The units of a run always sum to its length.** That is the invariant
    everything about a kitchen depends on, and it is the reason a corner unit's
    stored width is the PATH LENGTH it consumes — 1.76 m for an 880 corner,
    because the path turns inside it — rather than its carcass width. Without
    that, every worktop and every dimension on an L-shaped kitchen is short by
    one corner.

25. **A layout never knowingly produces a violation.** The checks and the
    layouts are written separately and never share a function, so a
    disagreement means one of them has the code wrong — but when the checker is
    right, the LAYOUT is fixed. An app that lays out a bathroom failing R307.1
    and then reports it teaches people to ignore the report.

26. **Code and ergonomics are never blurred.** A finding with a section is code:
    fail it and you fail an inspection. A finding with an empty section is
    guidance — the working triangle, the worktop landings — and the UI prints
    "Guidance" where it would otherwise print a citation. There is no section
    anywhere requiring a working triangle, and inventing one is the fastest way
    to make somebody stop believing the citations that are real.

### Tests

```bash
npm test
```

644 tests covering the parts where a bug is invisible on screen: the IPC's
sizing tables and the two fixture-unit currencies kept apart, the drainage
router's falls and the checker that judges them, Hunter's curve and
Hazen–Williams, filling a run
of cabinets and the corners it turns, the kitchen and bathroom layouts against
their own code checks, the PDF writer
and the drawing set it produces, the NEC spacing rule and every electrical check
with its article, circuit grouping and the Article 220 load calculation, placing
and scaling a traced plan, straightening a photographed one, the wall detector,
the straight
skeleton and every roof form it produces, dormers and skylights meeting the roof
they are cut into, the roof code checks and their citations, terrain, setbacks
and earthworks, the exterior takeoff, stair geometry and every IRC check, storey elevations and the v5 migration, room detection
(L-shapes, partitions, disconnected structures, winding, stable identity),
collision (penetration depth, sliding, wall-snap orientation, wedged pieces),
furniture placement end to end, clearance zones and circulation analysis,
structural plan edits, document validation, the schema migrations from v1 all the
way to v10, every advisor rule (does it fire when it should, and stay quiet when it should not), and the
generator. They are pure logic — no browser, no GPU — so they run in about two
seconds and gate every deploy.

The advisor's tests ask three things of every rule: does it stay quiet when it
should, does every fix it offers actually apply, and does applying one leave the
design legal. The generator is then run past the advisor itself — a layout the
app builds and its own critic marks down means one of the two has the rule
wrong.

The stair tests are the most important ones here, because they are the only ones
where the failure mode is a person falling rather than a room looking wrong.
They check three separate things: that the geometry is right (the steps add up
to the storey, turns come out square, nothing is mirrored), that the checks fire
when the code says they should and stay quiet when it does not, and that the
**citations are correct** — a finding naming the wrong section is worse than no
finding, because somebody will look it up, find it says something else, and stop
trusting all of them.

They have earned their place. Across five sessions they have caught a
separating-axis test that under-reported penetration whenever one box's
projection contained the other's (so a sofa dropped on a thin wall never escaped
it), a solver that never terminated on exact contact, a wall-snap that seated
furniture facing into the wall, a circulation metric that measured the narrowest
gap *anywhere* — which is always the few centimetres beside a skirting board —
a design score whose curve made five small notes outrank a room you could not
walk into, a colour check that called an off-white "warm" because HSL saturation
blows up near white, a generator that laid the rug before the armchair existed
and was then told off by its own rug rule, a circulation fixture that had
been passing for three sessions on a fallback value while quietly marooning five
square metres of floor, an outer-boundary tracer that reversed its wall list
without re-aligning it and so handed every eave its neighbour's thickness, and a
loop of walls drawn inside another that was treated as a second building — which
would have clad an internal room on its outside and given it a little roof of
its own indoors — and a wall detector that proposed two hundred walls for a
seven-wall plan, because a search tolerance comparable to the gap between a
wall's two faces fuses them into one solid band, and then every shallow diagonal
through that band reads as a continuous line.

Session 7 also swept every earlier session's headline feature end to end in a
real browser — draw a wall and undo it, furnish a room from the advisor, add a
storey and a staircase, add a roof and a skylight, draw a plot, then reload and
check it all came back. Fourteen checks, no console errors, and the document
returns at v6 with its storeys, stairs, furniture and plot intact. It found four
things the unit tests could not: a dormer that arrived already complaining on a
small house, imperial formatting that turned -0.3 m into "-1 ft 3/16 in", gable
rakes measured along the bottom of the gable instead of up the slope, and the
roof being solved several times per keystroke.

The drawing set's tests do the same thing the stair tests do, one level up: they
check that the file is a valid PDF *by opening it with a real PDF reader* —
`pdfjs` is already a dependency for reading plans, so it costs nothing to point
it at what the writer produced and ask it how many pages it sees, how big they
are, and what the text says. Every other test in that file checks that the bytes
look the way the specification says they should, which is precisely the kind of
check that passes while the file refuses to open. They also check the one thing a
drawing must never get wrong: that a metre of building comes out the exact number
of points on paper that the stated scale claims, and that the scale named in the
title block is one somebody owns a rule for.

Session 11's tests found the same shape of defect they found in session 10 — the
router and the checker disagreeing — twice, and on both occasions the *checker*
turned out to be the one that needed correcting, which was a first. The first
was a violation citing IPC 903.1.1 for a universal 3 in minimum on the vent
through the roof. That section does not say that; the 3 in figure is 904.2's
frost rule and it applies only in a cold climate. A violation citing a section
that does not contain the limit is the worst failure this app can produce, and
the fix went in three places at once: the citation, the sizing (a stack vent is
the stack *continued*, so it is the same size — not half of it, which is what a
naive reading of 916.2 gives), and the finding itself, which became a caution
naming the condition.

The second was worse in a quieter way. The app routed a house, sized the water
service off the fixture-unit table alone, got ½ in — which is arithmetically
correct for a small house and *illegal*, because IPC 603.1 puts a ¾ in floor
under the service — and then reported its own routing as a violation. A test now
pins both halves: that the general sizing function still returns ½ in for a
small load, and that the service-specific one never goes below ¾ in.

Session 9 swept the whole project again, and the sweep paid for itself. It found
a soffit that rendered almost black because it is the one surface in the building
facing straight down, a roof that stayed on over hidden walls so a house looked
sawn open with the lid glued down, a breaker table that stopped at 100 A and so
reported every house needing a 150 A service as compliant with 100 A, a room
classifier that read "Upstairs Hall" as a stairway because it matched "stair"
mid-word, device meshes that used the wrong key for pick metadata and so could
never be clicked at all, and — worst of the lot — three places where a colour was
set *between* starting a path and painting it. That is illegal PDF, and a strict
reader does not ignore it: it abandons the rest of the content stream, so every
symbol drawn after the mistake silently vanished too. The writer now hoists a
state operator out of an open path to where it is legal, which makes the whole
class of bug unwritable rather than merely fixed.

The cabinet tests check one property above all others, and check it by walking
lengths in millimetre steps rather than by picking a few convenient ones: the
units of a run must sum to its length EXACTLY, at every length. A kitchen whose
units do not add up either overhangs the wall or leaves a gap nobody drew, and
both are invisible until somebody measures the drawing.

Session 10's tests found three real defects the moment they were written, all of
the same shape — the layout and the checker disagreeing. The bathroom layout put
a WC 9 13/16 in from its centre line to the wall where IRC R307.1 asks for 15,
because the layout checked the clearance in FRONT of a fixture and not the one
BESIDE it. The kitchen layout sent the sink to the wall opposite the window,
because the span finder treated a window as an obstruction — which is right for
a wall unit, which has nothing to fix to, and exactly wrong for a base unit,
where a sink under a window is the entire point. And the anchor that puts the
sink under the window was measured along the WALL while the run's path may be
ordered the other way round, so on half the walls of any room it landed at the
far end. In each case the checker was right and the layout was fixed, which is
the only useful direction for that argument to go.

Session 11 also turned up a defect that had been sitting in the loader since
session 6, invisible because nothing wrote to the field it broke. `safeSite`
hardcoded `sewerConnection: null` instead of reading it back, so a sewer
connection was silently discarded on every reload. Nothing had ever set one, so
nothing noticed — right up until the drainage router started working back from
it, at which point every user's sewer would have jumped back to the default
position each time they opened their design. It now reads the value back, and
clamps the depth, because a sewer forty metres down would make every fall check
in the building pass.

The browser sweep for session 11 ran the whole thing end to end on a seeded
house: lay out the kitchen and the bathroom, route the water and drainage, and
check what came back. Five fixtures connected, 10 DFU, a 3 in building drain
(forced there by the WC rather than by the arithmetic), a ¾ in service, 33 psi
left at the worst fixture, the pipework visibly drawn in 3D and switchable, the
document returning at v10 with its stack, its eleven drainage runs, its eleven
supply runs and its cylinder intact, and a drawing set exported with its
plumbing plans, riser and schedules. No console errors.

The detector's fixtures are all plans the test file DRAWS, so the right answer
is known exactly and a failure says which part of the pipeline moved: four walls
of a room, a wall drawn as two faces that must come back as one wall with a
thickness, a doorway that must not cut a wall in half, a real gap that must, a
diagonal, a blank sheet, and a page of scanner speckle. A test against a real
scan would be untestable in the useful sense — nobody could say whether a change
made it better or worse.

The roof tests check properties rather than pictures, because a roof built from
a bad skeleton still renders — it just has a ridge in the wrong place, and it
looks like a roof until you compare it with the plan underneath. So they assert
that every eave gets exactly one face, that the faces tile the footprint
exactly, that every point's height equals its distance from its own eave (which
is what makes the whole roof one pitch), and that nothing escapes the outline.
The shapes that broke the solver during development are all kept as fixtures:
the cross that pinches shut across the middle, the T whose ridges and valleys
all arrive at one point, and the stepped plan whose two inside corners throw
their valleys across each other.

---

## Roadmap

- ~~**Session 1** — the room viewer.~~ ✅
- ~~**Session 2** — editable multi-room plans, doors and windows.~~ ✅
- ~~**Session 3** — furniture catalogue and hard collision.~~ ✅
- ~~**Session 4** — clearance, ergonomics and the shopping list.~~ ✅
- ~~**Session 5** — the design advisor and the room generator.~~ ✅
- ~~**Session 6** — storeys, staircases and the IRC.~~ ✅
- ~~**Session 7** — roofs, dormers, skylights, cladding and the site.~~ ✅
- ~~**Session 8** — tracing a real floor plan: import, straighten, scale, detect.~~ ✅
- ~~**Session 9** — electrical to the panel schedule, and the drawing set.~~ ✅
- ~~**Session 10** — kitchens and bathrooms: cabinetry, fixtures, R307 and the
  counter receptacles the electrical used to guess at.~~ ✅
- ~~**Session 11** — water and drainage: the stack, the falls, the vents, the
  pressure calculation and the riser diagram, to the IPC.~~ ✅
- **Session 12 — heating and ventilation.** Room-by-room load to ACCA Manual J,
  equipment selection to Manual S, ducts to Manual D. The Manual J load then
  feeds the heating and cooling figures the electrical service calculation
  currently has to ask the user for — and the duct routing has the same shape as
  the drainage routing session 11 just built, so a good deal of it is already
  written.
- **Session 13 — sections, and the drawing set finished.** A building section
  cut anywhere through the model, hidden-line removal on the elevations so a
  facade that steps in and out reads correctly, and window and door marks
  printed on the plans beside the openings they name.
- **Not done, and worth naming** — pipe and fittings are not on the shopping
  list. Everything priced in this app carries a `PriceBasis` saying where the
  figure came from, and there is no honest source for pipe here yet; inventing
  one to fill a column would be worse than the gap.
- **Elsewhere in the queue** — a VR walkthrough, and accounts with cloud sync
  (designs currently live only in this browser's `localStorage`, so one cleared
  cache loses everything).
- **Later** — an LLM advisor layered *on top of* the rules engine rather than
  replacing it: the rules give it measured facts to reason from and a way to be
  checked. Real looked-up prices. More retailers. A native app wrapping this
  same codebase.

### About the code checking

The app is built to **US codes**: the IRC for the shell, and — as those sessions
land — the NEC for electrical, the IPC for plumbing and ACCA's manuals for
heating. Choosing your jurisdiction comes later; for now the figures are the
2021 IRC, the 2023 NEC and the 2021 IPC, and the app says so.

Some of what the app reports is deliberately NOT code, and is labelled as such
where it appears: the kitchen working triangle, the worktop landings beside a
sink and a hob, and the walkway between opposing runs are ergonomics. No section
anywhere requires them and a kitchen that fails every one of them is perfectly
legal — they are here because they are measurable and because they are the
difference between a kitchen that works and one that does not.

The plumbing adds three more to that list, and the distinction is worth being
strict about because plumbing is where a wrong citation does the most damage.
Water velocity, water heater sizing and the practical maximum fall on a drain
are all real engineering and none of them is in the code book — they print as
"Guidance". Two more are *conditional* rather than universal: a vent's 3 in
minimum applies only where the winter design temperature is at or below 0°F
(IPC 904.2), and the 10 ft clearance from a vent to a window (904.5) can be
satisfied by height as well as by distance. The app knows neither the climate
nor, reliably, the height, so both are cautions that name the condition — not
violations it cannot stand behind.

Nothing the app produces is a permit set, and nothing has been checked or
stamped by a licensed professional. **No structural design is done at all** — no
beam, header, footing or connection is sized, and nothing in the app says the
building stands up. The electrical work must be done by a licensed electrician
and inspected, and so must the plumbing. Every sheet of the drawing set says all
of this on it, because sheets get separated and one of them ends up on a notice
board on its own.

Cleanouts are a specific gap worth naming: the app does not model them, so it
cannot tell you whether they are there. What it does instead is say where IPC
708.1 requires them — at the foot of the stack, where the drain leaves the
building, at every sharp change of direction — which turns into a list to hand
over rather than a false clean bill of health.

**Checking is not approval.** Nothing here is certified by anybody. A real build
needs a permit, an inspection, and for anything structural, electrical or gas, a
licensed professional. What the app does is catch the ordinary mistakes while
they are still free to fix, and show its arithmetic — with the section number —
to the person who will sign the work off. That is the difference between work an
engineer has to redo and work an engineer can check in ten minutes.

Structural design is deliberately out of scope. Load paths, beams and what can
come out of a wall are an engineer's job, and being confidently wrong about them
would be worse than saying nothing.

### Why the advisor is not an LLM (yet)

It was the obvious way to build it, and it was the wrong first step. The app is
static files on GitHub Pages with no backend, so an API key cannot be kept
secret — the honest options were "paste your own key into the browser" or "stand
up a serverless proxy", and both are infrastructure decisions rather than design
ones.

More importantly, a model that says *"the sofa is too far from the coffee table"*
and a rule that says *"the reach is 82 cm, the guideline is 30–45 cm"* are not
competitors. The second is what makes the first checkable. Building the rules
first means the model, when it arrives, has measured facts to reason from and a
list of things it does not need to guess at — and the app keeps working, offline
and for free, for anyone who never turns it on.

---

## About the prices

The catalogue ships **rough price estimates** so the shopping list totals
something out of the box. They are guesses: written from general knowledge, not
checked against any listing, and IKEA prices differ by country and change several
times a year.

The code treats them accordingly. Every price carries a *basis* — `estimate`,
`confirmed`, or `unknown` — and that basis survives aggregation, so a total made
of estimates is labelled an estimate total. Typing a real price over one promotes
it to `confirmed`. The CSV export carries the basis column and a warning line.

Session 5 replaces the estimates with real figures; the same `price` field is
what it will write to.

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
