/**
 * Drawing the cabinetry and the fixtures.
 *
 * -----------------------------------------------------------------------------
 * EVERYTHING IS BUILT FROM ITS DIMENSIONS.
 *
 * A "600 three-drawer base" is not a model somebody made. It is a carcass box,
 * three front panels worked out by dividing the height, and three handle rails
 * — all from one width and one height. That is what makes it possible to add a
 * module width, or later a real product with real dimensions, without modelling
 * anything: the geometry follows from the numbers, the way the roof follows
 * from the footprint.
 *
 * -----------------------------------------------------------------------------
 * GEOMETRY IS SHARED BY SHAPE, NOT BY UNIT.
 *
 * A fitted kitchen is thirty carcasses, sixty doors and sixty handles. Giving
 * each its own BoxGeometry would put several hundred buffers on the GPU for
 * what is, in truth, about eight distinct shapes. So boxes are cached by their
 * rounded dimensions and instanced by transform — which is the same trick
 * `Furnishings` uses, for the same reason.
 *
 * -----------------------------------------------------------------------------
 * THE FRONTS MOVE, AND THEY MOVE THE WAY THE REAL ONES DO.
 *
 * A door hinges about the edge away from its handle and swings out; a drawer
 * slides straight out along the run's own normal. Both matter for the same
 * reason the walkthrough matters at all: a 900 mm gangway between two runs of
 * base units is a perfectly comfortable gangway until somebody opens a drawer
 * in it. That is a real kitchen-design fault, it is invisible on a plan, and
 * a drawer that actually comes out is what finds it.
 *
 * What is NOT modelled is the drawer BOX behind the front — sliding the front
 * out leaves the carcass visible behind it. A real box is four more panels per
 * drawer on a thing that already has sixty fronts, for a difference that does
 * not change any answer: what the drawer costs you is the space in front of
 * it, and that is exactly what the front already sweeps.
 */

import * as THREE from 'three';

import { chamferedBox } from './millwork';

import { runGeometry, type PlacedUnit } from '@/building/cabinetRun';
import { CARCASS, WORKTOP, doorFinish, worktopMaterial } from '@/fittings/modules';
import { getFixture, type FixtureEntry } from '@/fittings/fixtures';
import { hasTap, tapHeightAbove } from '@/walk/interactables';
import { elevationOf } from '@/state/levels';
import type { CabinetRun, DesignDocument, Fixture } from '@/state/types';

/** Carcasses are white in every real kitchen; only the fronts vary. */
const CARCASS_COLOUR = 0xf4f2ee;
const PLINTH_COLOUR = 0x3f4247;

/** How proud of the carcass a door sits, and how thick it is. */
const DOOR_THICKNESS = 0.018;
const DOOR_GAP = 0.003;

/**
 * How far a cabinet door swings, fully open.
 *
 * Ninety-five degrees rather than ninety: a real hinge goes a little past
 * square so the door clears the carcass edge and you can get a drawer out
 * behind it. It is also what makes an open door read as open rather than as a
 * modelling error.
 */
const DOOR_SWING = (95 * Math.PI) / 180;

/** How far a drawer runs out, as a fraction of the carcass depth. */
const DRAWER_TRAVEL = 0.75;

/** The water, when a tap is running. */
const WATER_COLOUR = 0xbcd9e8;

/**
 * And the tap it comes out of.
 *
 * Pale and only lightly metallic. Real chrome is nearly a mirror, and a mirror
 * in a scene with no environment map to reflect renders as a black rod — which
 * is what a fully metallic tap looked like the first time this was drawn.
 */
const TAP_COLOUR = 0xd6dadd;

export class Fittings {
  readonly group = new THREE.Group();

  private meshes: THREE.Mesh[] = [];
  /** The subset the pointer may hit — one per unit and one per fixture. */
  private targets: THREE.Mesh[] = [];
  private builtSignature = '';
  private selectedId: string | null = null;

  private geometries = new Map<string, THREE.BufferGeometry>();
  private materials = new Map<number, THREE.MeshStandardMaterial>();

  /** The fronts that move, by the id of the unit they belong to. */
  private movables = new Map<string, MovingFront[]>();
  /** The stream of water over each tap-bearing fixture, by fixture id. */
  private streams = new Map<string, THREE.Object3D[]>();
  /** Everything parented to a pivot, so `clear` can take it apart. */
  private pivots: THREE.Object3D[] = [];

