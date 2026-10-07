// Per-cylinder stroke labels, shown while the animation is frozen or being
// scrubbed. DOM chips over the canvas, moved with transforms; each chip is only
// written when its text or rounded position changes.

import * as THREE from 'three';
import { el, injectStyles } from '../dom.js';
import { STROKES } from './timing.js';

const CSS = `
.stroke-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
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

const SHORT = { power: 'Power', exhaust: 'Exhaust', intake: 'Intake', compression: 'Compress' };

export class StrokeLabels {
  constructor(canvas) {
    injectStyles('scene-stroke-labels', CSS);
    this.layer = el('div', { class: 'stroke-labels', 'aria-hidden': 'true' });
    this.layer.hidden = true;
    canvas.insertAdjacentElement('afterend', this.layer);
    this.chips = [];
    this.v = new THREE.Vector3();
  }

  /** One chip per cylinder (or rotor), labelled with its number. */
  setCount(numbers) {
    this.layer.replaceChildren();
    this.chips = numbers.map((num) => {
      const dot = el('i');
      const word = el('span');
      const node = el('div', { class: 'stroke-chip' }, el('b', { text: String(num) }), dot, word);
      this.layer.append(node);
      return { node, word, stroke: -1, x: NaN, y: NaN };
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
    for (let i = 0; i < this.chips.length; i++) {
      const c = this.chips[i];
      const s = strokes[i];
      if (s !== c.stroke) {
        c.stroke = s;
        const id = STROKES[s].id;
        c.node.dataset.s = id;
        c.word.textContent = SHORT[id];
      }
      this.v.copy(points[i]).project(camera);
      const x = Math.round(((this.v.x + 1) / 2) * width);
      const y = Math.round(((1 - this.v.y) / 2) * height);
      // Never draw over the HUD bars or off the edges.
      const behind = this.v.z > 1 || y < insets.top + 10 || y > height - insets.bottom - 10 || x < 40 || x > width - 40;
      if (x !== c.x || y !== c.y) {
        c.x = x;
        c.y = y;
        c.node.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      }
      const hidden = behind ? '0' : '';
      if (c.node.style.opacity !== hidden) c.node.style.opacity = hidden;
    }
  }
}
