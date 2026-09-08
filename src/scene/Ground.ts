/**
 * The ground, the plot, and which way is north.
 *
 * The ground was a flat dark plane until now, which was the right answer while
 * the app was about the inside of one room. It is the wrong answer for a
 * building: a house sits on a piece of land that slopes, and the slope is half
 * of what makes a design site-specific.
 *
 * So the surface is sampled from `building/site.ts` on a grid and drawn as a
 * mesh. The grid is deliberately coarse — the terrain is an interpolation to
 * begin with, and a finer mesh would render a smoother version of the same
 * guess while costing real frames on a large plot.
 *
 * The plot boundary and the buildable area inside the setbacks are drawn as
 * lines lying on the ground rather than as filled shapes: they are survey
 * information, and a filled polygon competes with the building for attention.
 */

import * as THREE from 'three';

import { buildableArea, groundHeightAt } from '@/building/site';
import type { DesignDocument, GroundCover, Point2, Site } from '@/state/types';

/** How far out the ground extends past whatever is drawn, in metres. */
const MARGIN = 24;
/** Grid spacing of the terrain mesh, in metres. */
const SPACING = 1.5;
/** Never build more than this many cells a side, however big the plot. */
const MAX_CELLS = 96;

/** What each ground finish looks like. Chosen to read at a distance, not close up. */
const GROUND_COLOURS: Record<GroundCover, { colour: number; roughness: number }> = {
  grass: { colour: 0x4a5c3a, roughness: 0.95 },
  gravel: { colour: 0x7b7770, roughness: 0.92 },
  paving: { colour: 0x8a8782, roughness: 0.8 },
  earth: { colour: 0x5d4b3a, roughness: 0.96 },
  sand: { colour: 0xbaa87e, roughness: 0.9 },
  concrete: { colour: 0x9a9893, roughness: 0.85 },
};

export class Ground {
  readonly group = new THREE.Group();

  private surface: THREE.Mesh;
  private material: THREE.MeshStandardMaterial;
  private boundary: THREE.Line | null = null;
  private envelope: THREE.Line | null = null;
  private north: THREE.Group;

  private builtSignature = '';

