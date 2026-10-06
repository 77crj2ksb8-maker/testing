// Touch + keyboard input: pedals with feathering, a draggable H-pattern lever
// constrained to its gate, and keyboard shortcuts. Uses Pointer Events with
// pointer capture so pedals and lever work with several fingers at once.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * A pedal. Pressing it floors it; sliding the finger up eases it off, so the
 * clutch can be fed in gently. Releasing lets it spring back over releaseTime.
 */
export class Pedal {
  constructor(el, { releaseTime = 0.08, pressTime = 0.04 } = {}) {
    this.el = el;
    this.releaseTime = releaseTime;
    this.pressTime = pressTime;
    this.value = 0;
    this.target = 0;
    this.pointer = null;
    this.keyHeld = 0;
    this.enabled = true;

    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.pointer !== null) return;
      e.preventDefault();
      this.pointer = e.pointerId;
      this.y0 = e.clientY;
      this.travel = el.getBoundingClientRect().height * 0.75;
      this.target = 1;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture can fail if the pointer is already gone */
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointer) return;
      this.target = clamp(1 - (this.y0 - e.clientY) / this.travel, 0, 1);
    });
    const end = (e) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      this.target = 0;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setEnabled(on) {
    this.enabled = on;
    this.el.classList.toggle('is-disabled', !on);
    if (!on) {
      this.pointer = null;
      this.target = 0;
      this.value = 0;
    }
  }

  update(dt) {
    const target = this.keyHeld ? 1 : this.target;
    const rate = target > this.value ? 1 / this.pressTime : 1 / this.releaseTime;
    const step = rate * dt;
    this.value = target > this.value ? Math.min(target, this.value + step) : Math.max(target, this.value - step);
    this.el.style.setProperty('--level', this.value.toFixed(3));
    this.el.classList.toggle('is-pressed', this.value > 0.02);
    return this.value;
  }
}

// Gate geometry in the lever box's normalised coordinates.
const COLS = [0.18, 0.5, 0.82];
const TOP = 0.14;
const MID = 0.5;
const BOTTOM = 0.86;
const ENGAGE = 0.25; // distance from the neutral plane that engages a gear
const NEUTRAL_BAND = 0.035;
const GEAR_AT = { '0,top': 1, '0,bottom': 2, '1,top': 3, '1,bottom': 4, '2,top': 5, '2,bottom': 'R' };
const SLOT_OF = { 1: [0, TOP], 2: [0, BOTTOM], 3: [1, TOP], 4: [1, BOTTOM], 5: [2, TOP], R: [2, BOTTOM] };

/**
 * H-pattern lever. The knob can only move along the gate: sideways in the
 * neutral plane, up/down inside a slot. onSelect(gear) returns { ok } and a
 * refused gear (grind) knocks the knob back towards neutral.
 */
