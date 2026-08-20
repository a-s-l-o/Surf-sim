/**
 * One-time asset baker for the Bells Beach surf sim.
 *
 * Produces (committed to the repo, the app never touches the network):
 *   public/assets/heightmap.png  - terrain + bathymetry, terrarium-encoded RGB
 *   public/assets/satellite.jpg  - Sentinel-2 true-color imagery of the area
 *   public/assets/foam.png       - tileable foam mask
 *   public/assets/noise.png      - tileable water normal/noise map
 *   public/assets/assets.json    - georeferencing + attribution metadata
 *
 * Sources (both open data, no API key):
 *   - Elevation: Mapzen/AWS Terrain Tiles ("terrarium"), z15
 *     https://registry.opendata.aws/terrain-tiles/
 *   - Imagery: Sentinel-2 L2A COGs (ESA / Element 84 on AWS Open Data)
 *     https://registry.opendata.aws/sentinel-2-l2a-cogs/
 *
 * Underwater terrain is synthesized: open elevation data has no usable
 * near-shore bathymetry, so the reef/shelf profile that makes Bells break
 * is modeled from the real shoreline (distance transform) plus a tuned
 * reef wedge anchored at the real Bells Bowl coordinates.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import sharp from "sharp";
import { fromUrl } from "geotiff";

// ---------------------------------------------------------------- config

// Local scene anchor: the Bells Beach lineup (the Bowl takeoff zone).
const CENTER = { lat: -38.3689, lon: 144.2813 };
const SIZE_M = 6000; // side length of the square scene, meters
const HEIGHT_RES = 1024; // heightmap resolution (px)
const SAT_RES = 2048; // satellite texture resolution (px)
const TERRAIN_ZOOM = 15; // terrarium max zoom for this region

// Chosen for 0.01% cloud cover, 0% nodata (checked via STAC metadata).
const S2_SCENE =
  "sentinel-s2-l2a-cogs/55/H/BT/2024/12/S2B_55HBT_20241205_0_L2A";
const S2_BASE = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/";
const TERRARIUM_BASE =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/";

const OUT_DIR = new URL("../public/assets/", import.meta.url);

// -------------------------------------------------------------- geodesy

/** Meters offset from CENTER -> lat/lon (local tangent plane, fine over 6 km). */
function metersToLatLon(east, north) {
  const lat = CENTER.lat + north / 111132.9;
  const lon =
    CENTER.lon + east / (111319.49 * Math.cos((CENTER.lat * Math.PI) / 180));
  return { lat, lon };
}

/** lat/lon -> global web-mercator pixel coords at a zoom (256px tiles). */
function latLonToMercPx(lat, lon, z) {
  const n = 2 ** z * 256;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

/** lat/lon -> UTM zone 55S easting/northing (EPSG:32755), for Sentinel-2. */
function latLonToUtm55S(lat, lon) {
  const a = 6378137,
    f = 1 / 298.257223563;
  const k0 = 0.9996,
    e2 = f * (2 - f),
    ep2 = e2 / (1 - e2);
  const lam0 = ((55 - 1) * 6 - 180 + 3) * (Math.PI / 180);
  const phi = (lat * Math.PI) / 180,
    lam = (lon * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2,
    C = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lam - lam0);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) *
        Math.sin(2 * phi) +
      ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const easting =
    k0 *
      N *
      (A +
        ((1 - T + C) * A ** 3) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) +
    500000;
  const northing =
    k0 *
      (M +
        N *
          Math.tan(phi) *
          ((A * A) / 2 +
            ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
            ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720)) +
    10000000;
  return { easting, northing };
}

// ------------------------------------------------------------- fetching

async function fetchBuf(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
}

// ------------------------------------------- elevation (terrarium tiles)

