/**
 * Drawing the electrical.
 *
 * Two things at once, and they answer different questions.
 *
 *   • THE DEVICES, drawn as small solids at their real mounting heights. Not
 *     as flat plan symbols floating over the floor: the whole reason this app
 *     is three-dimensional is that a switch at 46 in and a receptacle at 15 in
 *     look different from across the room, and somebody standing in the model
 *     can see at a glance that a socket is behind where the sofa goes.
 *   • THE HOME RUNS, drawn as lines from each device back to the panel,
 *     coloured by circuit. These are NOT cable routes — a real cable follows
 *     joists and stud bays and nobody can know where those are yet, and drawing
 *     a confident route through a wall that has not been framed would be a lie.
 *     They are the schedule made visible: what is on which breaker, in the
 *     room rather than in a table.
 *
 * Geometry is shared: every receptacle in the house is the same box, drawn from
 * one geometry with one material per family. A whole-house layout is several
 * hundred devices, and giving each its own geometry would put the draw call
 * count up by more than the walls cost.
 */

import * as THREE from 'three';

import { MOUNTING } from '@/code/nec';
import { isLighting, isReceptacle } from '@/services/layout';
import { elevationOf } from '@/state/levels';
import type { DesignDocument, DeviceKind, ElectricalDevice } from '@/state/types';

/**
 * The colours a circuit is drawn in, cycled through in order.
 *
 * Chosen to stay apart from each other and from the building: a house is browns
 * and off-whites, so saturated hues read as "not part of the fabric", which is
 * exactly what a home run is.
 */
const CIRCUIT_COLOURS = [
  0xe4572e, 0x2e86ab, 0x8e6c8a, 0x3fa34d, 0xd4a017, 0x5b5f97, 0xc44536, 0x1b998b,
];

/** How a kind of device is drawn: its colour and its size. */
interface Symbol3D {
  color: number;
  /** Width, height, depth of the little solid, in metres. */
  size: [number, number, number];
}

const SYMBOLS: Record<DeviceKind, Symbol3D> = {
  receptacle: { color: 0xf2f0eb, size: [0.08, 0.12, 0.02] },
  'receptacle-gfci': { color: 0x4fb477, size: [0.08, 0.12, 0.02] },
  'receptacle-counter': { color: 0x4fb477, size: [0.08, 0.12, 0.02] },
  'receptacle-appliance': { color: 0xe4a11b, size: [0.1, 0.14, 0.02] },
  switch: { color: 0xf2f0eb, size: [0.08, 0.12, 0.02] },
  'switch-3way': { color: 0xd8d3c8, size: [0.08, 0.12, 0.02] },
  'switch-dimmer': { color: 0xd8d3c8, size: [0.08, 0.14, 0.02] },
  'light-ceiling': { color: 0xfff2cc, size: [0.26, 0.1, 0.26] },
  'light-wall': { color: 0xfff2cc, size: [0.14, 0.16, 0.1] },
  'light-recessed': { color: 0xfff2cc, size: [0.16, 0.04, 0.16] },
  fan: { color: 0xf6efe2, size: [0.9, 0.08, 0.9] },
  'smoke-alarm': { color: 0xf7f7f5, size: [0.13, 0.04, 0.13] },
  thermostat: { color: 0xdfe6ec, size: [0.09, 0.12, 0.02] },
  panel: { color: 0x9aa3ab, size: [0.36, 0.5, 0.1] },
};

export class Electrical {
  readonly group = new THREE.Group();

  private visible = false;
  private builtSignature = '';
  private meshes: THREE.Mesh[] = [];
  /** The subset of `meshes` the pointer may hit — device bodies only. */
  private targets: THREE.Mesh[] = [];
  private lines: THREE.Line[] = [];
  private materials = new Map<number, THREE.MeshStandardMaterial>();
  private lineMaterials = new Map<number, THREE.LineBasicMaterial>();
  private geometries = new Map<string, THREE.BoxGeometry>();

  /** Whether home runs are drawn as well as the devices themselves. */
  private showRuns = true;

  /** The device the user has selected, drawn larger so the click is visible. */
  private selectedId: string | null = null;

