/**
 * Unified touch/tilt game input, layered on top of the camera's look
 * controls (which keep their own listeners):
 *  - holding: any active pointer on the canvas (hold-to-paddle)
 *  - steer:   -1..1 — device roll (gamma) when tilt is granted, else the
 *             pointer's horizontal position relative to screen center
 *  - trim:    -1..1 — pointer's vertical position (up = climb the face)
 */
export interface GameControls {
  holding(): boolean;
  steer(): number;
  trim(): number;
  /** Start listening to device orientation (same grant as camera tilt). */
  enableTilt(): void;
}

export function createGameControls(dom: HTMLElement): GameControls {
  let pointerDown = false;
  let px = 0.5;
  let py = 0.5;
  let tiltSteer = 0;
  let tiltOn = false;

  const updatePos = (e: PointerEvent) => {
    px = e.clientX / window.innerWidth;
    py = e.clientY / window.innerHeight;
  };
  dom.addEventListener("pointerdown", (e) => {
    pointerDown = true;
    updatePos(e);
  });
  dom.addEventListener("pointermove", (e) => {
    if (pointerDown) updatePos(e);
  });
  const up = () => {
    pointerDown = false;
    px = 0.5;
    py = 0.5;
  };
  dom.addEventListener("pointerup", up);
  dom.addEventListener("pointercancel", up);

  // Desktop testing: arrow keys steer/trim, space paddles.
  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => keys.add(e.key));
  window.addEventListener("keyup", (e) => keys.delete(e.key));

  function onOrientation(e: DeviceOrientationEvent) {
    if (e.gamma === null) return;
    // Portrait: gamma is the left/right lean of the phone.
    tiltSteer = Math.max(-1, Math.min(1, e.gamma / 24));
  }

  return {
    holding: () => pointerDown || keys.has(" "),
    steer() {
      if (keys.has("ArrowLeft") || keys.has("a")) return -1;
      if (keys.has("ArrowRight") || keys.has("d")) return 1;
      if (tiltOn && Math.abs(tiltSteer) > 0.06) return tiltSteer;
      if (!pointerDown) return 0;
      return Math.max(-1, Math.min(1, (px - 0.5) * 3));
    },
    trim() {
      if (keys.has("ArrowUp") || keys.has("w")) return 1;
      if (keys.has("ArrowDown") || keys.has("s")) return -1;
      if (!pointerDown) return 0;
      return Math.max(-1, Math.min(1, (0.5 - py) * 3));
    },
    enableTilt() {
      if (tiltOn) return;
      tiltOn = true;
      window.addEventListener("deviceorientation", onOrientation);
    },
  };
}