async function buildElevationSampler() {
  const half = SIZE_M / 2 + 400; // pad so bilinear never falls off the edge
  const sw = metersToLatLon(-half, -half);
  const ne = metersToLatLon(half, half);
  const pMin = latLonToMercPx(ne.lat, sw.lon, TERRAIN_ZOOM); // top-left
  const pMax = latLonToMercPx(sw.lat, ne.lon, TERRAIN_ZOOM); // bottom-right
  const tx0 = Math.floor(pMin.x / 256),
    ty0 = Math.floor(pMin.y / 256);
  const tx1 = Math.floor(pMax.x / 256),
    ty1 = Math.floor(pMax.y / 256);
  const tw = tx1 - tx0 + 1,
    th = ty1 - ty0 + 1;
  console.log(`elevation: fetching ${tw}x${th} terrarium tiles @z${TERRAIN_ZOOM}`);

  const stitched = new Float32Array(tw * 256 * th * 256);
  const stitchedW = tw * 256;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        fetchBuf(`${TERRARIUM_BASE}${TERRAIN_ZOOM}/${tx}/${ty}.png`).then(
          (buf) => {
            const png = PNG.sync.read(buf);
            const ox = (tx - tx0) * 256,
              oy = (ty - ty0) * 256;
            for (let y = 0; y < 256; y++) {
              for (let x = 0; x < 256; x++) {
                const i = (y * 256 + x) * 4;
                const h =
                  png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 -
                  32768;
                stitched[(oy + y) * stitchedW + ox + x] = h;
              }
            }
          }
        )
      );
    }
  }
  await Promise.all(jobs);

  return (east, north) => {
    const { lat, lon } = metersToLatLon(east, north);
    const p = latLonToMercPx(lat, lon, TERRAIN_ZOOM);
    const fx = p.x - tx0 * 256,
      fy = p.y - ty0 * 256;
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy);
    const dx = fx - x0,
      dy = fy - y0;
    const s = (x, y) => stitched[y * stitchedW + x];
    return (
      s(x0, y0) * (1 - dx) * (1 - dy) +
      s(x0 + 1, y0) * dx * (1 - dy) +
      s(x0, y0 + 1) * (1 - dx) * dy +
      s(x0 + 1, y0 + 1) * dx * dy
    );
  };
}

// ------------------------------------- heightmap + synthetic bathymetry

