# havavamama — roadmap

Written at the end of session 17, part one. This is an honest assessment of how
far the project is from being a product somebody pays for, and what stands
between here and there.

---

## Where it actually stands

**87,120 lines across 223 TypeScript files. 1,014 tests. Seventeen sessions.**

| Area | Lines | State |
|---|---|---|
| `services/` | 13,204 | Analysis, checks, estimating |
| `state/` | 11,112 | Schema v13, migrations, validation |
| `scene/` | 9,958 | Three.js scene graph, materials |
| `building/` | 9,845 | Plan geometry, stairs, roofs, sections |
| `ui/` | 8,563 | React panels |
| `drawing/` | 7,169 | PDF writer and the drawing set |
| `advisor/` | 5,843 | Design guidance |
| everything else | 21,426 | Render core, codes, audio, walk, physics, XR |

What a person can do with it today: draw a plan, stack storeys, put stairs and a
roof on it, trace it from a photo or a PDF, furnish it, fit a kitchen and a
bathroom, wire it to the NEC, plumb it to the IPC, size the heating to Manual J,
cut sections through it, walk through it, open the doors, hear the room, read a
compliance report that cites real sections, and export a PDF drawing set.

That is a genuinely deep tool. The depth is not the problem.

---

## The honest verdict

**The engineering is perhaps 80% of the way to the core product. The business
is at zero. And the gap that matters most is neither.**

Eighty-seven thousand lines have been written and **no user has ever touched
it.** Not one. Every design decision in this repo is a guess that has never met
a person who did not already know how it worked. That is the single largest risk
in the project, and no amount of further building reduces it — it grows.

The second-largest risk is close behind: **a design lives in one browser's
localStorage, in one slot, under one key.** Clear your site data and seventeen
sessions of work evaporates. There is no account, no second project, no way to
send a design to anyone. Everything built so far assumes one person, one
machine, one design, forever.

---

## Phase A — Make it look right *(in progress, 1–2 sessions)*

The complaint that started session 17. Half done.

- [x] Wood floor streaks — joints measured in metres, relief the texture can hold
- [x] Six other generators with the same defect — tile, carpet, brick, stone, shingle, siding
- [x] `relief.test.ts` so it cannot come back
- [x] **Light calibration** — every preset now declares a sun-to-ambient ratio and
      `lighting.test.ts` holds it. Measured against a shadows-off render of the
      same frame, shadows now remove **33% of the light instead of 16%** under
      daylight and **25% instead of 13%** at evening — about twice the depth
- [x] **Shadow frustum fitted to where the shadow lands.** Also fixed a latent
      bug found on the way: the far plane used distance from the world origin
      rather than from the light to its target, so a plan moved a hundred metres
      out would have lost every shadow
- [ ] Ambient occlusion in the ordinary render path
- [ ] Progressive accumulation — *gated on whether it works on real hardware*
- [ ] A real sky and a ground that is not a flat green plane
- [ ] Furniture shaped properly — cushions with seams, rounded arms, tapered legs

Blocked on one answer: **does the progressive toggle work on your GPU?** It
gates ambient occlusion and soft shadows, which are most of what is left.

## Session 18 — the 3D view becomes where you work

Scoped with the user. Not more geometry — **rectangular walls stay**. This is
about the 3D view stopping being a preview and becoming the workspace.

- [ ] **Direct manipulation in perspective.** Drag a wall, a window, a cabinet or
      a chair in the 3D view, with gizmos, snapping and live collision. The
      picker and the ray already exist from session 15; what is missing is drag
      planes, handles and the undo grouping.
- [ ] **Real camera control.** Saved viewpoints, smooth transitions, a lens
      control, and two-point perspective so vertical edges stay vertical the way
      they do in an architectural render.
- [ ] **Edit from inside the walkthrough.** Today you can open a door and flip a
      switch but you cannot change anything. Pick up a chair and move it, repaint
      the wall you are facing, swap the cabinet door in front of you.

The plan view stays — it is the right tool for setting out dimensions — but it
stops being the only place work can happen.

## Four ideas worth building, all approved

Recorded so they are not lost. These change what the product *is*, rather than
closing a gap.

1. **Consequences, not compliance.** The model already knows the envelope, the
   climate zone, the orientation, the Manual J load and the reverberation time of
   every room. That same data answers *"your heating will cost about $140 in
   January"*, *"the back bedroom is the coldest room in the house"*, *"this
   living room overheats in July — it is the south glazing with no shade"*. An
   architect charges thousands for an energy model; this is the useful half of
   one, from a plan drawn in an afternoon.