  constructor() {
    this.group.name = 'Electrical';
    this.group.visible = false;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  setShowRuns(showRuns: boolean): void {
    if (showRuns === this.showRuns) return;
    this.showRuns = showRuns;
    // Force the next update to rebuild rather than match its signature.
    this.builtSignature = '';
  }

  /**
   * Rebuilds the devices standing on one storey.
   *
   * Signature-gated like every other rebuild in the scene, and the signature
   * includes the circuit each device is on: re-wiring changes no position at
   * all but changes every colour, and a signature of positions alone would
   * leave the old colours on screen.
   */
  update(doc: DesignDocument, levelId: string): void {
    if (!this.visible) return;

    const devices = doc.electrical.devices.filter((device) => device.levelId === levelId);
    const panel = doc.electrical.panel?.levelId === levelId ? doc.electrical.panel : null;

    const signature =
      devices
        .map(
          (device) =>
            `${device.id}:${device.kind}:${device.at.x.toFixed(3)},${device.at.z.toFixed(3)},` +
            `${device.height.toFixed(3)},${device.rotation.toFixed(3)},${device.circuitId ?? '-'}`,
        )
        .join('|') +
      `#${
        panel
          ? `${panel.at.x.toFixed(3)},${panel.at.z.toFixed(3)},${panel.rotation.toFixed(3)},${panel.mainAmps}`
          : 'none'
      }` +
      `#${this.showRuns}#${doc.electrical.circuits.map((circuit) => circuit.id).join(',')}`;

    if (signature === this.builtSignature) return;
    this.builtSignature = signature;
    this.clear();

    /*
     * Devices are drawn in the ACTIVE STOREY's own coordinates because this
     * group is parented to the storey group, which already carries the level's
     * elevation. The panel, though, may live on a different storey, and its
     * home runs still have to reach it — so its position is converted into
     * this storey's frame rather than being drawn where it is not.
     */
    const panelElevation = doc.electrical.panel
      ? elevationOf(doc, doc.electrical.panel.levelId) - elevationOf(doc, levelId)
      : 0;
    const panelPoint = doc.electrical.panel
      ? new THREE.Vector3(
          doc.electrical.panel.at.x,
          panelElevation + MOUNTING.panelCentre,
          doc.electrical.panel.at.z,
        )
      : null;

    const colourOf = this.circuitColours(doc);

    for (const device of devices) this.addDevice(device, colourOf);
    if (panel) this.addPanel(panel.at.x, panel.at.z, panel.rotation);

    if (this.showRuns && panelPoint) {
      /*
       * Runs are gathered just under the ceiling of the storey they are on,
       * which is both where a cable would actually run and — more to the point
       * — inside the building. Taking the highest device plus a clearance put
       * the ceiling fan's run THROUGH the roof, which read as a fault in the
       * roof rather than as a diagram.
       */
      const level = doc.levels.find((entry) => entry.id === levelId);
      const ceiling = (level?.wallHeight ?? 2.4) - 0.1;

      for (const device of devices) {
        if (device.kind === 'panel') continue;
        this.addRun(device, panelPoint, ceiling, colourOf(device.circuitId));
      }
    }

    // The meshes are new, so the highlight has to be put back on.
    this.applySelection();
  }

  /** A stable colour per circuit, in the order the circuits are listed. */
  private circuitColours(doc: DesignDocument): (circuitId: string | null) => number {
    const byId = new Map<string, number>();
    doc.electrical.circuits.forEach((circuit, index) => {
      byId.set(circuit.id, CIRCUIT_COLOURS[index % CIRCUIT_COLOURS.length]!);
    });
    // Devices on no circuit are grey, which is what "unfinished" looks like.
    return (circuitId) => (circuitId ? (byId.get(circuitId) ?? 0x8a8a8a) : 0x8a8a8a);
  }

  private addDevice(device: ElectricalDevice, colourOf: (id: string | null) => number): void {
    const symbol = SYMBOLS[device.kind];
    const mesh = new THREE.Mesh(this.geometryFor(device.kind, symbol.size), this.materialFor(symbol.color));

    // A ceiling fitting hangs from the ceiling; everything else is on a wall
    // at its own mounting height, which is stored on the device.
    const hanging = isLighting(device.kind) || device.kind === 'smoke-alarm';
    const y = hanging ? device.height - symbol.size[1] / 2 - 0.01 : device.height;

    mesh.position.set(device.at.x, y, device.at.z);
    mesh.rotation.y = device.rotation;
    mesh.name = `Device_${device.id}`;
    // The convention the rest of the scene picks by. Getting this wrong is
    // silent: the mesh simply never registers a hit.
    mesh.userData.pickKind = 'device';
    mesh.userData.pickId = device.id;
    this.targets.push(mesh);
    // Small, self-lit-looking objects: casting shadows from a light switch
    // costs a shadow-map draw and buys nothing anybody would notice.
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    // A thin ring of the circuit's colour behind the plate, so the colour is
    // legible without repainting the device itself.
    if (isReceptacle(device.kind) || device.kind.startsWith('switch')) {
      const backing = new THREE.Mesh(
        this.geometryFor(`${device.kind}-back`, [
          symbol.size[0] + 0.03,
          symbol.size[1] + 0.03,
          0.008,
        ]),
        this.materialFor(colourOf(device.circuitId)),
      );
      backing.position.copy(mesh.position);
      backing.rotation.y = device.rotation;
      backing.raycast = () => {};
      this.group.add(backing);
      this.meshes.push(backing);
    }

    this.group.add(mesh);
    this.meshes.push(mesh);
  }

  private addPanel(x: number, z: number, rotation: number): void {
    const symbol = SYMBOLS.panel;
    const mesh = new THREE.Mesh(this.geometryFor('panel', symbol.size), this.materialFor(symbol.color));
    mesh.position.set(x, MOUNTING.panelCentre, z);
    mesh.rotation.y = rotation;
    mesh.name = 'ElectricalPanel';
    // The panel is not a device in the document, so it is not pickable: it is
    // moved by re-laying the electrical out, not by dragging.
    mesh.raycast = () => {};
    this.group.add(mesh);
    this.meshes.push(mesh);
  }

  /**
   * One home run, drawn as three segments: up the wall to ceiling level, across
   * to above the panel, and down to it.
   *
   * A straight line through the middle of the room would read as a cable
   * strung across the living room. This right-angled path is how a run is
   * DRAWN on an electrical plan — and it is honest about being a diagram,
   * because no real cable turns two perfect right angles in mid-air.
   */
  private addRun(
    device: ElectricalDevice,
    panel: THREE.Vector3,
    ceiling: number,
    colour: number,
  ): void {
    // Never below the thing it is leaving or the thing it is going to, and
    // never above the ceiling it runs under.
    const high = Math.max(ceiling, device.height + 0.05, panel.y + 0.05);
    const points = [
      new THREE.Vector3(device.at.x, device.height, device.at.z),
      new THREE.Vector3(device.at.x, high, device.at.z),
      new THREE.Vector3(panel.x, high, panel.z),
      new THREE.Vector3(panel.x, panel.y, panel.z),
    ];

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, this.lineMaterialFor(colour));
    line.name = `Run_${device.id}`;
    line.raycast = () => {};
    this.group.add(line);
    this.lines.push(line);
  }

