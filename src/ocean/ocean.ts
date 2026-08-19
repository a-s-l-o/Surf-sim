import * as THREE from "three";
import type { AssetBundle } from "../assets";
import {
  GRAVITY,
  NUM_SWELL,
  NUM_WAVES,
  OCEAN_RADIUS,
  type WaveDef,
} from "../config";
import { oceanVertexShader } from "./waves.glsl";
import { oceanFragmentShader } from "./water.glsl";

export interface Ocean {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  update(time: number, setGain: number): void;
  /** CPU mirror of the swell components, for camera buoyancy. */
  waveHeightAt(x: number, z: number, time: number, setGain: number): number;
  rebuildGeometry(segments: number): void;
}

/**
 * Ocean grid warped so vertices are dense near the lineup (where waves break
 * a few meters from the camera) and sparse toward the horizon. The camera
 * stays at the lineup in v1, so the warp is baked once around it.
 */
function buildGrid(
  centerX: number,
  centerZ: number,
  segments: number,
  terrainHeightAt: (x: number, z: number) => number
) {
  const n = segments + 1;
  const positions = new Float32Array(n * n * 3);
  const terrainH = new Float32Array(n * n);
  const warp = (t: number) =>
    Math.sign(t) * (0.15 * Math.abs(t) + 0.85 * t * t) * OCEAN_RADIUS;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      const x = centerX + warp((i / segments) * 2 - 1);
      const z = centerZ + warp((j / segments) * 2 - 1);
      positions[k] = x;
      positions[k + 1] = 0;
      positions[k + 2] = z;
      terrainH[j * n + i] = terrainHeightAt(x, z);
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let q = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i;
      indices[q++] = a;
      indices[q++] = a + n;
      indices[q++] = a + 1;
      indices[q++] = a + 1;
      indices[q++] = a + n;
      indices[q++] = a + n + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("terrainH", new THREE.BufferAttribute(terrainH, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

export function createOcean(
  assets: AssetBundle,
  waves: WaveDef[],
  sunDir: THREE.Vector3,
  fogColor: THREE.Color,
  segments: number
): Ocean {
  const lineup = assets.meta.placement.lineup;
  const cx = lineup.east;
  const cz = -lineup.north;

  const dirs: THREE.Vector2[] = [];
  const data: THREE.Vector4[] = [];
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    const omega = Math.sqrt(GRAVITY * k);
    const q = w.steepness / (k * w.amplitude * NUM_WAVES);
    dirs.push(new THREE.Vector2(w.dirX, w.dirZ));
    data.push(new THREE.Vector4(k, w.amplitude, q, omega));
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: oceanVertexShader,
    fragmentShader: oceanFragmentShader,
    transparent: true,
    depthWrite: true,
    uniforms: {
      uTime: { value: 0 },
      uSetGain: { value: 1 },
      uWaveDir: { value: dirs },
      uWaveData: { value: data },
      uSunDir: { value: sunDir.clone() },
      uCamPos: { value: new THREE.Vector3() },
      uNoise: { value: assets.noise },
      uFoamTex: { value: assets.foam },
      uDeepColor: { value: new THREE.Color(0.016, 0.11, 0.16) },
      uShallowColor: { value: new THREE.Color(0.28, 0.56, 0.5) },
      uSssColor: { value: new THREE.Color(0.06, 0.5, 0.42) },
      uFogColor: { value: fogColor.clone() },
      uFogDensity: { value: 0.00016 },
      uExposure: { value: 1.05 },
      uDebug: {
        value:
          Number(new URLSearchParams(location.search).get("dbg") ?? "0") || 0,
      },
    },
  });

  const terrainHeightAt = (x: number, z: number) => assets.heightAt(x, z);
  const mesh = new THREE.Mesh(
    buildGrid(cx, cz, segments, terrainHeightAt),
    material
  );
  mesh.name = "ocean";
  mesh.renderOrder = 1;
  mesh.frustumCulled = false; // vertices move in the shader

  function waveHeightAt(
    x: number,
    z: number,
    time: number,
    setGain: number
  ): number {
    const depth = Math.max(0.05, -assets.heightAt(x, z));
    let y = 0;
    for (let i = 0; i < NUM_SWELL; i++) {
      const k = data[i].x;
      const omega = data[i].w;
      let amp = data[i].y * setGain;
      const tkd = Math.min(1, Math.max(0.06, Math.tanh(k * depth)));
      const refr = 1 / Math.sqrt(tkd);
      amp *= Math.min(refr, 2.2);
      const aMax = 0.42 * depth;
      const over = amp / aMax;
      amp = Math.min(
        amp,
        aMax * (1 + 0.25 * THREE.MathUtils.smoothstep(over, 1.0, 2.2))
      );
      const phase =
        k * refr * (dirs[i].x * x + dirs[i].y * z) - omega * time;
      y += amp * Math.sin(phase);
    }
    return y;
  }

  return {
    mesh,
    material,
    update(time, setGain) {
      material.uniforms.uTime.value = time;
      material.uniforms.uSetGain.value = setGain;
    },
    waveHeightAt,
    rebuildGeometry(newSegments: number) {
      mesh.geometry.dispose();
      mesh.geometry = buildGrid(cx, cz, newSegments, terrainHeightAt);
    },
  };
}