  /**
   * How far open each unit is, remembered across rebuilds.
   *
   * The same reason `Building` remembers its door leaves: editing anything on
   * the storey rebuilds all of this, and a drawer that shut itself because
   * somebody moved a wall would be a bug that is very hard to describe.
   */
  private openness = new Map<string, number>();
  private running = new Set<string>();

  constructor() {
    this.group.name = 'Fittings';
  }

  /* ----------------------------- Moving parts ----------------------------- */

  /** Which units have something that opens, for anything that wants to know. */
  movableUnits(): string[] {
    return [...this.movables.keys()];
  }

  /** And which fixtures have a tap that can be turned on. */
  tapFixtures(): string[] {
    return [...this.streams.keys()];
  }

  /** Opens or shuts a unit's fronts. 0 is shut, 1 fully open. */
  setUnitOpenness(unitId: string, fraction: number): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    if (this.openness.get(unitId) === clamped) return;
    this.openness.set(unitId, clamped);
    this.applyUnit(unitId, clamped);
  }

  /** Turns a tap's water on or off. */
  setTapRunning(fixtureId: string, on: boolean): void {
    if (this.running.has(fixtureId) === on) return;
    if (on) this.running.add(fixtureId);
    else this.running.delete(fixtureId);

    for (const part of this.streams.get(fixtureId) ?? []) part.visible = on;
  }

  private applyUnit(unitId: string, fraction: number): void {
    for (const part of this.movables.get(unitId) ?? []) {
      if (part.kind === 'drawer') {
        // Straight out along the run's normal, which is the direction a runner
        // physically allows and also the direction the gangway is measured in.
        part.pivot.position.set(
          part.facing.x * part.travel * fraction,
          0,
          part.facing.z * part.travel * fraction,
        );
      } else {
        part.pivot.rotation.y = part.shutAngle + part.swing * fraction;
      }
    }
  }

  /** Re-applies everything remembered, after a rebuild threw the meshes away. */
  private restoreState(): void {
    for (const [unitId, fraction] of this.openness) {
      if (fraction > 0) this.applyUnit(unitId, fraction);
    }
    for (const [fixtureId, parts] of this.streams) {
      const on = this.running.has(fixtureId);
      for (const part of parts) part.visible = on;
    }
  }

  /** What the pointer may pick. */
  pickTargets(): THREE.Mesh[] {
    return this.targets;
  }

  setSelection(selectedId: string | null): void {
    if (selectedId === this.selectedId) return;
    this.selectedId = selectedId;
    this.applySelection();
  }

  /**
   * Rebuilds the fittings on one storey.
   *
   * Signature-gated like every other rebuild in the scene. The signature has to
   * include the units, not just the run's path: swapping a door base for a
   * drawer base changes no position at all and changes every front.
   */
  update(doc: DesignDocument, levelId: string): void {
    const runs = doc.runs.filter((run) => run.levelId === levelId);
    const fixtures = doc.fixtures.filter((fixture) => fixture.levelId === levelId);

    const signature =
      runs
        .map(
          (run) =>
            `${run.id}:${run.kind}:${run.finishId}:${run.worktop?.material ?? '-'}:` +
            `${run.path.map((point) => `${point.x.toFixed(3)},${point.z.toFixed(3)}`).join(';')}:` +
            run.units.map((unit) => `${unit.moduleId}@${unit.offset.toFixed(3)}x${unit.width.toFixed(3)}`).join(','),
        )
        .join('|') +
      '#' +
      fixtures
        .map(
          (fixture) =>
            `${fixture.id}:${fixture.fixtureId}:${fixture.at.x.toFixed(3)},${fixture.at.z.toFixed(3)},` +
            `${fixture.rotation.toFixed(3)},${fixture.y.toFixed(3)}`,
        )
        .join('|');

    if (signature === this.builtSignature) return;
    this.builtSignature = signature;
    this.clear();

    for (const run of runs) this.buildRun(run);
    for (const fixture of fixtures) this.buildFixture(fixture);

    this.restoreState();
    this.applySelection();
    void elevationOf;
  }

  /* --------------------------------- Runs --------------------------------- */

  private buildRun(run: CabinetRun): void {
    const geometry = runGeometry(run);
    const finish = doorFinish(run.finishId);

    for (const placed of geometry.units) {
      this.buildUnit(run, placed, finish);
    }

    /* ---- The worktop, and the splashback behind it ---- */
    if (run.worktop) {
      const colour = new THREE.Color(worktopMaterial(run.worktop.material).colour).getHex();
      for (const quad of geometry.worktop) {
        const slab = this.quadPrism(quad, WORKTOP.thickness);
        if (!slab) continue;
        const mesh = new THREE.Mesh(slab, this.materialFor(colour, 0.35));
        mesh.position.y = CARCASS.base.lift + CARCASS.base.height;
        mesh.name = `Worktop_${run.id}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.raycast = () => {};
        this.add(mesh, false);
      }
    }
  }

  /**
   * One unit: a carcass, its fronts, its handles, and its plinth.
   *
   * A filler is a single panel the width of the gap — no carcass behind it,
   * because there is nothing behind a filler in reality either.
   */
  private buildUnit(run: CabinetRun, placed: PlacedUnit, finish: ReturnType<typeof doorFinish>): void {
    const { module, width, depth, height, lift } = placed;
    const isFiller = module.front === 'filler';

    /* ---- The carcass ---- */
    const bodyDepth = isFiller ? DOOR_THICKNESS : depth;
    const body = new THREE.Mesh(
      this.boxFor(width, height, bodyDepth),
      this.materialFor(isFiller ? new THREE.Color(finish.front).getHex() : CARCASS_COLOUR, 0.75),
    );
    body.position.set(placed.at.x, lift + height / 2, placed.at.z);
    // A filler sits at the FRONT of where a carcass would be, not the middle.
    if (isFiller) {
      body.position.x += Math.sin(placed.rotation) * (depth / 2 - bodyDepth / 2);
      body.position.z += Math.cos(placed.rotation) * (depth / 2 - bodyDepth / 2);
    }
    body.rotation.y = placed.rotation;
    body.name = `Unit_${placed.unit.id}`;
    body.castShadow = true;
    body.receiveShadow = true;
    body.userData.pickKind = 'unit';
    body.userData.pickId = placed.unit.id;
    this.add(body, true);

    if (isFiller) return;

    /* ---- The plinth, set back so the doors overhang it ---- */
    if (run.kind !== 'wall' && lift > 0.01) {
      const plinth = new THREE.Mesh(
        this.boxFor(width, lift, depth - 0.05),
        this.materialFor(PLINTH_COLOUR, 0.85),
      );
      plinth.position.set(placed.at.x, lift / 2, placed.at.z);
      plinth.rotation.y = placed.rotation;
      plinth.raycast = () => {};
      this.add(plinth, false);
    }

    /* ---- The fronts ---- */
    const fronts = frontsOf(module.front, width, height);
    const frontColour = new THREE.Color(finish.front).getHex();
    const handleColour = new THREE.Color(finish.handle).getHex();

    const moving: MovingFront[] = [];
    const facing = { x: Math.sin(placed.rotation), z: Math.cos(placed.rotation) };

    for (const front of fronts) {
      const panel = new THREE.Mesh(
        this.boxFor(front.width - DOOR_GAP * 2, front.height - DOOR_GAP * 2, DOOR_THICKNESS),
        this.materialFor(frontColour, 0.5),
      );

      /*
       * The handle goes on the edge AWAY from the hinge, which is both where a
       * real one is and what makes a pair of doors read as a pair: their
       * handles meet in the middle rather than both sitting on the right.
       */
      const handleAcross =
        front.kind === 'drawer'
          ? front.offsetX
          : front.offsetX - front.hinge * (front.width / 2 - 0.05);

      // A rail handle across the top of a drawer, or down the side of a door.
      const handle = new THREE.Mesh(
        front.kind === 'drawer'
          ? this.boxFor(Math.min(0.3, front.width * 0.5), 0.014, 0.03)
          : this.boxFor(0.014, Math.min(0.25, front.height * 0.4), 0.03),
        this.materialFor(handleColour, 0.35, 0.6),
      );

      const panelY = lift + front.centreY;
      const handleY = panelY + (front.kind === 'drawer' ? front.height / 2 - 0.05 : 0);

      panel.raycast = () => {};
      handle.raycast = () => {};

      if (front.kind === 'drawer') {
        /*
         * A drawer needs no pivot of its own: everything it does is a
         * translation, so the front and its handle are placed in world space
         * and a group around them is simply slid outwards.
         */
        this.placeOnFace(panel, placed, front.offsetX, panelY, depth / 2 + DOOR_THICKNESS / 2);
        this.placeOnFace(handle, placed, handleAcross, handleY, depth / 2 + DOOR_THICKNESS + 0.015);

        const slide = new THREE.Group();
        slide.add(panel, handle);
        // Tagged so the motion can be inspected without reaching back into
        // the run: the geometry is what the tests check, not the bookkeeping.
        slide.userData.unitId = placed.unit.id;
        slide.userData.shutAngle = 0;
        this.addPivot(slide);

        moving.push({
          kind: 'drawer',
          pivot: slide,
          facing,
          // Nearly the whole carcass, which is what a full-extension runner
          // gives and what the gangway has to allow for.
          travel: depth * DRAWER_TRAVEL,
          shutAngle: 0,
          swing: 0,
        });
        continue;
      }

      /*
       * A door DOES need a pivot, at its hinge edge. The group is put there in
       * world space with the unit's own rotation, so its children can be laid
       * out in the same across/out frame `placeOnFace` uses — with the origin
       * moved to the hinge.
       */
      const hingeAcross = front.offsetX + front.hinge * (front.width / 2);
      const side = { x: Math.cos(placed.rotation), z: -Math.sin(placed.rotation) };
      const out = depth / 2;

      const pivot = new THREE.Group();
      pivot.position.set(
        placed.at.x + facing.x * out + side.x * hingeAcross,
        0,
        placed.at.z + facing.z * out + side.z * hingeAcross,
      );
      pivot.rotation.y = placed.rotation;

      panel.position.set(front.offsetX - hingeAcross, panelY, DOOR_THICKNESS / 2);
      handle.position.set(handleAcross - hingeAcross, handleY, DOOR_THICKNESS + 0.015);

      pivot.add(panel, handle);
      pivot.userData.unitId = placed.unit.id;
      pivot.userData.shutAngle = placed.rotation;
      this.addPivot(pivot);

      moving.push({
        kind: 'door',
        pivot,
        facing,
        travel: 0,
        shutAngle: placed.rotation,
        /*
         * The sign follows the hinge side. Yawing the pivot by +θ swings the
         * free edge towards −across, so a door hinged on the +across edge
         * needs a positive angle to come outwards and one hinged on the other
         * edge needs a negative one.
         */
        swing: front.hinge * DOOR_SWING,
      });
    }

    if (moving.length > 0) this.movables.set(placed.unit.id, moving);
  }

  /** Adds a group of moving parts, tracked so `clear` can take it apart. */
  private addPivot(pivot: THREE.Object3D): void {
    this.group.add(pivot);
    this.pivots.push(pivot);
  }

  /** Puts a part on the front face of a unit, offset across and up. */
  private placeOnFace(
    mesh: THREE.Mesh,
    placed: PlacedUnit,
    across: number,
    up: number,
    out: number,
  ): void {
    const facing = { x: Math.sin(placed.rotation), z: Math.cos(placed.rotation) };
    const side = { x: Math.cos(placed.rotation), z: -Math.sin(placed.rotation) };

    mesh.position.set(
      placed.at.x + facing.x * out + side.x * across,
      up,
      placed.at.z + facing.z * out + side.z * across,
    );
    mesh.rotation.y = placed.rotation;
  }

  /* ------------------------------- Fixtures ------------------------------- */

  /**
   * A fixture, built from its bounding box and a little shaping.
   *
   * Not a modelled bath — a box with a hollow, which at the scale a plan is
   * viewed at reads exactly as a bath and costs three meshes. The one thing
   * that IS modelled properly is the footprint, because that is what the
   * clearance checks measure and what the plan draws.
   */
  private buildFixture(fixture: Fixture): void {
    const entry = getFixture(fixture.fixtureId);
    if (!entry) return;

    const colour = colourOf(entry);
    const body = new THREE.Mesh(
      this.boxFor(entry.width, entry.height, entry.depth),
      this.materialFor(colour, entry.family === 'sanitary' ? 0.2 : 0.45, entry.family === 'appliance' ? 0.5 : 0),
    );
    body.position.set(fixture.at.x, fixture.y + entry.height / 2, fixture.at.z);
    body.rotation.y = fixture.rotation;
    body.name = `Fixture_${fixture.id}`;
    body.castShadow = true;
    body.receiveShadow = true;
    body.userData.pickKind = 'fixture';
    body.userData.pickId = fixture.id;
    this.add(body, true);

    /* ---- The hollow, for the things that have one ---- */
    if (entry.kind === 'bath' || entry.kind === 'sink' || entry.kind === 'basin' || entry.kind === 'shower') {
      const inset = entry.kind === 'shower' ? 0.02 : 0.08;
      const wellDepth = entry.kind === 'shower' ? 0.04 : entry.height * 0.6;
      const well = new THREE.Mesh(
        this.boxFor(entry.width - inset * 2, wellDepth, entry.depth - inset * 2),
        this.materialFor(0xdfe6ea, 0.15),
      );
      well.position.set(
        fixture.at.x,
        fixture.y + entry.height - wellDepth / 2 + 0.001,
        fixture.at.z,
      );
      well.rotation.y = fixture.rotation;
      well.raycast = () => {};
      this.add(well, false);
    }

    /* ---- The water, for the things with a tap on them ---- */

    if (hasTap(entry)) this.buildWater(fixture, entry);

    /* ---- A cistern behind a WC, which is what makes it read as one ---- */
    if (entry.kind === 'wc') {
      const cistern = new THREE.Mesh(
        this.boxFor(entry.width, 0.36, 0.2),
        this.materialFor(colour, 0.2),
      );
      const back = { x: -Math.sin(fixture.rotation), z: -Math.cos(fixture.rotation) };
      cistern.position.set(
        fixture.at.x + back.x * (entry.depth / 2 - 0.1),
        fixture.y + entry.height + 0.18,
        fixture.at.z + back.z * (entry.depth / 2 - 0.1),
      );
      cistern.rotation.y = fixture.rotation;
      cistern.raycast = () => {};
      this.add(cistern, false);
    }
  }

  /**
   * A stream of water, built hidden and shown when the tap is turned on.
   *
   * Built up front rather than on demand for the same reason the light pool
   * is allocated up front: adding geometry to a live scene is a stall, and a
   * tap should answer the moment it is used. Two meshes, invisible until they
   * are wanted, cost nothing while they are not.
   *
   * It is deliberately not animated. A moving stream needs either a scrolling
   * texture or a shader, both of which are real work on every frame for every
   * running tap; what the tap is actually being asked is whether the water
   * lands in the bowl rather than on the rim, and a still stream answers that
   * exactly as well.
   */
  private buildWater(fixture: Fixture, entry: FixtureEntry): void {
    const parts: THREE.Object3D[] = [];
    const material = this.materialFor(WATER_COLOUR, 0.05);
    const spout = fixture.y + tapHeightAbove(entry);

    /*
     * The tap itself, which was missing.
     *
     * A sink with no tap on it is wrong whether or not anything is running,
     * and a stream of water starting in mid-air is worse. A post and a short
     * arm is all a tap is at this scale; the arm reaches over the bowl, which
     * is where the water comes out.
     */
    if (entry.kind !== 'shower') {
      const back = { x: -Math.sin(fixture.rotation), z: -Math.cos(fixture.rotation) };
      const stand = spout - fixture.y - entry.height * 0.5;

      const post = new THREE.Mesh(this.boxFor(0.03, stand, 0.03), this.materialFor(TAP_COLOUR, 0.3, 0.25));
      post.position.set(
        fixture.at.x + back.x * (entry.depth / 2 - 0.05),
        fixture.y + entry.height * 0.5 + stand / 2,
        fixture.at.z + back.z * (entry.depth / 2 - 0.05),
      );
      post.rotation.y = fixture.rotation;
      post.raycast = () => {};
      this.add(post, false);

      const arm = new THREE.Mesh(this.boxFor(0.026, 0.026, entry.depth / 2 - 0.05), this.materialFor(TAP_COLOUR, 0.3, 0.25));
      arm.position.set(
        fixture.at.x + back.x * (entry.depth / 4 - 0.025),
        spout,
        fixture.at.z + back.z * (entry.depth / 4 - 0.025),
      );
      arm.rotation.y = fixture.rotation;
      arm.raycast = () => {};
      this.add(arm, false);
    }

    // From the spout down to the bottom of the well — the same spout the hand
    // reaches for, which is why the height comes from one place.
    const top = spout;
    const bottom = fixture.y + entry.height * (entry.kind === 'shower' ? 0.1 : 0.45);
    const fall = Math.max(0.05, top - bottom);

    const stream = new THREE.Mesh(
      this.boxFor(entry.kind === 'shower' ? 0.16 : 0.018, fall, entry.kind === 'shower' ? 0.16 : 0.018),
      material,
    );
    stream.position.set(fixture.at.x, bottom + fall / 2, fixture.at.z);
    stream.rotation.y = fixture.rotation;
    stream.raycast = () => {};
    stream.castShadow = false;
    stream.visible = false;
    stream.userData.tapFixtureId = fixture.id;
    parts.push(stream);
    this.add(stream, false);

    // And a disc where it lands, which is what makes it read as water hitting
    // something rather than as a rod hanging in the air.
    const pool = new THREE.Mesh(
      this.boxFor(entry.width * 0.5, 0.004, entry.depth * 0.5),
      material,
    );
    pool.position.set(fixture.at.x, bottom + 0.002, fixture.at.z);
    pool.rotation.y = fixture.rotation;
    pool.raycast = () => {};
    pool.castShadow = false;
    pool.visible = false;
    pool.userData.tapFixtureId = fixture.id;
    parts.push(pool);
    this.add(pool, false);

    this.streams.set(fixture.id, parts);
  }

  /* -------------------------------- Plumbing ------------------------------- */

  private applySelection(): void {
    for (const mesh of this.targets) {
      const selected = mesh.userData.pickId === this.selectedId;
      const material = mesh.material as THREE.MeshStandardMaterial;
      // Emissive rather than a colour swap: a cabinet front is already a
      // colour the user chose, and replacing it hides what they picked.
      material.emissive?.setHex(selected ? 0x2a3a4a : 0x000000);
    }
  }

  /* -------------------------------- Internals ------------------------------ */

  private add(mesh: THREE.Mesh, pickable: boolean): void {
    this.group.add(mesh);
    this.meshes.push(mesh);
    if (pickable) this.targets.push(mesh);
  }

  /**
   * A cached box with its edges eased.
   *
   * Cabinet fronts are the geometry a person gets closest to in this app — you
   * stand at a worktop with your face half a metre from a door — so a
   * mathematically sharp arris is more obvious here than anywhere else in the
   * building. The cache makes the extra triangles nearly free: a kitchen has
   * sixty fronts and about six distinct sizes.
   */
  private boxFor(width: number, height: number, depth: number): THREE.BufferGeometry {
    const key = `${width.toFixed(3)}x${height.toFixed(3)}x${depth.toFixed(3)}`;
    const existing = this.geometries.get(key);
    if (existing) return existing;

    const geometry = chamferedBox(
      Math.max(0.001, width),
      Math.max(0.001, height),
      Math.max(0.001, depth),
    );
    this.geometries.set(key, geometry);
    return geometry;
  }

  /**
   * A prism from a plan quad — used for the worktop, which follows the run
   * rather than being axis-aligned.
   */
  private quadPrism(quad: readonly { x: number; z: number }[], thickness: number): THREE.BufferGeometry | null {
    if (quad.length < 3) return null;

    const shape = new THREE.Shape();
    quad.forEach((point, index) => {
      if (index === 0) shape.moveTo(point.x, -point.z);
      else shape.lineTo(point.x, -point.z);
    });
    shape.closePath();

    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    // The extruder builds from y = 0 upwards in its own frame; laid flat it
    // runs downwards, so it is lifted by its own thickness to sit on the
    // carcass rather than inside it.
    geometry.translate(0, thickness, 0);
    return geometry;
  }

  private materialFor(colour: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial {
    const key = colour * 1000 + Math.round(roughness * 100) * 10 + Math.round(metalness * 9);
    const existing = this.materials.get(key);
    if (existing) return existing;

    const material = new THREE.MeshStandardMaterial({ color: colour, roughness, metalness });
    this.materials.set(key, material);
    return material;
  }

  private clear(): void {
    for (const mesh of this.meshes) {
      // Only the extruded worktops own their geometry; the boxes are cached.
      if (mesh.geometry instanceof THREE.ExtrudeGeometry) mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    for (const pivot of this.pivots) {
      // The panels and handles inside share cached geometry and materials, so
      // taking the group off the scene is the whole of the disposal.
      pivot.clear();
      this.group.remove(pivot);
    }
    this.meshes = [];
    this.targets = [];
    this.pivots = [];
    this.movables.clear();
    this.streams.clear();
  }

  dispose(): void {
    this.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.group.clear();
  }
}

/* ------------------------------ Moving parts ------------------------------ */

/** One front that opens, and everything needed to open it. */
interface MovingFront {
  kind: 'door' | 'drawer';
  /** A drawer's slides; a door's hinges about its own Y. */
  pivot: THREE.Object3D;
  /** Which way is out of the carcass, for a drawer. */
  facing: { x: number; z: number };
  /** How far a drawer runs out, metres. */
  travel: number;
  /** A door's yaw when it is shut. */
  shutAngle: number;
  /** And how far it turns from there, signed by which edge it hinges on. */
  swing: number;
}

/* ------------------------------ Front layout ------------------------------ */

interface Front {
  kind: 'door' | 'drawer';
  width: number;
  height: number;
  /** Across the unit from its centre. */
  offsetX: number;
  /** Up from the bottom of the carcass. */
  centreY: number;
  /**
   * Which edge the hinges are on: −1 the left edge, +1 the right.
   *
   * Meaningless for a drawer, which slides. For a pair of doors the two
   * hinge on opposite edges so the handles meet in the middle, which is both
   * how they are actually hung and how a pair reads at a glance.
   */
  hinge: -1 | 1;
}

/**
 * How a carcass front is divided.
 *
 * The one non-obvious rule is that drawer fronts are NOT equal: the bottom
 * drawer of a three-drawer base is deeper than the two above it, because that
 * is where the pans go. Dividing the height equally is the giveaway that a
 * kitchen was drawn by software.
 */
function frontsOf(front: string, width: number, height: number): Front[] {
  switch (front) {
    case 'double-door':
      // Hinged on the outer edges, so they part in the middle.
      return [
        { kind: 'door', width: width / 2, height, offsetX: -width / 4, centreY: height / 2, hinge: -1 },
        { kind: 'door', width: width / 2, height, offsetX: width / 4, centreY: height / 2, hinge: 1 },
      ];

    case 'drawers-2':
      return stack(width, height, [0.38, 0.62]);
    case 'drawers-3':
      return stack(width, height, [0.22, 0.3, 0.48]);
    case 'drawers-4':
      return stack(width, height, [0.16, 0.2, 0.26, 0.38]);

    case 'open':
      // Open shelving: no fronts at all, which is the point of it.
      return [];

    case 'appliance':
      // An appliance gap has no door — the appliance's own front fills it.
      return [];

    case 'corner':
      // One door on the diagonal, drawn as a plain front across the leg. The
      // real thing is angled; at this scale the difference is a line.
      return [{ kind: 'door', width: width * 0.4, height, offsetX: 0, centreY: height / 2, hinge: -1 }];

    case 'sink':
    case 'door':
    default:
      return [{ kind: 'door', width, height, offsetX: 0, centreY: height / 2, hinge: -1 }];
  }
}

/** Drawer fronts stacked bottom-up, in the given proportions of the height. */
function stack(width: number, height: number, shares: readonly number[]): Front[] {
  const fronts: Front[] = [];
  let cursor = 0;
  // Bottom first, so the deepest is at the bottom where the pans go.
  for (const share of [...shares].reverse()) {
    const panel = height * share;
    fronts.push({
      kind: 'drawer',
      width,
      height: panel,
      offsetX: 0,
      centreY: cursor + panel / 2,
      hinge: -1,
    });
    cursor += panel;
  }
  return fronts;
}

/** What colour a fixture is drawn. */
function colourOf(entry: FixtureEntry): number {
  if (entry.family === 'sanitary') return 0xfbfbfa;
  switch (entry.kind) {
    case 'hob':
      return 0x2a2c2f;
    case 'oven':
    case 'microwave':
      return 0x3a3d42;
    case 'sink':
      return 0xc3c7cb;
    case 'extractor':
      return 0xb9bcc0;
    default:
      return 0xd8dade;
  }
}
