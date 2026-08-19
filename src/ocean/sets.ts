import {
  SET_DURATION,
  SET_GAIN_BASE,
  SET_GAIN_PEAK,
  SET_PERIOD_JITTER,
  SET_PERIOD_MEAN,
} from "../config";

/**
 * Wave-set scheduler: long lulls with smaller swell, then a set of bigger
 * waves rolls through. Produces a smooth gain applied to the swell
 * amplitudes, plus an "incoming" flag for the HUD a few seconds early.
 */
export class SetScheduler {
  private nextSetAt: number;
  private setStartedAt = -Infinity;

  constructor(now = 0) {
    // First set arrives quickly so the opening minute isn't a lull.
    this.nextSetAt = now + 14;
  }

  /** Smooth swell gain for the current time (call once per frame). */
  gain(now: number): number {
    if (now >= this.nextSetAt) {
      this.setStartedAt = this.nextSetAt;
      this.nextSetAt =
        this.nextSetAt +
        SET_DURATION +
        SET_PERIOD_MEAN +
        (Math.random() * 2 - 1) * SET_PERIOD_JITTER;
    }
    const t = now - this.setStartedAt;
    let envelope = 0;
    if (t >= 0 && t < SET_DURATION) {
      // Ramp in, hold, ramp out.
      const rise = Math.min(1, t / 10);
      const fall = Math.min(1, (SET_DURATION - t) / 12);
      envelope = Math.min(rise, fall);
      envelope = envelope * envelope * (3 - 2 * envelope);
    }
    return SET_GAIN_BASE + (SET_GAIN_PEAK - SET_GAIN_BASE) * envelope;
  }

  /** True shortly before and during a set, for the HUD indicator. */
  setIncoming(now: number): boolean {
    const untilNext = this.nextSetAt - now;
    const sinceStart = now - this.setStartedAt;
    return (
      (untilNext > 0 && untilNext < 8) ||
      (sinceStart >= 0 && sinceStart < SET_DURATION)
    );
  }
}
