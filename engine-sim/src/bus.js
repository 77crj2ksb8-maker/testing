// A tiny synchronous event bus shared by the core and every feature module.
// Physics events (sim.events) are re-emitted here by the main loop, so features
// never need to drain the simulator themselves. Event types: docs/CONTRACT.md.

export class Bus {
  constructor() {
    this.handlers = new Map();
  }

  /** Subscribe; returns an unsubscribe function. Use '*' to receive every event as (type, payload). */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  once(type, fn) {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit(type, payload = {}) {
    const set = this.handlers.get(type);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[bus] handler for "${type}" failed`, err);
        }
      }
    }
    const any = this.handlers.get('*');
    if (any) for (const fn of [...any]) fn(type, payload);
  }
}