function buildHeightField(sampleElevation) {
  const R = HEIGHT_RES;
  const px = SIZE_M / R;
  const height = new Float32Array(R * R);

  // Raw land elevation. Row 0 = north edge.
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) {
      const east = (i / (R - 1) - 0.5) * SIZE_M;
      const north = (0.5 - j / (R - 1)) * SIZE_M;
      height[j * R + i] = sampleElevation(east, north);
    }
  }

  // Light 3x3 blur to soften terrarium quantization steps.
  const blurred = new Float32Array(R * R);
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) {
      let sum = 0,
        cnt = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const jj = j + dj,
            ii = i + di;
          if (jj < 0 || jj >= R || ii < 0 || ii >= R) continue;
          sum += height[jj * R + ii];
          cnt++;
        }
      }
      blurred[j * R + i] = sum / cnt;
    }
  }

  // Terrarium + resampling smooths the Bells cliff amphitheatre into
  // ramps. Steepen real relief back with an unsharp mask (feathered in
  // above the waterline so the coastline itself doesn't move), plus a
  // mild presentation-only relief emphasis so the cliffs read from a
  // camera 1.5 m off the water.
  {
    const wide = new Float32Array(blurred);
    const tmp = new Float32Array(R * R);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < R; j++) {
        for (let i = 0; i < R; i++) {
          let sum = 0,
            cnt = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const jj = j + dj,
                ii = i + di;
              if (jj < 0 || jj >= R || ii < 0 || ii >= R) continue;
              sum += wide[jj * R + ii];
              cnt++;
            }
          }
          tmp[j * R + i] = sum / cnt;
        }
      }
      wide.set(tmp);
    }
    const smoothstep = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    for (let k = 0; k < R * R; k++) {
      const h = blurred[k];
      if (h <= 1.5) continue;
      const sharp = h + 1.4 * (h - wide[k]);
      let v = h + (sharp - h) * smoothstep(1.5, 4, h);
      v *= 1 + 0.35 * smoothstep(3, 8, v);
      blurred[k] = Math.max(v, 0.6);
    }
  }

  // Land mask. Terrarium's coastal zone is littered with phantom islands
  // (data noise), so keep only land connected to the map border — the real
  // mainland — and dissolve the rest into the sea before any distance math.
  const land = new Uint8Array(R * R);
  for (let k = 0; k < R * R; k++) land[k] = blurred[k] > 0.5 ? 1 : 0;
  {
    const mainland = new Uint8Array(R * R);
    const stack = [];
    for (let i = 0; i < R; i++) {
      for (const k of [i, (R - 1) * R + i, i * R, i * R + R - 1]) {
        if (land[k] && !mainland[k]) {
          mainland[k] = 1;
          stack.push(k);
        }
      }
    }
    while (stack.length) {
      const k = stack.pop();
      const i = k % R,
        j = (k - i) / R;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di,
            jj = j + dj;
          if (ii < 0 || ii >= R || jj < 0 || jj >= R) continue;
          const kk = jj * R + ii;
          if (land[kk] && !mainland[kk]) {
            mainland[kk] = 1;
            stack.push(kk);
          }
        }
      }
    }
    let dissolved = 0;
    for (let k = 0; k < R * R; k++) {
      if (land[k] && !mainland[k]) {
        land[k] = 0;
        dissolved++;
      }
    }
    console.log(`bathymetry: dissolved ${dissolved} phantom-island pixels`);
  }
  const INF = 1e9;
  // Seed the distance transform only from substantial land (>3 m): the
  // strings of low offshore rock platforms would otherwise keep the whole
  // nearshore zone artificially shallow.
  const dist = new Float32Array(R * R);
  for (let k = 0; k < R * R; k++)
    dist[k] = land[k] && blurred[k] > 3 ? 0 : INF;
  const D1 = px,
    D2 = px * Math.SQRT2;
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) {
      const k = j * R + i;
      if (i > 0) dist[k] = Math.min(dist[k], dist[k - 1] + D1);
      if (j > 0) dist[k] = Math.min(dist[k], dist[k - R] + D1);
      if (i > 0 && j > 0) dist[k] = Math.min(dist[k], dist[k - R - 1] + D2);
      if (i < R - 1 && j > 0) dist[k] = Math.min(dist[k], dist[k - R + 1] + D2);
    }
  }
  for (let j = R - 1; j >= 0; j--) {
    for (let i = R - 1; i >= 0; i--) {
      const k = j * R + i;
      if (i < R - 1) dist[k] = Math.min(dist[k], dist[k + 1] + D1);
      if (j < R - 1) dist[k] = Math.min(dist[k], dist[k + R] + D1);
      if (i < R - 1 && j < R - 1)
        dist[k] = Math.min(dist[k], dist[k + R + 1] + D2);
      if (i > 0 && j < R - 1) dist[k] = Math.min(dist[k], dist[k + R - 1] + D2);
    }
  }

  // Locate the waterline nearest the scene center (the Bells cove beach) and
  // the local offshore direction, straight from the elevation data — guessed
  // lat/lons proved unreliable at beach scale.
  const toMeters = (i, j) => ({
    east: (i / (R - 1) - 0.5) * SIZE_M,
    north: (0.5 - j / (R - 1)) * SIZE_M,
  });
  // Waterline = ocean pixel with a land neighbor (independent of the
  // tall-land distance field, which ignores the beach).
  let shore = null,
    shoreD2 = Infinity;
  for (let j = 1; j < R - 1; j++) {
    for (let i = 1; i < R - 1; i++) {
      const k = j * R + i;
      if (land[k]) continue;
      if (!(land[k - 1] || land[k + 1] || land[k - R] || land[k + R])) continue;
      const p = toMeters(i, j);
      const d2 = p.east * p.east + p.north * p.north;
      if (d2 < shoreD2) {
        shoreD2 = d2;
        shore = p;
      }
    }
  }
  if (!shore) throw new Error("no shoreline found near scene center");
  // Offshore direction: mean direction from the shore point to nearby ocean
  // pixels, weighted by their distance-to-shore.
  let ue = 0,
    un = 0;
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) {
      const k = j * R + i;
      if (land[k]) continue;
      const p = toMeters(i, j);
      const re = p.east - shore.east,
        rn = p.north - shore.north;
      const r2 = re * re + rn * rn;
      if (r2 > 450 * 450 || r2 < 1) continue;
      const w = dist[k] / Math.sqrt(r2);
      ue += re * w;
      un += rn * w;
    }
  }
  const ul = Math.hypot(ue, un);
  ue /= ul;
  un /= ul;
  console.log(
    `bathymetry: shore anchor E${shore.east.toFixed(0)} N${shore.north.toFixed(0)}, ` +
      `offshore dir (${ue.toFixed(2)}, ${un.toFixed(2)})`
  );

  // The Bells reef: a shallow finger running offshore from just SW of the
  // cove, so swell shoals there first and peels toward the NE channel —
  // rights, the way Bells breaks. Rotate the finger axis a touch SW of
  // straight-offshore; put the deeper escape channel on the NE side.
  const rot = (-22 * Math.PI) / 180; // rotate offshore dir 22° toward SW
  const rdx = ue * Math.cos(rot) - un * Math.sin(rot);
  const rdy = ue * Math.sin(rot) + un * Math.cos(rot);
  // Perpendicular pointing to the NE side of the finger.
  let pe = -rdy,
    pn = rdx;
  if (pe + pn < 0) {
    pe = -pe;
    pn = -pn;
  }
  const reefShore = {
    east: shore.east - pe * 120 + rdx * 40,
    north: shore.north - pn * 120 + rdy * 40,
  };
  const reefLen = 520; // finger length, m
  const reefWidth = 170; // gaussian half-width across the finger, m
  const chanShore = {
    east: shore.east + pe * 210 + rdx * 40,
    north: shore.north + pn * 210 + rdy * 40,
  };
  const chanLen = 420,
    chanWidth = 110;

  // Distance from substantial (>4 m) land, to separate the real rock shelf
  // at the cliff bases from terrarium's phantom offshore islands.
  const tall = new Float32Array(R * R);
  for (let k = 0; k < R * R; k++)
    tall[k] = land[k] && blurred[k] > 4 ? 0 : INF;
  for (let j = 0; j < R; j++)
    for (let i = 0; i < R; i++) {
      const k = j * R + i;
      if (i > 0) tall[k] = Math.min(tall[k], tall[k - 1] + D1);
      if (j > 0) tall[k] = Math.min(tall[k], tall[k - R] + D1);
    }
  for (let j = R - 1; j >= 0; j--)
    for (let i = R - 1; i >= 0; i--) {
      const k = j * R + i;
      if (i < R - 1) tall[k] = Math.min(tall[k], tall[k + 1] + D1);
      if (j < R - 1) tall[k] = Math.min(tall[k], tall[k + R] + D1);
    }

  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) {
      const k = j * R + i;
      // Keep real land, and the awash rock shelf hugging the cliffs; the
      // "islands" far from any substantial land are elevation-data noise —
      // dissolve them into the seabed.
      if (land[k] && tall[k] <= 90) {
        blurred[k] = Math.min(blurred[k], 0.6);
        continue;
      }
      if (land[k] && tall[k] > 90) {
        // fall through: treat as ocean
      } else if (land[k]) continue;
      const east = (i / (R - 1) - 0.5) * SIZE_M;
      const north = (0.5 - j / (R - 1)) * SIZE_M;
      // Distance is measured from the 3 m contour; ~55 m of that is beach.
      const d = Math.max(0, dist[k] - 55);

      // Base shelf profile: beach slope, then a gradual shelf to deep water.
      let depth;
      if (d < 60) depth = 0.4 + d * 0.05; // inner sandbar, ~3.4 m at 60 m out
      else if (d < 600) depth = 3.4 + (d - 60) * 0.022; // reef shelf, ~15.3 m
      else depth = 15.3 + (d - 600) * 0.028; // drops toward open water

      // Reef finger: pull the seabed up along the finger axis.
      depth -= ridgeLift(east, north, reefShore, rdx, rdy, reefLen, reefWidth, 3.2);
      // Channel: push it down.
      depth += ridgeLift(east, north, chanShore, rdx, rdy, chanLen, chanWidth, 3.0);

      depth = Math.max(0.25, Math.min(60, depth));
      blurred[k] = -depth;
    }
  }

  // Lineup: walk out along the reef axis (over the finished bathymetry)
  // until the takeoff zone is ~5 m deep, then sit a touch toward the
  // channel — outside the impact zone, looking back at the peak.
  const depthAtMeters = (e, nn) => {
    const i = Math.round((e / SIZE_M + 0.5) * (R - 1));
    const j = Math.round((0.5 - nn / SIZE_M) * (R - 1));
    if (i < 0 || i >= R || j < 0 || j >= R) return 999;
    return -blurred[j * R + i];
  };
  let lineupAlong = 400;
  for (let t = 150; t <= 900; t += 10) {
    const d = depthAtMeters(
      reefShore.east + rdx * t + pe * 110,
      reefShore.north + rdy * t + pn * 110
    );
    if (d >= 4.1) {
      lineupAlong = t;
      break;
    }
  }
  const lineup = {
    east: reefShore.east + rdx * lineupAlong + pe * 110,
    north: reefShore.north + rdy * lineupAlong + pn * 110,
  };
  console.log(
    `bathymetry: lineup ${lineupAlong}m along reef, depth ` +
      depthAtMeters(lineup.east, lineup.north).toFixed(1) + "m"
  );

  return {
    height: blurred,
    placement: {
      shore,
      offshoreDir: { east: ue, north: un },
      reefShore,
      reefDir: { east: rdx, north: rdy },
      reefLen,
      lineup,
    },
  };

  function ridgeLift(east, north, shore, dx, dy, len, width, amp) {
    const relE = east - shore.east,
      relN = north - shore.north;
    const along = relE * dx + relN * dy; // distance along the finger
    const across = -relE * dy + relN * dx; // signed distance across it
    if (along < -80) return 0;
    const tail = Math.max(0, along - len);
    const alongFade = Math.exp(-(tail * tail) / (2 * 220 * 220));
    const headFade = along < 0 ? Math.exp(-(along * along) / (2 * 90 ** 2)) : 1;
    const acrossFade = Math.exp(-(across * across) / (2 * width * width));
    return amp * alongFade * headFade * acrossFade;
  }
}