2. **Make time real.** Replace the four mood presets with a latitude, a date and
   a time. Then the app can say *"this kitchen gets direct sun from 07:20 to
   10:40 in June, and none at all between November and February"* — which is the
   most persuasive sentence a home design tool can produce, and it is what makes
   all the shadow work above mean something.
3. **Cost of ownership, not cost.** `PriceBasis` already travels end to end.
   Extend the total from what it costs to build to what it costs to own:
   *"this wall costs $3,100 more and saves $14,200 over twenty years."* The
   U-values, the degree days and the load are already in the model.
4. **Compare two schemes.** Side by side, every derived number diffed. The
   cheapest of the four, and it makes every other number more useful — a number
   alone means little, a difference means everything.

## Phase B — Make it trustworthy *(1 session)*

Three things are written and unproven. The pile grows every session.

- [ ] **Hear the sound.** Session 16 was verified on a level meter, never by ear.
      It could be unpleasant and nobody would know.
- [ ] **Run the WebXR path on hardware.** The one thing in this project that has
      never been executed. Needs a headset.
- [ ] **Run CI on pull requests.** `deploy.yml` already runs the full build on
      pushes to main; it does not run on PRs, so a PR shows no green tick.
      Ten-minute job.
- [ ] **Measure frames on a real GPU.** Every performance number so far comes
      from a software rasteriser.
- [ ] **Test a browser that is not Chromium.**

## Phase C — Make it survivable for a stranger *(1–2 sessions)*

This is where the first real user would bounce off.

- [ ] **Drawing a wall across a room does not split the room.** The partition
      dangles and no second region forms. A new user will read this as broken.
      Recorded in the README since session 14; still there.
- [ ] **Onboarding.** There is no tutorial, no sample project, no template. The
      UI opens with every panel a seventeen-session app has accumulated.
- [ ] **Starter plans** — a one-bed flat, a three-bed house — so the first
      experience is editing something rather than facing an empty grid.
- [ ] **Mobile and tablet triage.** Untested. Probably unusable. Decide whether
      it is supported or explicitly not.
- [ ] **Crash handling.** No error boundary, no reporting. A thrown exception
      is a blank screen.

## Phase D — Make it a product *(2–4 sessions, needs a decision first)*

The part that does not exist at all.

- [ ] **Accounts.** None.
- [ ] **Cloud persistence.** One localStorage slot today.
- [ ] **Multiple projects.** You can have exactly one design.
- [ ] **Sharing** — a link somebody else can open. Nothing.
- [ ] **Version history.** The schema migrates; the document has no history.

`persistence.ts` was written behind a narrow interface precisely so a backend
could slot in without touching anything else, which was the right call. But the
choice of backend is a real decision with cost and lock-in, and it is yours
rather than mine.

## Phase E — Make it sellable *(mostly not code)*

- [ ] Pricing and payments
- [ ] Terms, privacy policy
- [ ] **The IKEA naming question**, reviewed by somebody qualified. Dimensions
      and prices are written from general knowledge, never scraped; every entry
      carries `verifiedAt: null` and a non-affiliation notice. That is defensible
      but it has not been checked by a lawyer.
- [ ] **The "code checking is not approval" disclaimers**, likewise. They are in
      the UI and the README. Whether they are sufficient is a legal question.
- [ ] Support, docs, a landing page

---

## What I would do next

1. **Finish Phase A.** It is the complaint you actually raised, it is half done,
   and a tool that looks wrong will not survive a first impression regardless of
   what it can calculate.
2. **Fold the CI-on-PRs job into whatever comes next.** Ten minutes, stops the
   trust debt growing.
3. **Then Phase C, not Phase D.** Cloud saving is more exciting, but a stranger
   who cannot draw two rooms never reaches the point of wanting to save. The
   room-splitting bug and a starter plan are worth more than an account system.
4. **Put it in front of one person before Phase D.** Anyone. Watch them use it
   without helping. Whatever they get stuck on first is more valuable than this
   entire document.

---

## Sequencing risk

Phases A, B and C are all things I can do and verify. Phase D needs a decision
from you about infrastructure, and Phase E needs a professional who is not a
language model. Those two should start earlier than feels comfortable, because
they have lead times that building does not.
