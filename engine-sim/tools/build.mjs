// Bundles the ES modules into one self-contained HTML file (three.js still
// loads from the CDN through the import map).
//
//   node tools/build.mjs              → dist/engine-sim.html
//   node tools/build.mjs --fragment   → also dist/engine-sim.fragment.html: the
//                                       same page without <html>/<head>/<body>,
//                                       for hosts that supply their own skeleton.

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFile(path.join(root, f));

const bundle = await build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  format: 'esm',
  external: ['three', 'three/addons/*'],
  minify: true,
  target: 'es2020',
  write: false,
  legalComments: 'none',
});
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = (await read('styles.css')).toString();
const dataUri = async (file, type) => `data:${type};base64,${(await read(file)).toString('base64')}`;

let html = (await read('index.html')).toString();
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`build: could not find ${from}`);
  html = html.replace(from, to);
};
swap('<link rel="stylesheet" href="styles.css">', `<style>\n${css}</style>`);
swap('<script type="module" src="./src/main.js"></script>', `<script type="module">\n${js}</script>`);
swap('href="public/icon.svg"', `href="${await dataUri('public/icon.svg', 'image/svg+xml')}"`);
swap('href="public/icon-180.png"', `href="${await dataUri('public/icon-180.png', 'image/png')}"`);
// A manifest has to be a separate file, so the single-file build goes without one.
html = html.replace(/\n\s*<link rel="manifest"[^>]*>/, '');

await fs.mkdir(path.join(root, 'dist'), { recursive: true });
await fs.writeFile(path.join(root, 'dist/engine-sim.html'), html);
console.log(`dist/engine-sim.html  ${(html.length / 1024).toFixed(0)} KB`);

if (process.argv.includes('--fragment')) {
  const title = html.match(/<title>.*?<\/title>/)[0];
  const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]*>/)[0];
  const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
  const importMap = html.match(/<script type="importmap">[\s\S]*?<\/script>/)[0];
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  const fragment = [title, fonts, style, importMap, body.trim()].join('\n');
  await fs.writeFile(path.join(root, 'dist/engine-sim.fragment.html'), fragment);
  console.log(`dist/engine-sim.fragment.html  ${(fragment.length / 1024).toFixed(0)} KB`);
}
