/**
 * Drawing the roofs.
 *
 * Like the staircases, this module makes no decisions about shape: it draws
 * what `building/roof.ts` and `building/dormer.ts` derive, so the geometry the
 * code checks are run against is the geometry on screen.
 *
 * Two things are worth knowing about how it is built.
 *
 * FIRST, a roof plane is a polygon lying over the ground with a height that is
 * a straight-line function of position — so it is triangulated flat, in plan,
 * and then each vertex is lifted onto the plane. That gives dormer and skylight
 * openings for free: they are holes in a two-dimensional shape, which is exact,
 * where cutting one solid out of another at a grazing angle is a coin toss.
 *
 * SECOND, roofs are drawn in WORLD space rather than inside the active storey's
 * group. A roof sits on top of the storey it covers, and the user is usually
 * editing a different one; hanging it off the active level would move the roof
 * up and down as they switched floors.
 */

import * as THREE from 'three';

import { roofGeometry, type RoofGeometry, type RoofPlane, type Vec3 } from '@/building/roof';
import { holesInPlane, roofOpenings } from '@/building/dormer';
import { getCladdingPreset } from './materials/cladding';
import type { DesignDocument, Point2, Roof } from '@/state/types';

/** How thick the roof reads at the eave, in metres. Sheathing plus covering. */
const EDGE_THICKNESS = 0.06;

interface RoofMaterials {
  covering: THREE.MeshStandardMaterial;
  /** Fascia, barge boards and the soffit under the eave. */
  trim: THREE.MeshStandardMaterial;
  /** The walls of a dormer, which are clad like the rest of the house. */
  cladding: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
}

export class Roofs {
  readonly group = new THREE.Group();

  private materials: RoofMaterials;
  private meshes: THREE.Mesh[] = [];
  /** One covering material per roof, since each may be a different colour. */
  private perRoof: THREE.Material[] = [];
  private builtSignature = '';

