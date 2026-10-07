// Bookkeeping for one-shot sounds (pops, bangs, the blow-off valve...). Phones
// glitch when too many buffer sources play at once, so every one-shot takes a
// slot from a fixed pool: when the pool is full a new sound is dropped unless it
// outranks the oldest lowest-priority voice, which is then stopped and replaced.
// Pure: times are numbers in seconds, handles are whatever the caller stores.

import { clamp } from './dsp.js';

export const MAX_ONE_SHOTS = 12;

export const PRIORITY = { pop: 0, ui: 1, event: 2, critical: 3 };

export class VoicePool {
  constructor(cap = MAX_ONE_SHOTS) {
    this.cap = cap;
    this.slots = Array.from({ length: cap }, () => ({ busy: false, start: 0, end: 0, priority: 0, handle: null }));
    this.stolen = null; // handle evicted by the last acquire(), for the caller to stop
    this.dropped = 0; // how many sounds were refused, for diagnostics
  }

  /** Free every slot whose sound has finished by `now`. */
  prune(now) {
    for (const s of this.slots) {
      if (s.busy && s.end <= now) this.free(s);
    }
  }

  free(slot) {
    slot.busy = false;
    slot.handle = null;
  }

  /** Free the slot holding `handle` (e.g. from a source's onended). */
  release(handle) {
    for (const s of this.slots) {
      if (s.busy && s.handle === handle) {
        this.free(s);
        return true;
      }
    }
    return false;
  }

  /** Number of slots in use at `now`. */
  active(now) {
    this.prune(now);
    let n = 0;
    for (const s of this.slots) if (s.busy) n++;
    return n;
  }

  /**
   * Reserve a slot, at audio time `now`, for a sound that ends at `end` (it may
   * be scheduled to start later: a scheduled source is already a live node, so
   * it holds its slot from now on). Returns the slot (set `slot.handle`) or null
   * when the sound should be dropped. If another voice had to make room, its
   * handle is left in `this.stolen`.
   */
  acquire(now, end, priority = 0) {
    this.stolen = null;
    this.prune(now);
    const start = now;
    let victim = null;
    for (const s of this.slots) {
      if (!s.busy) {
        victim = s;
        break;
      }
      if (!victim || s.priority < victim.priority || (s.priority === victim.priority && s.start < victim.start)) victim = s;
    }
    if (victim.busy) {
      if (victim.priority >= priority) {
        this.dropped++;
        return null;
      }
      this.stolen = victim.handle;
    }
    victim.busy = true;
    victim.start = start;
    victim.end = end;
    victim.priority = priority;
    victim.handle = null;
    return victim;
  }
}

/** Per-key minimum spacing between triggers (audio time, seconds). */
export class Cooldowns {
  constructor() {
    this.last = new Map();
  }

  allow(key, now, gap) {
    const t = this.last.get(key);
    if (t !== undefined && now - t < gap && now >= t) return false;
    this.last.set(key, now);
    return true;
  }

  /** True when `key` was last allowed less than `gap` ago. */
  recent(key, now, gap) {
    const t = this.last.get(key);
    return t !== undefined && now >= t && now - t < gap;
  }
}

/**
 * What a `backfire` event sounds like: a list of {kind, delay, gain, rate}.
 * Overrun crackle is a short volley of small pops, the limiter a single pop or
 * two, the two-step a heavy bang and a flat shift a pop just after the crack.
 * @param {number} strength 0..1
 * @param {string} source 'overrun' | 'limiter' | 'twostep' | 'shift'
 * @param {() => number} rand PRNG in [0, 1)
 */
export function backfirePlan(strength, source, rand) {
  const s = clamp(Number.isFinite(strength) ? strength : 0.5, 0, 1);
  const out = [];
  if (source === 'twostep') {
    out.push({ kind: 'bang', delay: 0.03, gain: 0.55 + 0.45 * s, rate: 0.9 + 0.2 * rand() });
  } else if (source === 'shift') {
    out.push({ kind: s > 0.6 ? 'bang' : 'pop', delay: 0.04, gain: 0.5 + 0.5 * s, rate: 0.95 + 0.2 * rand() });
  } else if (source === 'limiter') {
    out.push({ kind: 'pop', delay: 0, gain: 0.5 + 0.5 * s, rate: 0.9 + 0.25 * rand() });
    if (s > 0.6) out.push({ kind: 'pop', delay: 0.05 + 0.04 * rand(), gain: 0.35 + 0.4 * s, rate: 1 + 0.25 * rand() });
  } else {
    const count = 1 + (s > 0.4 ? 1 : 0) + (s > 0.7 ? 1 : 0);
    let delay = 0;
    for (let i = 0; i < count; i++) {
      out.push({ kind: 'pop', delay, gain: (0.3 + 0.7 * s) * (1 - i * 0.22), rate: 0.8 + 0.45 * rand() });
      delay += 0.04 + 0.07 * rand();
    }
  }
  return out;
}
