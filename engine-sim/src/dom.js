// DOM helpers for feature modules: build elements and inject a feature's CSS
// once, so features can ship their own markup and styles without touching
// index.html or styles.css.

const injected = new Set();

/** Add a <style> block for a feature exactly once. */
export function injectStyles(id, css) {
  if (injected.has(id)) return;
  injected.add(id);
  const style = document.createElement('style');
  style.dataset.feature = id;
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Create an element. props: attributes, plus `class`, `text`, `html` (trusted
 * static markup only, e.g. inline SVG icons), `style` (object), `on` ({event: fn}).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Format a speed in the user's units. */
export function formatSpeed(kmh, units) {
  return units === 'mph' ? Math.round(kmh * 0.621371) : Math.round(kmh);
}

export const speedUnit = (units) => (units === 'mph' ? 'mph' : 'km/h');
