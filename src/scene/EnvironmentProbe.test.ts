/**
 * A cube capture needs a GL context, so what is checked here is the rule that
 * decides WHICH materials get the captured probe — which is the part that was
 * got wrong, and the part whose being wrong is invisible.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { REFLECTIVE_ROUGHNESS, wantsReflections } from './EnvironmentProbe';

describe('wantsReflections', () => {
  it('leaves plaster alone', () => {
    // Painted plaster at 0.9 scatters a reflection into something
    // indistinguishable from ambient light, which the bake already supplies
    // per vertex and better.
    expect(wantsReflections(new THREE.MeshStandardMaterial({ roughness: 0.9 }))).toBe(false);
    expect(wantsReflections(new THREE.MeshStandardMaterial({ roughness: 0.55 }))).toBe(false);
  });

  it('takes anything smooth enough to return a picture', () => {
    expect(wantsReflections(new THREE.MeshStandardMaterial({ roughness: 0.04 }))).toBe(true);
    expect(wantsReflections(new THREE.MeshStandardMaterial({ roughness: REFLECTIVE_ROUGHNESS })))
      .toBe(true);
  });

  it('takes glass, which is see-through as well as smooth', () => {
    const glass = new THREE.MeshPhysicalMaterial({ transmission: 0.88, roughness: 0.04 });
    expect(wantsReflections(glass)).toBe(true);
  });

  it('honours a mark, because a roughness map can hide how smooth a thing is', () => {
    /*
     * The case that was got wrong. A floor's material reads 0.6 and its
     * roughness MAP multiplies that down to about 0.31 — so deciding by the
     * number alone concluded "matte" about the one large horizontal surface in
     * the building, and every sealed floor in the app went without a
     * reflection.
     */
    const floor = new THREE.MeshStandardMaterial({ roughness: 0.6 });
    expect(wantsReflections(floor)).toBe(false);

    floor.userData.reflective = true;
    expect(wantsReflections(floor)).toBe(true);
  });

  it('is not fooled by a mark that is merely present', () => {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    material.userData.reflective = false;
    expect(wantsReflections(material)).toBe(false);
  });

  it('declines a material with nowhere to put a reflection', () => {
    expect(wantsReflections(null)).toBe(false);
    expect(wantsReflections(undefined)).toBe(false);
    // A basic material is not physically based and ignores an environment map.
    expect(wantsReflections(new THREE.MeshBasicMaterial())).toBe(false);
  });
});
