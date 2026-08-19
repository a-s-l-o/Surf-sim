import * as THREE from "three";
import type { AssetBundle } from "../assets";

/**
 * The real Bells Beach terrain: heightmap-displaced grid textured with the
 * satellite image. Includes the seabed — the water shader is translucent in
 * the shallows so the sand and rock read through the shorebreak.
 */
export function createTerrain(
  assets: AssetBundle,
  segments: number
): THREE.Mesh {
  const size = assets.sizeM;
  const geo = new THREE.BufferGeometry();
  const n = segments + 1;
  const positions = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i / segments - 0.5) * size;
      const z = (j / segments - 0.5) * size;
      const k = j * n + i;
      positions[k * 3] = x;
      positions[k * 3 + 1] = assets.heightAt(x, z);
      positions[k * 3 + 2] = z;
      // satellite.jpg row 0 is the north edge; TextureLoader flips Y.
      uvs[k * 2] = x / size + 0.5;
      uvs[k * 2 + 1] = 0.5 - z / size;
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

  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  assets.satellite.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({
    map: assets.satellite,
    roughness: 1,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "terrain";
  mesh.renderOrder = 0;
  return mesh;
}
