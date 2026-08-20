import * as THREE from "three";
import type { Ocean, SurfaceSample } from "../ocean/ocean";
import type { GameControls } from "./controls";

export type PlayerState =
  | "sitting"
  | "paddling"
  | "catching"
  | "riding"
  | "wipeout";

export interface RideStats {
  time: number;
  speed: number;
  score: number;
}

export interface PlayerEvents {
  onStateChange?(state: PlayerState, prev: PlayerState): void;
  onWipeout?(): void;
  onRideEnd?(stats: RideStats): void;
}

const PADDLE_ACCEL = 2.6;
const PADDLE_MAX = 2.2;
const CATCH_DURATION = 1.5;
const POPUP_DURATION = 0.9;
const RIDE_MIN_SPEED = 3;
const RIDE_MAX_SPEED = 13;
const WIPEOUT_DURATION = 1.7;

/**
 * The surfer: a point mass living on the analytic water surface.
 *
 * sitting -> (hold) paddling -> (wave magnet) catching -> riding
 *   -> wipeout | flick-off -> respawn at the lineup.
 *
 * Arcade assists: the catch magnetizes the player onto the wave and matches
 * its phase speed; while riding, a gentle spring holds the board in the
 * pocket (shoreward of the flats, seaward of the whitewater) so steering is
 * about style, not survival.
 */
export class Player {
  state: PlayerState = "sitting";
  readonly pos: THREE.Vector3;
  readonly vel = new THREE.Vector2(); // xz velocity
  heading: number; // radians, world yaw of the board (0 = -z)
  steerLean = 0; // smoothed steer for visuals
  popup = 0; // 0 prone .. 1 standing
  ride: RideStats = { time: 0, speed: 0, score: 0 };

  private readonly home: THREE.Vector3;
  private readonly peelDir: THREE.Vector2; // along-crest, toward the channel
  private readonly travel: THREE.Vector2; // dominant swell travel dir
  private surface: SurfaceSample;
  private catchT = 0;
  private wipeT = 0;
  private breakTimer = 0;
  private flatTimer = 0;
  private holdT = 0;
  private readonly autocatch: boolean;

  constructor(
    private ocean: Ocean,
    private controls: GameControls,
    lineup: { x: number; z: number },
    initialYaw: number,
    private events: PlayerEvents = {},
    opts: { autocatch?: boolean } = {}
  ) {
    this.home = new THREE.Vector3(lineup.x, 0, lineup.z);
    this.pos = this.home.clone();
    this.heading = initialYaw;
    this.autocatch = opts.autocatch ?? false;
    this.travel = new THREE.Vector2(ocean.swellDir.x, ocean.swellDir.z);
    // Along-crest direction pointing at the channel (NE side — Bells peels
    // right). World: x = east, z = south, so NE-ish means p.x - p.z > 0.
    const p = new THREE.Vector2(-this.travel.y, this.travel.x);
    if (p.x - p.y < 0) p.multiplyScalar(-1);
    this.peelDir = p;
    this.surface = ocean.surfaceAt(this.pos.x, this.pos.z, 0, 1);
  }

  /** Board forward direction on the xz plane. */
  forward(out = new THREE.Vector2()): THREE.Vector2 {
    return out.set(-Math.sin(this.heading), -Math.cos(this.heading));
  }

  get sample(): SurfaceSample {
    return this.surface;
  }

