/**
 * Drawing the heating and cooling.
 *
 * -----------------------------------------------------------------------------
 * A DUCT IS DRAWN AT ITS REAL DIAMETER, AND THAT IS THE POINT.
 *
 * The single most useful thing this layer does is show how much space the
 * ductwork actually wants. A trunk carrying 1,200 cfm is a 16 in duct — 400 mm
 * across — and that does not fit in a 250 mm floor void, in a 2x10 joist bay,
 * or anywhere else somebody assumed it would go. Drawn as a schematic line it
 * looks like nothing; drawn at size it is immediately obvious that either the
 * floor build-up grows or the trunk has to be flattened into a rectangle.
 *
 * That is a decision worth making at design time rather than on site, so the
 * geometry is honest even when the answer is inconvenient.
 *
 * -----------------------------------------------------------------------------
 * SIZES ARE DERIVED HERE TOO.
 *
 * Nothing in the document says how big any of this is. The diameters come from
 * the airflow, which comes from the equipment, which comes from the load — so
 * adding a window upstairs changes no duct geometry at all and changes the
 * diameter of the trunk under it. A signature built from positions alone would
 * leave the old duct on screen, so the sizes go into it.
 */

import * as THREE from 'three';

import { elevationOf } from '@/state/levels';
import { sizeAllDucts } from '@/services/ductSize';
import { calculateLoad, type BuildingLoad } from '@/services/manualJ';
import { selectSystem, type SystemSelection } from '@/services/manualS';
import { HVAC_LIMITS, type DesignDocument, type PipePoint } from '@/state/types';

/**
 * Colours.
 *
 * Blue for supply and warm grey for return, which is the convention on a
 * mechanical drawing, and it matters here because the two run at different
 * heights and cross each other constantly — without a colour difference the
 * model is a bowl of spaghetti.
 */
const SUPPLY_COLOUR = 0x4a90b8;
const RETURN_COLOUR = 0x9a8f80;
const REGISTER_COLOUR = 0xdad5cc;
const PLANT_COLOUR = 0x8d949c;
const RADIATOR_COLOUR = 0xf2f0ec;
const UNDERFLOOR_COLOUR = 0xd98f5a;

/** Inches to metres, for the duct table. */
const INCH = 0.0254;

export class Hvac {
  readonly group = new THREE.Group();

  private visible = false;
  private builtSignature = '';
  private meshes: THREE.Mesh[] = [];
  private targets: THREE.Mesh[] = [];
  private materials = new Map<number, THREE.MeshStandardMaterial>();
  private geometries = new Map<string, THREE.BufferGeometry>();
  private selectedId: string | null = null;

  private showSupply = true;
  private showReturn = true;

  /**
   * The last derivation, kept against the document it came from.
   *
   * `update` is called whenever the editor state changes — including on a
   * selection — and the load calculation walks every wall of every room. There
   * is no need to do that again for a document that has not changed.
   */
  private cachedFor: DesignDocument | null = null;
  private cached: { load: BuildingLoad; selection: SystemSelection } | null = null;

