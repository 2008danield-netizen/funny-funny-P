/**
 * Drawing the plumbing.
 *
 * -----------------------------------------------------------------------------
 * THESE ARE REAL PIPES, NOT SCHEMATIC LINES.
 *
 * The electrical draws home runs as lines and says plainly that they are not
 * cable routes, because nobody can know where a cable goes before the house is
 * framed. Plumbing is the opposite case and it is worth being clear why.
 *
 * A drain has to FALL, and the fall is the whole design. A line from a bath to
 * a stack tells you nothing; a pipe at 1 in 48 running 4 m tells you it has
 * dropped 83 mm, which is either fine or the reason the floor has to be built
 * up. So every run here is drawn as a tube at its computed diameter, at its
 * computed height, and if it looks wrong in the model it is wrong.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE COLOURS MEAN.
 *
 * The trade's own convention, near enough: blue cold, red hot, grey-green
 * waste, brown-grey soil, a lighter grey for vents. It is worth following
 * rather than inventing something prettier, because somebody who has seen a
 * plumbing drawing before can read this one without a key.
 *
 * -----------------------------------------------------------------------------
 * GEOMETRY IS SHARED AND CACHED.
 *
 * A whole-house layout is a few hundred pipe segments, and a fresh
 * CylinderGeometry for each would cost more than the walls do. Segments are
 * cached by rounded length and radius, which collapses almost all of them onto
 * a handful of shapes — the same trick the fittings use for carcasses.
 */

import * as THREE from 'three';

import { elevationOf } from '@/state/levels';
import { sizeAllDrainage, sizeAllSupply } from '@/services/plumbingSize';
import type { DesignDocument, PipePoint, PipeSystem } from '@/state/types';

/** How each system is drawn. Trade convention, so a plumber can read it. */
const SYSTEM_COLOURS: Record<PipeSystem, number> = {
  cold: 0x2e86ab,
  hot: 0xc0392b,
  'hot-return': 0xe07a5f,
  waste: 0x6b7f75,
  soil: 0x5a5248,
  vent: 0xa9b2b8,
};

/** The stack is drawn as one solid; this is how wide its boxing reads. */
const STACK_RADIUS = 0.06;

export class Plumbing {
  readonly group = new THREE.Group();

  private visible = false;
  private builtSignature = '';
  private meshes: THREE.Mesh[] = [];
  private targets: THREE.Mesh[] = [];
  private materials = new Map<number, THREE.MeshStandardMaterial>();
  private geometries = new Map<string, THREE.BufferGeometry>();
  private selectedId: string | null = null;

  /** Which systems are drawn. Both on by default. */
  private showDrainage = true;
  private showSupply = true;