export class HShifter {
  constructor(el, knob, onSelect) {
    this.el = el;
    this.knob = knob;
    this.onSelect = onSelect;
    this.x = COLS[1];
    this.y = MID;
    this.rest = [COLS[1], MID];
    this.pointer = null;
    this.zone = 'N';
    this.blockedZone = null;
    this.labels = [...el.querySelectorAll('.gate-label')];

    el.addEventListener('pointerdown', (e) => {
      if (this.pointer !== null) return;
      e.preventDefault();
      this.pointer = e.pointerId;
      const [px, py] = this.norm(e);
      // Grab relative to the knob so a thumb can drag from anywhere in the box.
      this.offset = [this.x - px, this.y - py];
      this.lastTarget = [this.x, this.y];
      el.classList.add('is-dragging');
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointer) return;
      const [px, py] = this.norm(e);
      this.dragTo(px + this.offset[0], py + this.offset[1]);
    });
    const end = (e) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      el.classList.remove('is-dragging');
      this.settle();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.render();
  }

  norm(e) {
    const r = this.el.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  nearestCol(x) {
    let best = 0;
    for (let i = 1; i < COLS.length; i++) if (Math.abs(COLS[i] - x) < Math.abs(COLS[best] - x)) best = i;
    return best;
  }

  // Move the knob towards a target in small steps so a fast flick still has to
  // pass through neutral instead of jumping across the gate.
  dragTo(tx, ty) {
    const [lx, ly] = this.lastTarget;
    const steps = Math.max(1, Math.ceil(Math.hypot(tx - lx, ty - ly) / 0.02));
    for (let i = 1; i <= steps; i++) this.stepTowards(lx + ((tx - lx) * i) / steps, ly + ((ty - ly) * i) / steps);
    this.lastTarget = [tx, ty];
  }

  stepTowards(tx, ty) {
    const inNeutral = Math.abs(this.y - MID) < NEUTRAL_BAND;
    if (inNeutral) {
      this.x = clamp(tx, COLS[0], COLS[2]);
      const col = this.nearestCol(this.x);
      if (Math.abs(this.x - COLS[col]) < 0.07 && Math.abs(ty - MID) > NEUTRAL_BAND) {
        this.x = COLS[col];
        this.y = clamp(ty, TOP, BOTTOM);
      } else this.y = MID;
    } else {
      const col = this.nearestCol(this.x);
      this.x = COLS[col];
      const ny = clamp(ty, TOP, BOTTOM);
      // Crossing the neutral plane parks the knob in it first.
      this.y = (this.y - MID) * (ny - MID) < 0 ? MID : ny;
    }
    this.checkZone();
  }

  zoneAt(x, y) {
    if (Math.abs(y - MID) < ENGAGE) return 'N';
    return GEAR_AT[`${this.nearestCol(x)},${y < MID ? 'top' : 'bottom'}`];
  }

  checkZone() {
    const z = this.zoneAt(this.x, this.y);
    if (z === this.zone) return;
    if (z === 'N') {
      this.zone = 'N';
      this.blockedZone = null;
      this.onSelect('N');
      return;
    }
    if (this.blockedZone === z) {
      this.y = MID + Math.sign(this.y - MID) * (ENGAGE - 0.04);
      return;
    }
    const res = this.onSelect(z);
    if (res && res.ok === false) {
      // Refused (grind): knock the lever back out of the gear.
      this.blockedZone = z;
      this.y = MID + Math.sign(this.y - MID) * (ENGAGE - 0.06);
      this.el.classList.remove('is-blocked');
      void this.el.offsetWidth;
      this.el.classList.add('is-blocked');
      return;
    }
    this.zone = z;
  }

  settle() {
    if (this.zone !== 'N') {
      const [c, y] = SLOT_OF[this.zone];
      this.rest = [COLS[c], y];
    } else {
      // Lever springs back to the 3–4 plane, like a real gearbox.
      this.rest = [COLS[1], MID];
      if (Math.abs(this.y - MID) >= NEUTRAL_BAND) this.rest = [this.x, MID];
      this.returnToCentre = true;
    }
  }

  /** Show a gear chosen elsewhere (keyboard, automatic). */
  show(gear) {
    this.zone = gear;
    this.blockedZone = null;
    if (gear === 'N' || !SLOT_OF[gear]) {
      this.rest = [COLS[1], MID];
      this.zone = 'N';
    } else {
      const [c, y] = SLOT_OF[gear];
      this.rest = [COLS[c], y];
    }
  }

  setAuto(on) {
    this.el.classList.toggle('is-auto', on);
  }

  update(dt) {
    if (this.pointer === null) {
      const k = Math.min(1, dt * 16);
      // Return path stays on the gate: first back to the neutral plane, then sideways.
      if (this.returnToCentre && Math.abs(this.y - MID) > 0.01) {
        this.y += (MID - this.y) * k;
      } else {
        this.returnToCentre = false;
        this.x += (this.rest[0] - this.x) * k;
        this.y += (this.rest[1] - this.y) * k;
      }
    }
    this.render();
  }

  render() {
    const r = this.el.clientWidth;
    const h = this.el.clientHeight;
    this.knob.style.transform = `translate(${(this.x * r).toFixed(1)}px, ${(this.y * h).toFixed(1)}px)`;
    for (const l of this.labels) l.classList.toggle('is-live', l.textContent === String(this.zone));
  }
}

/** Keyboard shortcuts for desktop testing. */
export function bindKeyboard({ gas, clutch, brake, onGear, onStart, onToggle }) {
  const held = new Set();
  const setPedals = () => {
    gas.keyHeld = held.has('gas') ? 1 : 0;
    clutch.keyHeld = held.has('clutch') ? 1 : 0;
    brake.keyHeld = held.has('brake') ? 1 : 0;
  };
  const pedalFor = (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') return 'gas';
    if (e.key === 'Shift' || e.code === 'KeyC') return 'clutch';
    if (e.code === 'ArrowDown' || e.code === 'KeyB' || e.code === 'KeyS') return 'brake';
    return null;
  };
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const p = pedalFor(e);
    if (p) {
      e.preventDefault();
      held.add(p);
      setPedals();
      return;
    }
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (/^[1-5]$/.test(k)) onGear(Number(k));
    else if (k === 'r') onGear('R');
    else if (k === 'n' || k === '0') onGear('N');
    else if (k === 'enter' || k === 'i') onStart();
    else if (k === 'm' || k === 't' || k === 'g' || k === 'v' || k === 'escape') onToggle(k);
  });
  window.addEventListener('keyup', (e) => {
    const p = pedalFor(e);
    if (p) {
      held.delete(p);
      setPedals();
    }
  });
  window.addEventListener('blur', () => {
    held.clear();
    setPedals();
  });
}