/** Terrarium-style RGB encode: h = R*256 + G + B/256 - 32768. */
function writeHeightmapPng(height) {
  const R = HEIGHT_RES;
  const png = new PNG({ width: R, height: R, colorType: 2 });
  for (let k = 0; k < R * R; k++) {
    const v = Math.max(0, Math.min(65535.996, height[k] + 32768));
    const r = Math.floor(v / 256);
    const g = Math.floor(v) % 256;
    const b = Math.floor((v - Math.floor(v)) * 256);
    png.data[k * 4] = r;
    png.data[k * 4 + 1] = g;
    png.data[k * 4 + 2] = b;
    png.data[k * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ------------------------------------------------- satellite (Sentinel-2)

async function buildSatellite(heightField) {
  const url = `${S2_BASE}${S2_SCENE}/TCI.tif`;
  console.log("satellite: opening COG", url);
  const tiff = await fromUrl(url);
  const image = await tiff.getImage(); // full-res 10m level
  const [originE, originN] = [image.getOrigin()[0], image.getOrigin()[1]];
  const [resE, resN] = image.getResolution(); // resN is negative
  const half = SIZE_M / 2 + 100;

  // Our box corners in UTM 55S -> pixel window in the COG.
  const corners = [
    metersToLatLon(-half, -half),
    metersToLatLon(half, -half),
    metersToLatLon(-half, half),
    metersToLatLon(half, half),
  ].map((c) => latLonToUtm55S(c.lat, c.lon));
  const xs = corners.map((c) => (c.easting - originE) / resE);
  const ys = corners.map((c) => (c.northing - originN) / resN);
  const win = [
    Math.max(0, Math.floor(Math.min(...xs)) - 2),
    Math.max(0, Math.floor(Math.min(...ys)) - 2),
    Math.ceil(Math.max(...xs)) + 2,
    Math.ceil(Math.max(...ys)) + 2,
  ];
  console.log("satellite: reading window", win);
  const raster = await image.readRasters({ window: win, interleave: true });
  const winW = win[2] - win[0],
    winH = win[3] - win[1];

  // Resample the UTM-aligned window onto our local north-up meter grid.
  const out = Buffer.alloc(SAT_RES * SAT_RES * 3);
  for (let j = 0; j < SAT_RES; j++) {
    for (let i = 0; i < SAT_RES; i++) {
      const east = (i / (SAT_RES - 1) - 0.5) * SIZE_M;
      const north = (0.5 - j / (SAT_RES - 1)) * SIZE_M;
      const { lat, lon } = metersToLatLon(east, north);
      const utm = latLonToUtm55S(lat, lon);
      const fx = (utm.easting - originE) / resE - win[0];
      const fy = (utm.northing - originN) / resN - win[1];
      const x0 = Math.max(0, Math.min(winW - 2, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(winH - 2, Math.floor(fy)));
      const dx = Math.max(0, Math.min(1, fx - x0));
      const dy = Math.max(0, Math.min(1, fy - y0));
      for (let c = 0; c < 3; c++) {
        const s = (x, y) => raster[(y * winW + x) * 3 + c];
        out[(j * SAT_RES + i) * 3 + c] =
          s(x0, y0) * (1 - dx) * (1 - dy) +
          s(x0 + 1, y0) * dx * (1 - dy) +
          s(x0, y0 + 1) * (1 - dx) * dy +
          s(x0 + 1, y0 + 1) * dx * dy;
      }
    }
  }

  // Nadir imagery has no real texels for near-vertical cliff faces — they
  // get draped with waterline surf pixels and render white. Recolor steep
  // land toward the marl rock of the Bells cliffs, keeping some of the
  // image's own luminance for variation.
  const R = HEIGHT_RES;
  const hfAt = (e, nn) => {
    const fi = Math.max(0, Math.min(R - 1.001, (e / SIZE_M + 0.5) * (R - 1)));
    const fj = Math.max(0, Math.min(R - 1.001, (0.5 - nn / SIZE_M) * (R - 1)));
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    const di = fi - i0, dj = fj - j0;
    return (
      heightField[j0 * R + i0] * (1 - di) * (1 - dj) +
      heightField[j0 * R + i0 + 1] * di * (1 - dj) +
      heightField[(j0 + 1) * R + i0] * (1 - di) * dj +
      heightField[(j0 + 1) * R + i0 + 1] * di * dj
    );
  };
  const stepM = 6;
  for (let j = 0; j < SAT_RES; j++) {
    for (let i = 0; i < SAT_RES; i++) {
      const east = (i / (SAT_RES - 1) - 0.5) * SIZE_M;
      const north = (0.5 - j / (SAT_RES - 1)) * SIZE_M;
      const h = hfAt(east, north);
      if (h < 0.5) continue;
      const gx = (hfAt(east + stepM, north) - hfAt(east - stepM, north)) / (2 * stepM);
      const gy = (hfAt(east, north + stepM) - hfAt(east, north - stepM)) / (2 * stepM);
      const slope = Math.hypot(gx, gy);
      const f = Math.min(1, Math.max(0, (slope - 0.5) / 0.6));
      if (f <= 0) continue;
      const k = (j * SAT_RES + i) * 3;
      const lum = (out[k] * 0.3 + out[k + 1] * 0.6 + out[k + 2] * 0.1) / 255;
      const shade = 0.78 + 0.55 * lum;
      const rock = [172 * shade, 128 * shade, 86 * shade];
      out[k] = out[k] * (1 - f) + rock[0] * f;
      out[k + 1] = out[k + 1] * (1 - f) + rock[1] * f;
      out[k + 2] = out[k + 2] * (1 - f) + rock[2] * f;
    }
  }

  // Mild sharpen + saturation lift: Sentinel-2 TCI reads a touch flat.
  return sharp(out, { raw: { width: SAT_RES, height: SAT_RES, channels: 3 } })
    .sharpen({ sigma: 1.2, m1: 0.6, m2: 0.2 })
    .modulate({ saturation: 1.15, brightness: 1.05 })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

// ------------------------------------------- procedural water textures

/** Tileable value-noise fbm in [0,1]. */
function makeFbm(size, cells0, octaves, seed) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const octaveLattices = [];
  for (let o = 0; o < octaves; o++) {
    const cells = cells0 * 2 ** o;
    const lat = new Float32Array(cells * cells);
    for (let k = 0; k < cells * cells; k++) lat[k] = rand();
    octaveLattices.push({ cells, lat });
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  return (u, v) => {
    let sum = 0,
      ampSum = 0,
      amp = 1;
    for (const { cells, lat } of octaveLattices) {
      const x = u * cells,
        y = v * cells;
      const x0 = Math.floor(x) % cells,
        y0 = Math.floor(y) % cells;
      const x1 = (x0 + 1) % cells,
        y1 = (y0 + 1) % cells;
      const dx = smooth(x - Math.floor(x)),
        dy = smooth(y - Math.floor(y));
      const val =
        lat[y0 * cells + x0] * (1 - dx) * (1 - dy) +
        lat[y0 * cells + x1] * dx * (1 - dy) +
        lat[y1 * cells + x0] * (1 - dx) * dy +
        lat[y1 * cells + x1] * dx * dy;
      sum += val * amp;
      ampSum += amp;
      amp *= 0.55;
    }
    return sum / ampSum;
  };
}

function makeFoamPng(size = 256) {
  const fbm = makeFbm(size, 6, 5, 1337);
  const png = new PNG({ width: size, height: size, colorType: 6 });
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const n = fbm(i / size, j / size);
      // Streaky foam: threshold + soft blobs.
      const blob = Math.max(0, (n - 0.5) / 0.5);
      const v = Math.min(1, blob * 1.9) ** 1.6;
      const k = (j * size + i) * 4;
      const c = 200 + Math.round(v * 55);
      png.data[k] = c;
      png.data[k + 1] = c;
      png.data[k + 2] = c;
      png.data[k + 3] = Math.round(v * 255);
    }
  }
  return PNG.sync.write(png);
}

function makeNoiseNormalPng(size = 256) {
  const fbm = makeFbm(size, 5, 5, 4242);
  const h = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) h[j * size + i] = fbm(i / size, j / size);
  const png = new PNG({ width: size, height: size, colorType: 6 });
  const amp = 2.6;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const l = h[j * size + ((i - 1 + size) % size)];
      const r = h[j * size + ((i + 1) % size)];
      const u = h[((j - 1 + size) % size) * size + i];
      const d = h[((j + 1) % size) * size + i];
      let nx = (l - r) * amp,
        ny = (u - d) * amp,
        nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const k = (j * size + i) * 4;
      png.data[k] = Math.round((nx * 0.5 + 0.5) * 255);
      png.data[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      png.data[k + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      png.data[k + 3] = Math.round(h[j * size + i] * 255); // fbm in alpha
    }
  }
  return PNG.sync.write(png);
}

// ----------------------------------------------------------------- main

const t0 = Date.now();
await mkdir(OUT_DIR, { recursive: true });

const sampleElevation = await buildElevationSampler();
console.log("heightmap: building field + bathymetry");
const { height: heightField, placement } = buildHeightField(sampleElevation);
await writeFile(new URL("heightmap.png", OUT_DIR), writeHeightmapPng(heightField));

const satJpg = await buildSatellite(heightField);
await writeFile(new URL("satellite.jpg", OUT_DIR), satJpg);

console.log("textures: foam + noise");
await writeFile(new URL("foam.png", OUT_DIR), makeFoamPng());
await writeFile(new URL("noise.png", OUT_DIR), makeNoiseNormalPng());

await writeFile(
  new URL("assets.json", OUT_DIR),
  JSON.stringify(
    {
      center: CENTER,
      sizeMeters: SIZE_M,
      heightmapResolution: HEIGHT_RES,
      heightEncoding: "terrarium (h = R*256 + G + B/256 - 32768, meters)",
      // Local-meter coordinates (east/north from center) derived from the
      // real shoreline: where the reef sits and where the camera floats.
      placement,
      satelliteScene: S2_SCENE,
      attribution: {
        elevation:
          "Terrain Tiles (Mapzen/AWS Open Data) — SRTM, GA Australia et al.",
        imagery:
          "Contains modified Copernicus Sentinel data 2024, processed by ESA / Element 84 (AWS Open Data)",
      },
      bakedAt: new Date().toISOString(),
    },
    null,
    2
  )
);

console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