  constructor() {
    this.group.name = 'Plumbing';
    this.group.visible = false;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  setSystems(drainage: boolean, supply: boolean): void {
    if (drainage === this.showDrainage && supply === this.showSupply) return;
    this.showDrainage = drainage;
    this.showSupply = supply;
    // Force a rebuild rather than let the signature match.
    this.builtSignature = '';
  }

  /**
   * Rebuilds the pipework passing through one storey.
   *
   * A run may cross storeys — that is the normal case for a stack — so a run is
   * drawn here if ANY of its points is on this level. The parts on other
   * storeys are then drawn in this storey's frame, which is what makes a stack
   * read as one continuous pipe rather than as a stub per floor.
   *
   * The signature includes the sizes, not just the positions: adding a bath
   * upstairs changes no geometry at all on the ground floor and changes the
   * diameter of everything under it, and a signature of positions alone would
   * leave the old pipe on screen.
   */
  update(doc: DesignDocument, levelId: string): void {
    if (!this.visible) return;

    const drainage = this.showDrainage ? sizeAllDrainage(doc) : [];
    const supply = this.showSupply ? sizeAllSupply(doc) : [];

    const relevant = [
      ...drainage.map((entry) => ({ run: entry.run, radius: entry.size.size / 2 })),
      ...supply.map((entry) => ({ run: entry.run, radius: entry.size.size / 2 })),
    ].filter((entry) => entry.run.points.some((point) => point.levelId === levelId));

    const signature =
      relevant
        .map(
          (entry) =>
            `${entry.run.id}:${entry.radius.toFixed(4)}:` +
            entry.run.points
              .map(
                (point) =>
                  `${point.levelId},${point.at.x.toFixed(3)},${point.at.z.toFixed(3)},${point.height.toFixed(3)}`,
              )
              .join(';'),
        )
        .join('|') +
      `#${levelId}#${this.showDrainage}${this.showSupply}` +
      `#${doc.plumbing.stacks.map((stack) => `${stack.at.x.toFixed(2)},${stack.at.z.toFixed(2)}`).join(',')}` +
      `#${doc.plumbing.heater ? `${doc.plumbing.heater.at.x.toFixed(2)},${doc.plumbing.heater.litres}` : 'none'}`;

    if (signature === this.builtSignature) return;
    this.builtSignature = signature;
    this.clear();

    const base = elevationOf(doc, levelId);

    /*
     * Every point is converted into THIS storey's frame. The group is parented
     * to the storey group, which already carries the level's elevation, so a
     * point on the floor above has to be drawn at its own elevation minus this
     * one — otherwise a stack would be drawn as a pipe on each floor at the
     * same height, which is the classic way a riser ends up looking like a row
     * of unconnected stubs.
     */
    const toLocal = (point: PipePoint): THREE.Vector3 =>
      new THREE.Vector3(
        point.at.x,
        elevationOf(doc, point.levelId) - base + point.height,
        point.at.z,
      );

    for (const entry of relevant) {
      const colour = SYSTEM_COLOURS[entry.run.system];
      const material = this.materialFor(colour);

      for (let i = 1; i < entry.run.points.length; i += 1) {
        const from = toLocal(entry.run.points[i - 1]!);
        const to = toLocal(entry.run.points[i]!);
        const mesh = this.segment(from, to, entry.radius, material);
        if (!mesh) continue;

        mesh.userData.pickKind = 'pipe';
        mesh.userData.pickId = entry.run.id;
        this.group.add(mesh);
        this.meshes.push(mesh);
        this.targets.push(mesh);

        // A joint at each turn, so a bend does not read as two pipes that miss.
        if (i < entry.run.points.length - 1) {
          const joint = new THREE.Mesh(this.sphere(entry.radius), material);
          joint.position.copy(to);
          joint.userData.pickKind = 'pipe';
          joint.userData.pickId = entry.run.id;
          this.group.add(joint);
          this.meshes.push(joint);
        }
      }
    }

    /* ---- The water heater, as the cylinder it is ---- */

    const heater = doc.plumbing.heater;
    if (this.showSupply && heater && heater.levelId === levelId) {
      // Roughly the proportions of a real cylinder: volume into a 500 mm body.
      const radius = heater.kind === 'instantaneous' ? 0.12 : 0.28;
      const height =
        heater.kind === 'instantaneous'
          ? 0.6
          : Math.max(0.9, heater.litres / (Math.PI * radius * radius * 1000));

      const mesh = new THREE.Mesh(
        this.cylinder(radius, height),
        this.materialFor(0xd8d2c6),
      );
      mesh.position.set(heater.at.x, height / 2, heater.at.z);
      mesh.castShadow = true;
      mesh.userData.pickKind = 'heater';
      mesh.userData.pickId = heater.id;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.targets.push(mesh);
    }

    /* ---- The stack, boxed in ---- */

    if (this.showDrainage) {
      for (const stack of doc.plumbing.stacks) {
        const from = elevationOf(doc, stack.fromLevelId) - base;
        const level = doc.levels.find((candidate) => candidate.id === stack.toLevelId);
        const to = elevationOf(doc, stack.toLevelId) - base + (level?.wallHeight ?? 2.4);

        const mesh = new THREE.Mesh(
          this.cylinder(STACK_RADIUS, Math.max(0.1, to - from)),
          this.materialFor(SYSTEM_COLOURS.soil),
        );
        mesh.position.set(stack.at.x, (from + to) / 2, stack.at.z);
        mesh.userData.pickKind = 'stack';
        mesh.userData.pickId = stack.id;
        this.group.add(mesh);
        this.meshes.push(mesh);
        this.targets.push(mesh);
      }
    }

    this.applySelection();
  }

  /* -------------------------------- Geometry ------------------------------ */

  /**
   * One length of pipe between two points, in any direction.
   *
   * A cylinder is built along +Y, so it is rotated onto the segment with a
   * quaternion rather than with Euler angles: a vertical drop is exactly the
   * case where an Euler solution gimbals, and a stack is the most common pipe
   * in the building.
   */
  private segment(
    from: THREE.Vector3,
    to: THREE.Vector3,
    radius: number,
    material: THREE.Material,
  ): THREE.Mesh | null {
    const direction = new THREE.Vector3().subVectors(to, from);
    const length = direction.length();
    if (length < 1e-4) return null;

    const mesh = new THREE.Mesh(this.cylinder(radius, length), material);
    mesh.position.copy(from).addScaledVector(direction, 0.5);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.normalize(),
    );
    return mesh;
  }

  /** A cylinder, cached by rounded radius and length. */
  private cylinder(radius: number, length: number): THREE.BufferGeometry {
    const key = `c${radius.toFixed(3)}:${length.toFixed(2)}`;
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = new THREE.CylinderGeometry(radius, radius, length, 10, 1);
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  /** A joint sphere, cached by rounded radius. */
  private sphere(radius: number): THREE.BufferGeometry {
    const key = `s${radius.toFixed(3)}`;
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = new THREE.SphereGeometry(radius, 8, 6);
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  private materialFor(colour: number): THREE.MeshStandardMaterial {
    let material = this.materials.get(colour);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: colour,
        roughness: 0.45,
        metalness: 0.25,
      });
      this.materials.set(colour, material);
    }
    return material;
  }

  /* ------------------------------- Selection ------------------------------ */

  pickTargets(): THREE.Mesh[] {
    return this.visible ? this.targets : [];
  }

  setSelection(selectedId: string | null): void {
    if (selectedId === this.selectedId) return;
    this.selectedId = selectedId;
    this.applySelection();
  }

  /**
   * Highlights the selected run.
   *
   * Emissive rather than scaled, unlike the electrical devices. A pipe is long
   * and thin: scaling it up by 1.6 would make it intersect the walls either
   * side, and a run that lights up reads more clearly anyway because the whole
   * length of it changes at once.
   */
  private applySelection(): void {
    for (const mesh of this.meshes) {
      const selected =
        this.selectedId !== null && mesh.userData.pickId === this.selectedId;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (!material.emissive) continue;

      // Cloned on first highlight so the shared material is not lit for every
      // pipe of the same colour in the building.
      if (selected && !mesh.userData.highlighted) {
        mesh.material = material.clone();
        (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x404040);
        mesh.userData.highlighted = true;
      } else if (!selected && mesh.userData.highlighted) {
        (mesh.material as THREE.MeshStandardMaterial).dispose();
        mesh.material = this.materialFor(material.color.getHex());
        mesh.userData.highlighted = false;
      }
    }
  }

  private clear(): void {
    for (const mesh of this.meshes) {
      if (mesh.userData.highlighted) (mesh.material as THREE.Material).dispose();
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