  private geometryFor(key: string, size: [number, number, number]): THREE.BoxGeometry {
    const existing = this.geometries.get(key);
    if (existing) return existing;
    const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
    this.geometries.set(key, geometry);
    return geometry;
  }

  private materialFor(color: number): THREE.MeshStandardMaterial {
    const existing = this.materials.get(color);
    if (existing) return existing;
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 });
    this.materials.set(color, material);
    return material;
  }

  private lineMaterialFor(color: number): THREE.LineBasicMaterial {
    const existing = this.lineMaterials.get(color);
    if (existing) return existing;
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 });
    this.lineMaterials.set(color, material);
    return material;
  }

  /** What the pointer may pick: nothing at all while the layer is hidden. */
  pickTargets(): THREE.Mesh[] {
    return this.visible ? this.targets : [];
  }

  /** Highlights the selected device, so a click has a visible result. */
  setSelection(selectedId: string | null): void {
    if (selectedId === this.selectedId) return;
    this.selectedId = selectedId;
    this.applySelection();
  }

  private applySelection(): void {
    for (const mesh of this.targets) {
      const selected = mesh.userData.pickId === this.selectedId;
      // Scaled rather than recoloured: these are two-centimetre plates, and a
      // colour change on something that small is easy to miss entirely.
      mesh.scale.setScalar(selected ? 1.6 : 1);
    }
  }

  private clear(): void {
    for (const mesh of this.meshes) this.group.remove(mesh);
    this.targets = [];
    for (const line of this.lines) {
      line.geometry.dispose();
      this.group.remove(line);
    }
    this.meshes = [];
    this.lines = [];
  }

  dispose(): void {
    this.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const material of this.lineMaterials.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.lineMaterials.clear();
    this.group.clear();
  }
}
