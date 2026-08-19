import * as THREE from "three";
import { loadAssets } from "./assets";
import { QUALITY, eastNorthToWorld, makeWaves } from "./config";
import { createLineupCamera } from "./camera/lineupCamera";
import { createOcean } from "./ocean/ocean";
import { SetScheduler } from "./ocean/sets";
import { createSky } from "./scene/sky";
import { createTerrain } from "./scene/terrain";
import { createHud } from "./ui/hud";

declare global {
  interface Window {
    __surfsim?: { ready: boolean; frames: number; avgFrameMs: number };
  }
}

async function boot() {
  const app = document.getElementById("app")!;
  const hud = createHud(
    "Imagery: Copernicus Sentinel-2 (ESA) via AWS Open Data · " +
      "Elevation: Terrain Tiles (Mapzen/AWS)"
  );

  const assets = await loadAssets((f, m) => hud.setLoading(f, m));
  const placement = assets.meta.placement;
  const waves = makeWaves(placement);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  let tier = QUALITY.high;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const skyRig = createSky(scene);
  scene.add(createTerrain(assets, tier.terrainSegments));

  const ocean = createOcean(
    assets,
    waves,
    skyRig.sunDir,
    skyRig.fogColor,
    tier.oceanSegments
  );
  if (!new URLSearchParams(location.search).get("noocean"))
    scene.add(ocean.mesh);

  // Camera floats at the lineup, initially facing the peak where the wave
  // stands up on the reef.
  const lineupWorld = eastNorthToWorld(
    placement.lineup.east,
    placement.lineup.north
  );
  // Aim at the mid reef crest — the peak where sets stand up and peel,
  // with the Bells cliffs rising behind it.
  const peak = eastNorthToWorld(
    placement.reefShore.east + placement.reefDir.east * 140,
    placement.reefShore.north + placement.reefDir.north * 140
  );
  const initialYaw = Math.atan2(
    -(peak.x - lineupWorld.x),
    -(peak.z - lineupWorld.z)
  );
  // ?fly=NN hoists the camera NN meters for a debug overview.
  const fly =
    Number(new URLSearchParams(location.search).get("fly") ?? "0") || 0;
  const rig = createLineupCamera(
    renderer.domElement,
    new THREE.Vector3(lineupWorld.x, fly, lineupWorld.z),
    initialYaw
  );
  rig.resize(window.innerWidth, window.innerHeight);

  if ("ontouchstart" in window && "DeviceOrientationEvent" in window) {
    hud.showTiltButton(() => rig.enableTilt());
  }

  hud.onQualityToggle((high) => {
    tier = high ? QUALITY.high : QUALITY.low;
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, tier.pixelRatioCap)
    );
    renderer.setSize(window.innerWidth, window.innerHeight);
    ocean.rebuildGeometry(tier.oceanSegments);
  });

  window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    rig.resize(window.innerWidth, window.innerHeight);
  });

  // ?t0=NN starts the simulation clock at NN seconds (handy for jumping
  // straight to a set when testing).
  const t0 = Number(new URLSearchParams(location.search).get("t0") ?? "0") || 0;
  const sets = new SetScheduler(0);
  const timer = new THREE.Timer();
  const stats = { ready: true, frames: 0, avgFrameMs: 0 };
  window.__surfsim = stats;
  let frameMsAccum = 0;

  // Sample the swell slightly up-wave of the camera for the pitch sway.
  const aheadX = lineupWorld.x - waves[0].dirX * 7;
  const aheadZ = lineupWorld.z - waves[0].dirZ * 7;

  renderer.setAnimationLoop(() => {
    const start = performance.now();
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const t = timer.getElapsed() + t0;

    const gain = sets.gain(t);
    hud.setSetIncoming(sets.setIncoming(t));
    ocean.update(t, gain);

    const waveY = ocean.waveHeightAt(lineupWorld.x, lineupWorld.z, t, gain);
    const waveYAhead = ocean.waveHeightAt(aheadX, aheadZ, t, gain);
    rig.update(dt, waveY, waveYAhead);
    (ocean.material.uniforms.uCamPos.value as THREE.Vector3).copy(
      rig.camera.position
    );

    renderer.render(scene, rig.camera);

    frameMsAccum += performance.now() - start;
    stats.frames++;
    if (stats.frames % 60 === 0) {
      stats.avgFrameMs = frameMsAccum / 60;
      frameMsAccum = 0;
    }
  });

  hud.finishLoading();
}

boot().catch((err) => {
  const msg = document.getElementById("loading-msg");
  if (msg) msg.textContent = `Something went wrong: ${err}`;
  console.error(err);
});