  constructor() {
    this.group.name = 'Hvac';
    this.group.visible = false;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  setSystems(supply: boolean, returns: boolean): void {
    if (supply === this.showSupply && returns === this.showReturn) return;
    this.showSupply = supply;
    this.showReturn = returns;
    this.builtSignature = '';
  }

  private derive(doc: DesignDocument): { load: BuildingLoad; selection: SystemSelection } {
    if (this.cachedFor === doc && this.cached) return this.cached;

    const load = calculateLoad(doc);
    const selection = selectSystem(load, doc.hvac.system, {
      heatingEquipmentId: doc.hvac.equipmentManual ? doc.hvac.heatingEquipmentId : null,
      coolingEquipmentId: doc.hvac.equipmentManual ? doc.hvac.coolingEquipmentId : null,
    });

    this.cachedFor = doc;
    this.cached = { load, selection };
    return this.cached;
  }

  /**
   * Rebuilds the ductwork passing through one storey.
   *
   * As with the plumbing, a run is drawn here if ANY of its points is on this
   * level, and the parts on other storeys are drawn in this storey's frame —
   * which is what makes a riser read as one continuous duct rather than as a
   * stub on each floor.
   */
  update(doc: DesignDocument, levelId: string): void {
    if (!this.visible) return;

    const { load, selection } = this.derive(doc);
    const sized = sizeAllDucts(doc, load, selection);

    const relevant = sized.filter(
      (duct) =>
        (duct.run.system === 'supply' ? this.showSupply : this.showReturn) &&
        duct.run.points.some((point) => point.levelId === levelId),
    );

    const signature =
      relevant
        .map(
          (duct) =>
            `${duct.run.id}:${duct.size.inches}:` +
            duct.run.points
              .map(
                (point) =>
                  `${point.levelId},${point.at.x.toFixed(3)},${point.at.z.toFixed(3)},${point.height.toFixed(3)}`,
              )
              .join(';'),
        )
        .join('|') +
      `#${levelId}#${this.showSupply}${this.showReturn}` +
      `#${doc.hvac.registers.map((register) => `${register.id},${register.at.x.toFixed(2)},${register.at.z.toFixed(2)}`).join(',')}` +
      `#${doc.hvac.emitters.map((emitter) => `${emitter.id},${emitter.at.x.toFixed(2)},${emitter.length.toFixed(2)}`).join(',')}` +
      `#${doc.hvac.airHandler ? `${doc.hvac.airHandler.at.x.toFixed(2)},${doc.hvac.airHandler.at.z.toFixed(2)}` : 'none'}`;

    if (signature === this.builtSignature) return;
    this.builtSignature = signature;
    this.clear();

    const base = elevationOf(doc, levelId);
    const toLocal = (point: PipePoint): THREE.Vector3 =>
      new THREE.Vector3(
        point.at.x,
        elevationOf(doc, point.levelId) - base + point.height,
        point.at.z,
      );

    /* ---- The ducts ---- */

    for (const duct of relevant) {
      const colour = duct.run.system === 'supply' ? SUPPLY_COLOUR : RETURN_COLOUR;
      const material = this.materialFor(colour);
      const radius = (duct.size.inches * INCH) / 2;

      for (let i = 1; i < duct.run.points.length; i += 1) {
        const from = toLocal(duct.run.points[i - 1]!);
        const to = toLocal(duct.run.points[i]!);
        const mesh = this.segment(from, to, radius, material);
        if (!mesh) continue;

        mesh.userData.pickKind = 'duct';
        mesh.userData.pickId = duct.run.id;
        this.add(mesh, true);

        // An elbow at each turn, so a bend does not read as two ducts that miss.
        if (i < duct.run.points.length - 1) {
          const joint = new THREE.Mesh(this.sphere(radius), material);
          joint.position.copy(to);
          joint.userData.pickKind = 'duct';
          joint.userData.pickId = duct.run.id;
          this.add(joint, false);
        }
      }
    }

    /* ---- The registers, as the plates they are ---- */

    for (const register of doc.hvac.registers) {
      if (register.levelId !== levelId) continue;
      if (register.system === 'supply' ? !this.showSupply : !this.showReturn) continue;

      // A return grille is much larger than a supply register, because it
      // carries a whole storey's air at a much lower face velocity.
      const width = register.system === 'supply' ? 0.3 : 0.55;
      const height = register.system === 'supply' ? 0.15 : 0.4;

      const mesh = new THREE.Mesh(
        this.box(width, height, 0.04),
        this.materialFor(REGISTER_COLOUR),
      );
      mesh.position.set(register.at.x, register.height + height / 2, register.at.z);
      mesh.userData.pickKind = 'register';
      mesh.userData.pickId = register.id;
      this.add(mesh, true);
    }

    /* ---- The plant ---- */

    const handler = doc.hvac.airHandler;
    if (handler && handler.levelId === levelId) {
      const mesh = new THREE.Mesh(this.box(0.6, 1.5, 0.6), this.materialFor(PLANT_COLOUR));
      mesh.position.set(handler.at.x, 0.75, handler.at.z);
      mesh.castShadow = true;
      mesh.userData.pickKind = 'air-handler';
      mesh.userData.pickId = 'air-handler';
      this.add(mesh, true);
    }

    /* ---- Radiators and underfloor ---- */

    for (const emitter of doc.hvac.emitters) {
      if (emitter.levelId !== levelId) continue;

      if (emitter.kind === 'radiator') {
        const mesh = new THREE.Mesh(
          this.box(Math.max(0.3, emitter.length), HVAC_LIMITS.radiatorHeight, HVAC_LIMITS.radiatorDepth),
          this.materialFor(RADIATOR_COLOUR),
        );
        // 150 mm off the floor, which is what the brackets give and what lets
        // the convection current start under it.
        mesh.position.set(emitter.at.x, 0.15 + HVAC_LIMITS.radiatorHeight / 2, emitter.at.z);
        mesh.castShadow = true;
        mesh.userData.pickKind = 'emitter';
        mesh.userData.pickId = emitter.id;
        this.add(mesh, true);
      } else {
        /*
         * Underfloor is drawn as a warm translucent patch on the floor rather
         * than as pipe. Drawing 120 m of loop would be honest and unreadable,
         * and the useful fact — which rooms have it — reads instantly this way.
         */
        const mesh = new THREE.Mesh(
          this.box(2.4, 0.02, 2.4),
          this.translucent(UNDERFLOOR_COLOUR),
        );
        mesh.position.set(emitter.at.x, 0.02, emitter.at.z);
        mesh.userData.pickKind = 'emitter';
        mesh.userData.pickId = emitter.id;
        this.add(mesh, true);
      }
    }

    this.applySelection();
  }

  private add(mesh: THREE.Mesh, pickable: boolean): void {
    this.group.add(mesh);
    this.meshes.push(mesh);
    if (pickable) this.targets.push(mesh);
  }

  /* -------------------------------- Geometry ------------------------------ */

  /** One length of duct between two points, in any direction. */
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
    // A quaternion rather than Euler angles: a vertical riser is exactly the
    // case an Euler solution gimbals on.
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    return mesh;
  }

