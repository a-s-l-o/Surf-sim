import * as THREE from "three";
import type { AssetsMeta } from "./config";

export interface AssetBundle {
  meta: AssetsMeta;
  sizeM: number;
  /** Decoded terrain+bathymetry heights in meters, row 0 = north edge. */
  heightField: Float32Array;
  heightRes: number;
  satellite: THREE.Texture;
  foam: THREE.Texture;
  noise: THREE.Texture;
  /** Terrain height (m) at world x/z; bilinear, clamped at the edges. */
  heightAt(x: number, z: number): number;
}

async function loadImageData(url: string): Promise<ImageData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

function loadTexture(url: string): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(url);
}

export async function loadAssets(
  onProgress: (frac: number, msg: string) => void
): Promise<AssetBundle> {
  const base = `${import.meta.env.BASE_URL}assets/`;

  onProgress(0.05, "Reading the chart…");
  const meta = (await (await fetch(`${base}assets.json`)).json()) as AssetsMeta;

  onProgress(0.15, "Sounding the reef…");
  const img = await loadImageData(`${base}heightmap.png`);
  const res = img.width;
  const heightField = new Float32Array(res * res);
  for (let k = 0; k < res * res; k++) {
    heightField[k] =
      img.data[k * 4] * 256 + img.data[k * 4 + 1] + img.data[k * 4 + 2] / 256 -
      32768;
  }

  onProgress(0.45, "Loading the lineup…");
  const [satellite, foam, noise] = await Promise.all([
    loadTexture(`${base}satellite.jpg`),
    loadTexture(`${base}foam.png`),
    loadTexture(`${base}noise.png`),
  ]);
  satellite.colorSpace = THREE.SRGBColorSpace;
  satellite.anisotropy = 4;
  for (const t of [foam, noise]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }

  onProgress(0.85, "Waxing up…");
  const sizeM = meta.sizeMeters;

  function heightAt(x: number, z: number): number {
    // u ~ east, v ~ south; row 0 of the field is the north edge.
    const fx = Math.min(
      res - 1.001,
      Math.max(0, (x / sizeM + 0.5) * (res - 1))
    );
    const fy = Math.min(
      res - 1.001,
      Math.max(0, (z / sizeM + 0.5) * (res - 1))
    );
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy);
    const dx = fx - x0,
      dy = fy - y0;
    const s = (xi: number, yi: number) => heightField[yi * res + xi];
    return (
      s(x0, y0) * (1 - dx) * (1 - dy) +
      s(x0 + 1, y0) * dx * (1 - dy) +
      s(x0, y0 + 1) * (1 - dx) * dy +
      s(x0 + 1, y0 + 1) * dx * dy
    );
  }

  return {
    meta,
    sizeM,
    heightField,
    heightRes: res,
    satellite,
    foam,
    noise,
    heightAt,
  };
}
