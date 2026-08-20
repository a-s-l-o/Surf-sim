import * as THREE from "three";
import { EYE_HEIGHT } from "../config";

export interface LineupCamera {
  camera: THREE.PerspectiveCamera;
  /** Call each frame with the wave height under the camera. */
  update(dt: number, waveY: number, waveYAhead: number): void;
  resize(width: number, height: number): void;
  /** Try to enable device-orientation look (needs a user gesture on iOS). */
  enableTilt(): Promise<boolean>;
  tiltActive(): boolean;
  /** Current look yaw (radians) — paddling heads this way. */
  getYaw(): number;
}

/**
 * First-person camera floating in the takeoff zone: bobs and pitches with
 * the swell it samples, looks around via drag (mouse/touch), pinch-zooms,
 * and optionally follows device orientation on mobile.
 */
export function createLineupCamera(
  dom: HTMLElement,
  position: THREE.Vector3,
  initialYaw: number
): LineupCamera {
  const camera = new THREE.PerspectiveCamera(68, 1, 0.4, 30000);
  camera.rotation.order = "YXZ";

  let yaw = initialYaw;
  let pitch = -0.04;
  let fov = 68;
  let tiltOn = false;
  let tiltYawOffset = 0;
  let tiltPitchOffset = 0;
  let tiltYawZero: number | null = null;

  // --- drag look -----------------------------------------------------
  let dragging = false;
  let lastX = 0,
    lastY = 0;
  let pinchDist = 0;

  dom.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    dom.setPointerCapture(e.pointerId);
  });
  dom.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const scale = (fov / 68) * 0.0032;
    yaw -= (e.clientX - lastX) * scale;
    pitch -= (e.clientY - lastY) * scale;
    pitch = THREE.MathUtils.clamp(pitch, -0.55, 0.42);
    lastX = e.clientX;
    lastY = e.clientY;
  });
  const endDrag = () => (dragging = false);
  dom.addEventListener("pointerup", endDrag);
  dom.addEventListener("pointercancel", endDrag);

  dom.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (pinchDist > 0) {
          fov = THREE.MathUtils.clamp(fov * (pinchDist / d), 34, 82);
          camera.fov = fov;
          camera.updateProjectionMatrix();
        }
        pinchDist = d;
      } else {
        pinchDist = 0;
      }
    },
    { passive: true }
  );
  dom.addEventListener("touchend", () => (pinchDist = 0));

  window.addEventListener("wheel", (e) => {
    fov = THREE.MathUtils.clamp(fov + e.deltaY * 0.02, 34, 82);
    camera.fov = fov;
    camera.updateProjectionMatrix();
  });

  // --- device orientation -------------------------------------------
  function onOrientation(e: DeviceOrientationEvent) {
    if (e.alpha === null || e.beta === null) return;
    const alphaRad = (e.alpha * Math.PI) / 180;
    const betaRad = (e.beta * Math.PI) / 180;
    if (tiltYawZero === null) tiltYawZero = alphaRad;
    // Holding the phone up in portrait: beta ~90° looks level.
    tiltYawOffset = alphaRad - tiltYawZero;
    tiltPitchOffset = betaRad - Math.PI / 2;
  }

  async function enableTilt(): Promise<boolean> {
    type PermissionRequester = {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    const doe = DeviceOrientationEvent as unknown as PermissionRequester;
    try {
      if (typeof doe.requestPermission === "function") {
        const answer = await doe.requestPermission();
        if (answer !== "granted") return false;
      }
      tiltYawZero = null;
      window.addEventListener("deviceorientation", onOrientation);
      tiltOn = true;
      return true;
    } catch {
      return false;
    }
  }

  // --- per-frame -----------------------------------------------------
  let smoothY = EYE_HEIGHT;
  let sway = 0;

  function update(dt: number, waveY: number, waveYAhead: number) {
    // Buoyancy: ease toward the water surface like a floating board, but
    // never let a fast-rising set face swallow the camera.
    const targetY = position.y + waveY + EYE_HEIGHT;
    const k = 1 - Math.exp(-dt * 3.2);
    smoothY += (targetY - smoothY) * k;
    smoothY = Math.max(smoothY, position.y + waveY + 0.55);
    camera.position.set(position.x, smoothY, position.z);

    // Pitch gently with the local wave slope, roll with a slow sway.
    const slopePitch = THREE.MathUtils.clamp((waveYAhead - waveY) * 0.09, -0.1, 0.1);
    sway += dt;
    const roll = Math.sin(sway * 0.6) * 0.012;

    const effYaw = yaw + (tiltOn ? tiltYawOffset : 0);
    const effPitch = THREE.MathUtils.clamp(
      pitch + (tiltOn ? tiltPitchOffset : 0) + slopePitch,
      -0.9,
      0.9
    );
    camera.rotation.set(effPitch, effYaw, roll);
  }

  return {
    camera,
    update,
    resize(width, height) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    enableTilt,
    tiltActive: () => tiltOn,
    getYaw: () => yaw + (tiltOn ? tiltYawOffset : 0),
  };
}
