// Lint for real mistakes only (undefined names, unused code, unreachable code).
// Run: npm run lint (uses the eslint on PATH).
const browser = Object.fromEntries([
  'window', 'document', 'navigator', 'localStorage', 'location', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
  'getComputedStyle', 'matchMedia', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'HTMLElement',
  'HTMLInputElement', 'HTMLCanvasElement', 'Node', 'URL', 'URLSearchParams', 'console', 'AudioContext', 'OfflineAudioContext',
  'ResizeObserver', 'Image', 'Blob', 'DOMMatrix', 'structuredClone', 'queueMicrotask', 'devicePixelRatio', 'innerWidth', 'innerHeight',
].map((g) => [g, 'readonly']));
const node = Object.fromEntries(['process', 'console', 'URL', 'setTimeout', 'clearTimeout', 'Buffer', 'structuredClone'].map((g) => [g, 'readonly']));
const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-redeclare': 'error',
  'no-self-assign': 'error',
  'no-dupe-else-if': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
};
export default [
  { files: ['src/**/*.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: browser }, rules },
  { files: ['test/**/*.mjs', 'tools/**/*.mjs', 'eslint.config.mjs'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...node, window: 'readonly', document: 'readonly', localStorage: 'readonly' } }, rules },
];
