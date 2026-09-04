# havavamama

A web-based 3D interior design studio. Draw a floor plan, put doors and windows
in it, paint the rooms, furnish it with real products that genuinely fit, and
walk through it — in the browser, with no install.

**Live app:** https://2008danield-netizen.github.io/VR-home-design-project/

> **Status: session 7 — it has an outside.** Roofs that follow the real
> footprint — hip, gable, shed and flat, with ridges, hips and valleys worked
> out from the walls rather than drawn by hand — plus dormers, skylights,
> exterior cladding, and a site with ground that slopes, a plot line and
> setbacks. Everything is checked against the International Residential Code
> with the section number printed beside every finding. Next come the services:
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
│   ├── levels.ts       Storeys: elevations (derived), stairwells, naming
│   ├── buildingOps.ts  Adding and removing storeys and staircases
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
├── code/             The building code, with its section numbers
│   └── irc.ts          IRC limits: every one cites where it comes from
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
│   ├── Ground.ts       The terrain surface, the plot line, the north arrow
│   ├── GhostLevel.ts   The storey below, as an outline to align to
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

### Tests

```bash
npm test
```

396 tests covering the parts where a bug is invisible on screen: the straight
skeleton and every roof form it produces, dormers and skylights meeting the roof
they are cut into, the roof code checks and their citations, terrain, setbacks
and earthworks, the exterior takeoff, stair geometry and every IRC check, storey elevations and the v5 migration, room detection
(L-shapes, partitions, disconnected structures, winding, stable identity),
collision (penetration depth, sliding, wall-snap orientation, wedged pieces),
furniture placement end to end, clearance zones and circulation analysis,
structural plan edits, document validation, the schema migrations, every advisor
rule (does it fire when it should, and stay quiet when it should not), and the
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
its own indoors.

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
- **Session 8 — trace real floor plans, per storey.** Nobody draws a whole house
  from memory. This is where somebody's actual home gets into the app.
- **Session 9 — the services foundation, and electrical.** The routed-network
  primitive built once, then receptacles, switches, fittings, circuits, the
  panel, cable safe-zones and per-circuit load, to the NEC.
- **Session 10 — water and drainage.** Supply runs and pipe sizing; then the
  soil stack, waste branches, falls, traps, vents and the connection to the
  sewer, to the IPC.
- **Session 11 — heating and ventilation.** Room-by-room load to ACCA Manual J,
  equipment selection to Manual S, ducts to Manual D.
- **Session 12 — the drawing set.** A plan and a schedule per discipline, plus
  elevations, dimension lines and annotations.
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
2021 IRC and the app says so.

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