  constructor() {
    this.group.name = 'Ground';

    this.material = new THREE.MeshStandardMaterial({
      color: GROUND_COLOURS.grass.colour,
      roughness: GROUND_COLOURS.grass.roughness,
      metalness: 0,
      /*
       * Pushed back a hair in the depth buffer so the ground always loses to
       * the building standing on it.
       *
       * A house whose ground floor is level with the ground outside is a
       * perfectly reasonable thing to draw — a slab on grade, a garage, a
       * terrace — and it puts two surfaces in exactly the same plane. Without
       * this the two flicker against each other in a torn, moving comb all the
       * way round the building, which looks like a broken renderer rather than
       * like a design decision.
       */
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    this.surface = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.surface.receiveShadow = true;
    this.surface.name = 'Terrain';
    this.group.add(this.surface);

    this.north = this.buildNorthArrow();
    this.group.add(this.north);
  }

  update(doc: DesignDocument): void {
    const site = doc.site;
    const extent = extentOf(doc);

    const signature = [
      JSON.stringify(site.terrain),
      JSON.stringify(site.boundary),
      JSON.stringify(site.setbacks),
      site.ground,
      site.northAngle.toFixed(4),
      extent.toFixed(1),
    ].join('#');
    if (signature === this.builtSignature) return;
    this.builtSignature = signature;

    const cover = GROUND_COLOURS[site.ground] ?? GROUND_COLOURS.grass;
    this.material.color.setHex(cover.colour);
    this.material.roughness = cover.roughness;

    this.rebuildSurface(site, extent);
    this.rebuildPlot(site);
    this.placeNorthArrow(site, extent);
  }

  /* ------------------------------ The surface ----------------------------- */

  private rebuildSurface(site: Site, extent: number): void {
    const half = extent + MARGIN;
    const cells = Math.min(MAX_CELLS, Math.max(8, Math.ceil((half * 2) / SPACING)));
    const step = (half * 2) / cells;

    const positions: number[] = [];
    const indices: number[] = [];

    for (let row = 0; row <= cells; row++) {
      const z = -half + row * step;
      for (let column = 0; column <= cells; column++) {
        const x = -half + column * step;
        positions.push(x, groundHeightAt(site, { x, z }), z);
      }
    }

    const stride = cells + 1;
    for (let row = 0; row < cells; row++) {
      for (let column = 0; column < cells; column++) {
        const a = row * stride + column;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        // Wound anticlockwise seen from above, so the surface faces the sky.
        indices.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    this.surface.geometry.dispose();
    this.surface.geometry = geometry;
  }

  /* -------------------------------- The plot ------------------------------ */

  private rebuildPlot(site: Site): void {
    this.boundary = this.replaceLine(this.boundary, site.boundary, site, 0xd8c98a, 0.06);

    const envelope = site.setbacks ? buildableArea(site) : [];
    // Only worth drawing when it differs from the boundary itself.
    const showEnvelope = site.setbacks !== null && envelope.length >= 3;
    this.envelope = this.replaceLine(
      this.envelope,
      showEnvelope ? envelope : [],
      site,
      0x6f9fd8,
      0.05,
    );
  }

  /** Swaps one closed outline for another, following the ground under it. */
  private replaceLine(
    existing: THREE.Line | null,
    outline: readonly Point2[],
    site: Site,
    colour: number,
    lift: number,
  ): THREE.Line | null {
    if (existing) {
      existing.geometry.dispose();
      (existing.material as THREE.Material).dispose();
      this.group.remove(existing);
    }
    if (outline.length < 3) return null;

    const points = [...outline, outline[0]!].map(
      (point) =>
        new THREE.Vector3(point.x, groundHeightAt(site, point) + lift, point.z),
    );

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: colour }),
    );
    line.name = 'PlotLine';
    this.group.add(line);
    return line;
  }

  /* ------------------------------ The compass ----------------------------- */

  /**
   * A north arrow, standing at the edge of the ground.
   *
   * Small, and off to one side. Every plan drawing has one, and once the site
   * has a north point at all, a design without one on screen invites the reader
   * to assume the top of the screen is north — which it usually is not.
   */
  private buildNorthArrow(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'NorthArrow';

    const material = new THREE.MeshStandardMaterial({
      color: 0xe8e2d0,
      roughness: 0.6,
      metalness: 0,
    });

    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 2.2), material);
    shaft.position.z = -0.4;
    group.add(shaft);

    const head = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 4), material);
    head.rotation.x = Math.PI / 2;
    head.position.z = 1.1;
    group.add(head);

    return group;
  }

  private placeNorthArrow(site: Site, extent: number): void {
    // The arrow points at north, which is `northAngle` round from world +Z.
    this.north.rotation.y = -site.northAngle;
    const distance = extent + MARGIN * 0.55;
    this.north.position.set(distance * 0.72, groundHeightAt(site, { x: distance * 0.72, z: -distance * 0.72 }) + 0.1, -distance * 0.72);
  }

  dispose(): void {
    this.surface.geometry.dispose();
    this.material.dispose();
    for (const line of [this.boundary, this.envelope]) {
      if (!line) continue;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.group.clear();
  }
}

/** How far out from the origin anything in the design reaches. */
function extentOf(doc: DesignDocument): number {
  let extent = 12;
  for (const level of doc.levels) {
    for (const vertex of level.plan.vertices) {
      extent = Math.max(extent, Math.abs(vertex.x), Math.abs(vertex.z));
    }
  }
  for (const point of doc.site.boundary) {
    extent = Math.max(extent, Math.abs(point.x), Math.abs(point.z));
  }
  return extent;
}
