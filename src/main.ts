import * as THREE from "three";
import { loadAssets } from "./assets";
import { QUALITY, eastNorthToWorld, makeWaves } from "./config";
import { createLineupCamera } from "./camera/lineupCamera";
import { createGameControls } from "./game/controls";
import { createFollowCamera } from "./game/followCamera";
import { Player } from "./game/player";
import { createSurfer } from "./game/surfer";
import { createOcean } from "./ocean/ocean";
import { SetScheduler } from "./ocean/sets";
import { createSky } from "./scene/sky";
import { createTerrain } from "./scene/terrain";
import { createHud } from "./ui/hud";

declare global {
  interface Window {
    __surfsim?: {
      ready: boolean;
      frames: number;
      avgFrameMs: number;
      state?: string;
      camY?: number;
      waveY?: number;
      gain?: number;
      px?: number;
      pz?: number;
    };
  }
}

async function boot() {
  const params = new URLSearchParams(location.search);
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
  if (!params.get("noocean")) scene.add(ocean.mesh);

  // The lineup, and the peak the sitting camera faces (mid reef crest with
  // the Bells cliffs rising behind it).
  const lineupWorld = eastNorthToWorld(
    placement.lineup.east,
    placement.lineup.north
  );
  const peak = eastNorthToWorld(
    placement.reefShore.east + placement.reefDir.east * 140,
    placement.reefShore.north + placement.reefDir.north * 140
  );
  const initialYaw = Math.atan2(
    -(peak.x - lineupWorld.x),
    -(peak.z - lineupWorld.z)
  );

  // ?fly=NN hoists the camera NN meters for a debug overview.
  const fly = Number(params.get("fly") ?? "0") || 0;
  const rigPos = new THREE.Vector3(lineupWorld.x, fly, lineupWorld.z);
  const rig = createLineupCamera(renderer.domElement, rigPos, initialYaw);
  const followCam = createFollowCamera();
  rig.resize(window.innerWidth, window.innerHeight);
  followCam.resize(window.innerWidth, window.innerHeight);

  // --- game ----------------------------------------------------------
  const controls = createGameControls(renderer.domElement);
  const surfer = createSurfer();
  scene.add(surfer.group);

  const player = new Player(
    ocean,
    controls,
    lineupWorld,
    initialYaw,
    {
      onStateChange(state) {
        if (state === "catching")
          followCam.snapTo(rig.camera.position, rig.camera.quaternion);
      },
      onWipeout: () => hud.wipeoutFlash(),
      onRideEnd: (stats) => {
        if (stats.time > 1.5) hud.showScore(stats.score, stats.time);
        hud.setRide(null);
      },
    },
    { autocatch: Boolean(params.get("autocatch")) }
  );

  if ("ontouchstart" in window && "DeviceOrientationEvent" in window) {
    hud.showTiltButton(async () => {
      const ok = await rig.enableTilt();
      if (ok) controls.enableTilt();
      return ok;
    });
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
    followCam.resize(window.innerWidth, window.innerHeight);
  });

  // ?t0=NN starts the simulation clock at NN seconds (handy for jumping
  // straight to a set when testing).
  const t0 = Number(params.get("t0") ?? "0") || 0;
  const sets = new SetScheduler(0);
  const timer = new THREE.Timer();
  const stats: NonNullable<Window["__surfsim"]> = {
    ready: true,
    frames: 0,
    avgFrameMs: 0,
  };
  window.__surfsim = stats;
  let frameMsAccum = 0;
  let promptShown = "";
  const fwd2 = new THREE.Vector2();

  // Simulation time accumulates the clamped dt so wave phase and player
  // physics never desync when frames run long (slow-mo instead of drift).
  let simT = t0;
  renderer.setAnimationLoop(() => {
    const start = performance.now();
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    simT += dt;
    const t = simT;

    const gain = sets.gain(t);
    hud.setSetIncoming(sets.setIncoming(t));
    ocean.update(t, gain);

    player.update(dt, t, gain, rig.getYaw());
    const s = player.sample;

    // First person while sitting/paddling; chase cam once you're on a wave.
    const thirdPerson =
      player.state === "catching" ||
      player.state === "riding" ||
      player.state === "wipeout";

    rigPos.set(player.pos.x, fly, player.pos.z);
    const waveYAhead = ocean.waveHeightAt(
      player.pos.x - waves[0].dirX * 7,
      player.pos.z - waves[0].dirZ * 7,
      t,
      gain
    );
    rig.update(dt, player.pos.y, waveYAhead);

    player.forward(fwd2);
    const slopePitch = THREE.MathUtils.clamp(
      Math.atan(s.slopeX * fwd2.x + s.slopeZ * fwd2.y) * 0.7,
      -0.5,
      0.5
    );
    surfer.update(
      player.pos,
      player.heading,
      player.popup,
      player.steerLean,
      slopePitch,
      thirdPerson
    );
    if (thirdPerson)
      followCam.update(dt, player.pos, player.heading, player.steerLean);

    const camera = thirdPerson ? followCam.camera : rig.camera;
    (ocean.material.uniforms.uCamPos.value as THREE.Vector3).copy(
      camera.position
    );

    // Prompts + ride chip.
    let prompt = "";
    if (player.state === "sitting") prompt = "HOLD TO PADDLE";
    else if (player.state === "riding" && player.popup < 1) prompt = "UP!";
    if (prompt !== promptShown) {
      hud.setPrompt(prompt || null);
      promptShown = prompt;
    }
    hud.setRide(
      player.state === "riding"
        ? { speed: player.ride.speed, time: player.ride.time }
        : null
    );

    renderer.render(scene, camera);

    stats.state = player.state;
    stats.px = player.pos.x;
    stats.pz = player.pos.z;
    stats.camY = camera.position.y;
    stats.waveY = player.pos.y;
    stats.gain = gain;
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
