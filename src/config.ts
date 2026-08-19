export interface PlacementMeta {
  shore: { east: number; north: number };
  offshoreDir: { east: number; north: number };
  reefShore: { east: number; north: number };
  reefDir: { east: number; north: number };
  reefLen: number;
  lineup: { east: number; north: number };
}

export interface AssetsMeta {
  center: { lat: number; lon: number };
  sizeMeters: number;
  heightmapResolution: number;
  placement: PlacementMeta;
  attribution: { elevation: string; imagery: string };
}

/** One Gerstner component. dir is the travel direction in world xz. */
export interface WaveDef {
  dirX: number;
  dirZ: number;
  wavelength: number;
  amplitude: number;
  steepness: number; // Q in [0,1]
}

export const NUM_WAVES = 8;
export const NUM_SWELL = 3; // first N waves shoal, break and get set-gain

export const GRAVITY = 9.81;

/** World axes: x = east (m), z = south (m), y = up. north = -z. */
export function eastNorthToWorld(east: number, north: number) {
  return { x: east, z: -north };
}

function rotate(dirX: number, dirZ: number, deg: number) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r),
    s = Math.sin(r);
  return { x: dirX * c - dirZ * s, z: dirX * s + dirZ * c };
}

/**
 * Build the wave table from the baked shoreline geometry: the groundswell
 * travels shoreward, angled a touch so crests strike the SW side of the reef
 * first and the wave peels toward the NE channel (Bells is a right-hander).
 */
export function makeWaves(placement: PlacementMeta): WaveDef[] {
  const onshore = eastNorthToWorld(
    -placement.reefDir.east,
    -placement.reefDir.north
  );
  const offshore = eastNorthToWorld(
    placement.offshoreDir.east,
    placement.offshoreDir.north
  );
  const swell = rotate(onshore.x, onshore.z, -14);

  const w = (
    base: { x: number; z: number },
    deg: number,
    wavelength: number,
    amplitude: number,
    steepness: number
  ): WaveDef => {
    const d = rotate(base.x, base.z, deg);
    const len = Math.hypot(d.x, d.z);
    return {
      dirX: d.x / len,
      dirZ: d.z / len,
      wavelength,
      amplitude,
      steepness,
    };
  };

  return [
    // Long-period Southern Ocean groundswell; two close wavelengths make
    // natural wave groups through interference.
    w(swell, 0, 115, 0.95, 0.42),
    w(swell, 4, 98, 0.66, 0.44),
    w(swell, -12, 55, 0.28, 0.5),
    // Mid-scale texture travelling with the swell.
    w(swell, 28, 24, 0.07, 0.5),
    // Offshore-wind chop: light morning nor'wester grooming the faces,
    // travelling out to sea against the swell.
    w(offshore, 14, 15, 0.055, 0.55),
    w(offshore, -22, 9, 0.038, 0.6),
    w(offshore, 38, 5.5, 0.026, 0.65),
    w(offshore, -55, 3.4, 0.016, 0.7),
  ];
}

export interface QualityTier {
  name: "low" | "high";
  pixelRatioCap: number;
  oceanSegments: number;
  terrainSegments: number;
}

export const QUALITY: Record<"low" | "high", QualityTier> = {
  high: { name: "high", pixelRatioCap: 2, oceanSegments: 360, terrainSegments: 256 },
  low: { name: "low", pixelRatioCap: 1.2, oceanSegments: 220, terrainSegments: 176 },
};

export const OCEAN_RADIUS = 4500; // half-extent of the warped ocean grid, m
export const EYE_HEIGHT = 1.35; // sitting on a board, eyes above the water
export const SEA_LEVEL = 0;

// Wave-set scheduling (seconds).
export const SET_PERIOD_MEAN = 95;
export const SET_PERIOD_JITTER = 30;
export const SET_DURATION = 42;
export const SET_GAIN_BASE = 0.45; // lull swell size multiplier
export const SET_GAIN_PEAK = 1.38; // set wave multiplier