  private cylinder(radius: number, length: number): THREE.BufferGeometry {
    const key = `c${radius.toFixed(3)}:${length.toFixed(2)}`;
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = new THREE.CylinderGeometry(radius, radius, length, 12, 1);
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  private sphere(radius: number): THREE.BufferGeometry {
    const key = `s${radius.toFixed(3)}`;
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = new THREE.SphereGeometry(radius, 10, 8);
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  private box(width: number, height: number, depth: number): THREE.BufferGeometry {
    const key = `b${width.toFixed(2)}:${height.toFixed(2)}:${depth.toFixed(2)}`;
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = new THREE.BoxGeometry(width, height, depth);
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  private materialFor(colour: number): THREE.MeshStandardMaterial {
    let material = this.materials.get(colour);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: colour,
        roughness: 0.5,
        metalness: 0.35,
      });
      this.materials.set(colour, material);
    }
    return material;
  }

  private translucent(colour: number): THREE.MeshStandardMaterial {
    const key = colour + 1;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: colour,
        roughness: 0.8,
        metalness: 0,
        transparent: true,
        opacity: 0.35,
      });
      this.materials.set(key, material);
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

  /** Highlights the selected run, emissively — a duct is long and thin. */
  private applySelection(): void {
    for (const mesh of this.meshes) {
      const selected = this.selectedId !== null && mesh.userData.pickId === this.selectedId;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (!material.emissive) continue;

      if (selected && !mesh.userData.highlighted) {
        mesh.material = material.clone();
        (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x3a4a50);
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
    this.cachedFor = null;
    this.cached = null;
  }
}
