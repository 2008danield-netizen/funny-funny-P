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
 */

import * as THREE from 'three';

import { runGeometry, type PlacedUnit } from '@/building/cabinetRun';
import { CARCASS, WORKTOP, doorFinish, worktopMaterial } from '@/fittings/modules';
import { getFixture, type FixtureEntry } from '@/fittings/fixtures';
import { elevationOf } from '@/state/levels';
import type { CabinetRun, DesignDocument, Fixture } from '@/state/types';

/** Carcasses are white in every real kitchen; only the fronts vary. */
const CARCASS_COLOUR = 0xf4f2ee;
const PLINTH_COLOUR = 0x3f4247;

/** How proud of the carcass a door sits, and how thick it is. */
const DOOR_THICKNESS = 0.018;
const DOOR_GAP = 0.003;

export class Fittings {
  readonly group = new THREE.Group();

  private meshes: THREE.Mesh[] = [];
  /** The subset the pointer may hit — one per unit and one per fixture. */
  private targets: THREE.Mesh[] = [];
  private builtSignature = '';
  private selectedId: string | null = null;

  private geometries = new Map<string, THREE.BoxGeometry>();
  private materials = new Map<number, THREE.MeshStandardMaterial>();

  constructor() {
    this.group.name = 'Fittings';
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

    for (const front of fronts) {
      const panel = new THREE.Mesh(
        this.boxFor(front.width - DOOR_GAP * 2, front.height - DOOR_GAP * 2, DOOR_THICKNESS),
        this.materialFor(frontColour, 0.5),
      );
      this.placeOnFace(panel, placed, front.offsetX, lift + front.centreY, depth / 2 + DOOR_THICKNESS / 2);
      panel.raycast = () => {};
      this.add(panel, false);

      // A rail handle across the top of a drawer, or down the side of a door.
      const handle = new THREE.Mesh(
        front.kind === 'drawer'
          ? this.boxFor(Math.min(0.3, front.width * 0.5), 0.014, 0.03)
          : this.boxFor(0.014, Math.min(0.25, front.height * 0.4), 0.03),
        this.materialFor(handleColour, 0.35, 0.6),
      );
      this.placeOnFace(
        handle,
        placed,
        front.offsetX + (front.kind === 'drawer' ? 0 : front.width / 2 - 0.05),
        lift + front.centreY + (front.kind === 'drawer' ? front.height / 2 - 0.05 : 0),
        depth / 2 + DOOR_THICKNESS + 0.015,
      );
      handle.raycast = () => {};
      this.add(handle, false);
    }
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

  private boxFor(width: number, height: number, depth: number): THREE.BoxGeometry {
    const key = `${width.toFixed(3)}x${height.toFixed(3)}x${depth.toFixed(3)}`;
    const existing = this.geometries.get(key);
    if (existing) return existing;

    const geometry = new THREE.BoxGeometry(
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
    this.meshes = [];
    this.targets = [];
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

/* ------------------------------ Front layout ------------------------------ */

interface Front {
  kind: 'door' | 'drawer';
  width: number;
  height: number;
  /** Across the unit from its centre. */
  offsetX: number;
  /** Up from the bottom of the carcass. */
  centreY: number;
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
      return [
        { kind: 'door', width: width / 2, height, offsetX: -width / 4, centreY: height / 2 },
        { kind: 'door', width: width / 2, height, offsetX: width / 4, centreY: height / 2 },
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
      return [{ kind: 'door', width: width * 0.4, height, offsetX: 0, centreY: height / 2 }];

    case 'sink':
    case 'door':
    default:
      return [{ kind: 'door', width, height, offsetX: 0, centreY: height / 2 }];
  }
}

/** Drawer fronts stacked bottom-up, in the given proportions of the height. */
function stack(width: number, height: number, shares: readonly number[]): Front[] {
  const fronts: Front[] = [];
  let cursor = 0;
  // Bottom first, so the deepest is at the bottom where the pans go.
  for (const share of [...shares].reverse()) {
    const panel = height * share;
    fronts.push({ kind: 'drawer', width, height: panel, offsetX: 0, centreY: cursor + panel / 2 });
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