  update(dt: number, t: number, gain: number, lookYaw: number) {
    const s = this.ocean.surfaceAt(this.pos.x, this.pos.z, t, gain, this.surface);

    switch (this.state) {
      case "sitting": {
        this.vel.multiplyScalar(Math.exp(-2 * dt));
        if (this.controls.holding()) this.setState("paddling");
        break;
      }

      case "paddling": {
        this.heading = lookYaw;
        const fwd = this.forward();
        if (this.controls.holding()) {
          this.holdT += dt;
          this.vel.addScaledVector(fwd, PADDLE_ACCEL * dt);
        } else {
          this.holdT = 0;
        }
        this.vel.multiplyScalar(Math.exp(-0.9 * dt));
        if (this.vel.length() > PADDLE_MAX) this.vel.setLength(PADDLE_MAX);
        this.integrate(dt);
        if (!this.controls.holding() && this.vel.length() < 0.15)
          this.setState("sitting");
        this.tryCatch(t, gain, s);
        break;
      }

      case "catching": {
        this.catchT += dt;
        // Magnetize onto the wave: blend velocity toward the crest's phase
        // speed, drifting slightly toward the channel shoulder.
        const c = this.ocean.phaseSpeedAt(s.depth);
        const target = new THREE.Vector2()
          .addScaledVector(this.travel, c)
          .addScaledVector(this.peelDir, c * 0.35);
        const k = 1 - Math.exp(-dt * 4);
        this.vel.lerp(target, k);
        this.heading = Math.atan2(-this.vel.x, -this.vel.y);
        this.integrate(dt);
        if (this.catchT >= CATCH_DURATION) {
          this.ride = { time: 0, speed: 0, score: 0 };
          this.popup = 0;
          this.setState("riding");
        }
        break;
      }

      case "riding": {
        this.popup = Math.min(1, this.popup + dt / POPUP_DURATION);
        const steer = this.controls.steer();
        this.steerLean += (steer - this.steerLean) * (1 - Math.exp(-dt * 6));
        this.heading -= steer * 2.0 * dt;

        const fwd = this.forward();
        // Gravity pulls down-slope; a modest drive keeps arcade flow.
        this.vel.x += -9.81 * s.slopeX * 0.55 * dt + fwd.x * 1.5 * dt;
        this.vel.y += -9.81 * s.slopeZ * 0.55 * dt + fwd.y * 1.5 * dt;
        // Rail grip: bleed off velocity that's sideways to the board.
        const side = new THREE.Vector2(-fwd.y, fwd.x);
        const lateral = this.vel.dot(side);
        this.vel.addScaledVector(side, -lateral * (1 - Math.exp(-dt * 3.5)));
        this.vel.multiplyScalar(Math.exp(-0.22 * dt));

        // Pocket assist: seaward of the whitewater, shoreward of the flats.
        const trim = this.controls.trim();
        if (s.breaking > 0.35)
          this.vel.addScaledVector(this.peelDir, 2.4 * dt); // outrun the foam
        if (s.over < 0.45)
          this.vel.addScaledVector(this.travel, -1.8 * dt); // back up the face
        this.vel.addScaledVector(this.travel, trim * 1.6 * dt);

        const sp = this.vel.length();
        if (sp > RIDE_MAX_SPEED) this.vel.setLength(RIDE_MAX_SPEED);
        if (sp < RIDE_MIN_SPEED && this.ride.time > 1)
          this.vel.setLength(RIDE_MIN_SPEED);
        this.integrate(dt);

        this.ride.time += dt;
        this.ride.speed = this.vel.length();
        this.ride.score += (1 + Math.abs(steer) * this.ride.speed * 0.12) * dt;

        // Deep in the whitewater for too long -> tumble.
        this.breakTimer = Math.max(
          0,
          this.breakTimer + (s.breaking > 0.72 ? dt : -2 * dt)
        );
        if (this.breakTimer > 0.8) this.wipeout();
        // Ran to the flats / the beach -> clean flick-off.
        this.flatTimer = s.over < 0.45 ? this.flatTimer + dt : 0;
        if (this.flatTimer > 2.2 || s.depth < 0.6) this.endRide();
        break;
      }

      case "wipeout": {
        this.wipeT += dt;
        this.vel.multiplyScalar(Math.exp(-3 * dt));
        this.integrate(dt);
        if (this.wipeT >= WIPEOUT_DURATION) this.respawn();
        break;
      }
    }

    this.pos.y = s.y;
  }

  private integrate(dt: number) {
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.y * dt;
  }

  private tryCatch(t: number, gain: number, s: SurfaceSample) {
    // A wave is catchable when the water under us is standing up and the
    // crest is arriving from just up-swell.
    const upX = this.pos.x - this.travel.x * 16;
    const upZ = this.pos.z - this.travel.y * 16;
    const up = this.ocean.surfaceAt(upX, upZ, t, gain);
    const catchable = s.over > 0.6 && up.crest > 0.55;
    if (catchable && (this.autocatch || this.holdT > 0.25)) {
      this.catchT = 0;
      this.setState("catching");
    }
  }

  private wipeout() {
    this.wipeT = 0;
    this.breakTimer = 0;
    this.events.onWipeout?.();
    this.events.onRideEnd?.({ ...this.ride });
    this.setState("wipeout");
  }

  private endRide() {
    this.flatTimer = 0;
    this.events.onRideEnd?.({ ...this.ride });
    this.respawn();
  }

  private respawn() {
    this.pos.copy(this.home);
    this.vel.set(0, 0);
    this.popup = 0;
    this.breakTimer = 0;
    this.flatTimer = 0;
    this.setState("sitting");
  }

  private setState(next: PlayerState) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.events.onStateChange?.(next, prev);
  }
}
