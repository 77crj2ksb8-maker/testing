// Per-cylinder stroke labels, shown while the animation is frozen or being
// scrubbed. DOM chips over the canvas, moved with transforms; each chip is only
// written when its text or rounded position changes.

import * as THREE from 'three';
import { el, injectStyles } from '../dom.js';
import { STROKES } from './timing.js';

const CSS = `
.stroke-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 0; }
.stroke-chip {
  position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 4px;
  padding: 2px 7px 2px 5px; border-radius: 999px; white-space: nowrap;
  background: rgba(9, 11, 16, 0.74); border: 1px solid var(--line-strong);
  font-family: var(--font-data); font-size: 10px; line-height: 14px; color: var(--fg);
  will-change: transform; transition: opacity 0.15s;
}
.stroke-chip b { font-weight: 600; color: var(--muted); }
.stroke-chip i { width: 7px; height: 7px; border-radius: 50%; display: block; flex: none; }
.stroke-chip[data-s="power"] i { background: var(--throttle); box-shadow: 0 0 6px var(--throttle-glow); }
.stroke-chip[data-s="exhaust"] i { background: var(--muted); }
.stroke-chip[data-s="intake"] i { background: var(--clutch); box-shadow: 0 0 6px var(--clutch-glow); }
.stroke-chip[data-s="compression"] i { background: #a58bff; }
.stroke-chip[data-s="power"] { border-color: rgba(255, 122, 26, 0.55); }
`;

const CHIP_H = 21; // chip height + gap, px
const SHORT = { power: 'Power', exhaust: 'Exhaust', intake: 'Intake', compression: 'Compress' };

export class StrokeLabels {
  constructor(canvas) {
    injectStyles('scene-stroke-labels', CSS);
    this.layer = el('div', { class: 'stroke-labels', 'aria-hidden': 'true' });
    this.layer.hidden = true;
    canvas.insertAdjacentElement('afterend', this.layer);
    this.chips = [];
    this.blockers = [];
    this.v = new THREE.Vector3();
  }

  /** Screen rects the chips must stay off (HUD cards, pedals), canvas CSS px: [{left, top, right, bottom}]. */
  setBlockers(rects) {
    this.blockers = rects ?? [];
  }

  covered(x, y, w) {
    for (const r of this.blockers) {
      if (x + w / 2 > r.left && x - w / 2 < r.right && y + CHIP_H / 2 > r.top && y - CHIP_H / 2 < r.bottom) return true;
    }
    return false;
  }

  /** One chip per cylinder (or rotor), labelled with its number. */
  setCount(numbers) {
    this.layer.replaceChildren();
    this.widths = new Map(); // chip width per label text, measured once
    this.chips = numbers.map((num) => {
      const dot = el('i');
      const word = el('span');
      const node = el('div', { class: 'stroke-chip' }, el('b', { text: String(num) }), dot, word);
      this.layer.append(node);
      return { node, word, num, stroke: -1, x: NaN, y: NaN, tx: 0, ty: 0, w: 0, front: true };
    });
  }

  hide() {
    if (!this.layer.hidden) this.layer.hidden = true;
  }

  /**
   * points: world positions per chip; strokes: STROKES index per chip;
   * width/height: CSS size of the canvas; insets: {top, bottom} covered by the HUD.
   */
  update(camera, points, strokes, width, height, insets) {
    if (this.layer.hidden) this.layer.hidden = false;
    const n = this.chips.length;
    for (let i = 0; i < n; i++) {
      const c = this.chips[i];
      const s = strokes[i];
      if (s !== c.stroke) {
        c.stroke = s;
        const id = STROKES[s].id;
        c.node.dataset.s = id;
        c.word.textContent = SHORT[id];
        c.w = 0;
      }
      this.v.copy(points[i]).project(camera);
      c.tx = ((this.v.x + 1) / 2) * width;
      c.ty = ((1 - this.v.y) / 2) * height;
      c.front = this.v.z <= 1;
    }
    // Greedy de-overlap: walk the chips top to bottom and push each one down
    // until it clears the chips already placed.
    const order = this.order ?? (this.order = []);
    order.length = 0;
    for (let i = 0; i < n; i++) order.push(i);
    order.sort((a, b) => this.chips[a].ty - this.chips[b].ty);
    for (let k = 0; k < n; k++) {
      const c = this.chips[order[k]];
      if (!c.w) {
        // Layout read only the first time a chip shows a given text.
        const key = `${c.num}:${c.stroke}`;
        c.w = this.widths.get(key) ?? 0;
        if (!c.w) {
          c.w = c.node.offsetWidth || 72;
          this.widths.set(key, c.w);
        }
      }
      let moved = true;
      for (let guard = 0; moved && guard < n; guard++) {
        moved = false;
        for (let j = 0; j < k; j++) {
          const o = this.chips[order[j]];
          if (Math.abs(o.ty - c.ty) < CHIP_H && Math.abs(o.tx - c.tx) < (o.w + c.w) / 2 + 4) {
            c.ty = o.ty + CHIP_H;
            moved = true;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const c = this.chips[i];
      const x = Math.round(c.tx);
      const y = Math.round(c.ty);
      // Never draw over the HUD bars or off the edges.
      const off = !c.front || y < insets.top + 10 || y > height - insets.bottom - 10 || x < c.w / 2 + 4 || x > width - c.w / 2 - 4
        || this.covered(x, y, c.w);
      if (x !== c.x || y !== c.y) {
        c.x = x;
        c.y = y;
        c.node.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      }
      const opacity = off ? '0' : '';
      if (c.node.style.opacity !== opacity) c.node.style.opacity = opacity;
    }
  }
}