  constructor() {
    this.group.name = 'Roofs';

    this.materials = {
      covering: new THREE.MeshStandardMaterial({
        color: 0x4c5157,
        roughness: 0.9,
        metalness: 0,
        // Both sides: from inside the building you are looking at the back of
        // the roof, and a one-sided roof simply is not there from underneath.
        side: THREE.DoubleSide,
      }),
      trim: new THREE.MeshStandardMaterial({
        color: 0xf7f5f0,
        roughness: 0.7,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
      cladding: new THREE.MeshStandardMaterial({
        color: 0xe4ded2,
        roughness: 0.85,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
      glass: new THREE.MeshPhysicalMaterial({
        color: 0xd6e6f0,
        roughness: 0.05,
        metalness: 0,
        transmission: 0.85,
        thickness: 0.01,
        ior: 1.52,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
      }),
    };
  }

  /**
   * Rebuilds every roof on the building.
   *
   * Signature-gated like the rest of the scene. The signature covers the roofs
   * themselves and the walls of every storey they could sit on, because a roof
   * follows its footprint and a dragged wall reshapes it.
   */
  update(doc: DesignDocument): void {
    const signature = [
      JSON.stringify(doc.roofs),
      doc.levels.map((level) => `${level.id}:${level.plan.walls.length}:${level.wallHeight}`).join(','),
      // Cheap proxy for "any wall moved": the vertex positions of every storey.
      doc.levels
        .map((level) => level.plan.vertices.map((v) => `${v.x.toFixed(3)},${v.z.toFixed(3)}`).join(';'))
        .join('|'),
      doc.exterior.cladding,
      doc.exterior.claddingColour,
    ].join('#');

    if (signature === this.builtSignature) return;
    this.builtSignature = signature;

    this.clear();

    const preset = getCladdingPreset(doc.exterior.cladding);
    this.materials.cladding.color.set(doc.exterior.claddingColour || preset.suggestedColour);
    this.materials.trim.color.set(doc.exterior.trimColour);

    for (const roof of doc.roofs) {
      const geometry = roofGeometry(doc, roof);
      if (!geometry || geometry.planes.length === 0) continue;
      this.buildRoof(roof, geometry);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  private buildRoof(roof: Roof, geometry: RoofGeometry): void {
    // Its own material: two roofs on one building can be different colours, and
    // tinting the shared one would hand the last roof's colour to all of them.
    const covering = this.materials.covering.clone();
    covering.color.set(roof.colour);
    this.perRoof.push(covering);

    const openings = roofOpenings(geometry, roof);

    for (const plane of geometry.planes) {
      const holes = holesInPlane(plane, openings);
      const mesh = this.planeMesh(plane, holes, covering);
      if (mesh) this.add(mesh);
    }

    for (const gable of geometry.gables) {
      const mesh = this.verticalMesh(gable.points, this.materials.cladding);
      if (mesh) this.add(mesh);
    }

    /*
     * The soffit: the underside of the overhang, from the fascia back to the
     * wall. Without it you look up into an unlit void from anywhere below the
     * eaves, which reads as a roof floating over nothing.
     */
    if (geometry.wallLine.length === geometry.eaves.length) {
      const soffitHeight = geometry.eaveHeight - EDGE_THICKNESS;
      for (let i = 0; i < geometry.eaves.length; i++) {
        const j = (i + 1) % geometry.eaves.length;
        const panel = this.polygonMesh(
          [
            { x: geometry.eaves[i]!.x, y: soffitHeight, z: geometry.eaves[i]!.z },
            { x: geometry.eaves[j]!.x, y: soffitHeight, z: geometry.eaves[j]!.z },
            { x: geometry.wallLine[j]!.x, y: soffitHeight, z: geometry.wallLine[j]!.z },
            { x: geometry.wallLine[i]!.x, y: soffitHeight, z: geometry.wallLine[i]!.z },
          ],
          this.materials.trim,
        );
        if (panel) this.add(panel);
      }
    }

    // The eave itself: a thin band hanging below the edge of the roof, which is
    // what makes an overhang read as an overhang rather than as a paper edge.
    for (const edge of geometry.edges) {
      if (edge.kind !== 'eave' && edge.kind !== 'rake') continue;
      const band = this.verticalMesh(
        [
          edge.from,
          edge.to,
          { x: edge.to.x, y: edge.to.y - EDGE_THICKNESS, z: edge.to.z },
          { x: edge.from.x, y: edge.from.y - EDGE_THICKNESS, z: edge.from.z },
        ],
        this.materials.trim,
      );
      if (band) this.add(band);
    }

    for (const dormer of openings.dormers) {
      if (dormer.planes.length === 0) continue;

      const front = this.verticalMesh(dormer.front.points, this.materials.cladding);
      if (front) this.add(front);

      for (const cheek of dormer.cheeks) {
        const mesh = this.verticalMesh(cheek.points, this.materials.cladding);
        if (mesh) this.add(mesh);
      }
      for (const face of dormer.planes) {
        const mesh = this.polygonMesh(face.points, covering);
        if (mesh) this.add(mesh);
      }
      if (dormer.window) {
        const mesh = this.verticalMesh(dormer.window.points, this.materials.glass);
        // Already stood proud of the face it is set in by the geometry, so no
        // nudge is needed here.
        if (mesh) this.add(mesh);
      }
    }

    for (const skylight of openings.skylights) {
      if (skylight.pane.points.length < 3) continue;
      const pane = this.polygonMesh(skylight.pane.points, this.materials.glass);
      if (pane) this.add(pane);

      for (const side of skylight.curb) {
        const mesh = this.polygonMesh(side.points, this.materials.trim);
        if (mesh) this.add(mesh);
      }
    }
  }

  /* ------------------------------- Meshes -------------------------------- */

  /**
   * A sloping roof plane, with its dormers and skylights cut out.
   *
   * Triangulated in PLAN and then lifted: every point of a plane satisfies the
   * same linear equation, so the lift is exact and the holes come out where
   * they were cut rather than where a projection put them.
   */
  private planeMesh(
    plane: RoofPlane,
    holes: readonly Point2[][],
    material: THREE.Material,
  ): THREE.Mesh | null {
    if (plane.points.length < 3) return null;

    const shape = new THREE.Shape(
      plane.points.map((point) => new THREE.Vector2(point.x, point.z)),
    );
    for (const hole of holes) {
      shape.holes.push(new THREE.Path(hole.map((point) => new THREE.Vector2(point.x, point.z))));
    }

    const geometry = new THREE.ShapeGeometry(shape);
    const anchor = plane.points[0]!;

    // n . (p - anchor) = 0, solved for the height at each triangulated point.
    const position = geometry.attributes.position!;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getY(i);
      const y =
        Math.abs(plane.normal.y) < 1e-9
          ? anchor.y
          : anchor.y -
            (plane.normal.x * (x - anchor.x) + plane.normal.z * (z - anchor.z)) / plane.normal.y;
      position.setXYZ(i, x, y, z);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();

    return new THREE.Mesh(geometry, material);
  }

  /** A flat polygon in three dimensions, triangulated as a fan from its first point. */
  private polygonMesh(points: readonly Vec3[], material: THREE.Material): THREE.Mesh | null {
    if (points.length < 3) return null;

    const positions: number[] = [];
    for (let i = 1; i < points.length - 1; i++) {
      positions.push(
        points[0]!.x, points[0]!.y, points[0]!.z,
        points[i]!.x, points[i]!.y, points[i]!.z,
        points[i + 1]!.x, points[i + 1]!.y, points[i + 1]!.z,
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }

  /**
   * A vertical panel: a gable end, a dormer cheek, a fascia band.
   *
   * The same fan triangulation. It is safe here because every panel produced by
   * the roof builder is convex or very nearly so — a gable is a triangle or a
   * trapezium, a cheek is a triangle, a fascia band is a quad.
   */
  private verticalMesh(points: readonly Vec3[], material: THREE.Material): THREE.Mesh | null {
    return this.polygonMesh(points, material);
  }

  private add(mesh: THREE.Mesh): void {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  private clear(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.meshes = [];

    for (const material of this.perRoof) material.dispose();
    this.perRoof = [];
  }

  dispose(): void {
    this.clear();
    for (const material of Object.values(this.materials)) material.dispose();
    this.group.clear();
  }
}
