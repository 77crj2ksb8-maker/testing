// Browser smoke test: boots the app in headless Chromium at iPhone size, runs
// a scenario and fails on any console error, page error or failed expectation.
//
//   node tools/smoke.mjs                                  core scenario
//   node tools/smoke.mjs --scenario tools/scenarios/x.mjs your scenario
//   node tools/smoke.mjs --port 5302 --out /tmp/shots --landscape --settings '{"preset":"rotary"}'
//   node tools/smoke.mjs --page dist/engine-sim.html      test the single-file build
//
// A scenario module default-exports async ({ page, evaluate, advance, shot, expect, log, tap }) => {}.
// The page runs with ?debug, so window.__app (docs/CONTRACT.md) is available.
// Rendering in headless Chromium is software-only (a few fps): drive physics
// with advance(seconds, input) rather than waiting in real time.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const port = Number(opt('port', 5300));
const outDir = path.resolve(opt('out', path.join(root, 'dist', 'smoke')));
const scenarioPath = opt('scenario', path.join(root, 'tools', 'scenarios', 'core.mjs'));
const pagePath = opt('page', '');
const settings = opt('settings', '');
const timeoutMs = Number(opt('timeout', 240000));
fs.mkdirSync(outDir, { recursive: true });

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const fallback = '/opt/node-tools/node_modules/playwright/index.mjs';
    return import(pathToFileURL(fallback).href);
  }
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(f, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const { chromium, devices } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const device = flag('landscape') ? devices['iPhone 14 landscape'] : devices['iPhone 14'];
const context = await browser.newContext({ ...device, deviceScaleFactor: Number(opt('dpr', 1)) });
const page = await context.newPage();
const problems = [];
const logs = [];
page.on('console', (m) => {
  const text = m.text();
  if (m.type() === 'error') problems.push(`console.error: ${text}`);
  else if (m.type() === 'warning' && !/GPU stall|ReadPixels|swiftshader/i.test(text)) logs.push(`warn: ${text}`);
  else if (m.type() === 'log' || m.type() === 'info') logs.push(text);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => {
  if (!/fonts\.g/.test(r.url())) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
});

// three.js from the local npm copy instead of the CDN; fonts stubbed out.
const threeDir = path.join(root, 'node_modules', 'three');
await page.route(/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/, (route) => {
  const rel = route.request().url().match(/three@[^/]+\/(.*)$/)[1];
  route.fulfill({ path: path.join(threeDir, rel), contentType: 'text/javascript' });
});
await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ body: '', contentType: 'text/css' }));
if (settings) {
  await page.addInitScript((s) => {
    try {
      localStorage.setItem('firing-order:settings:v1', s);
    } catch {
      /* ignore */
    }
  }, settings);
}

const failures = [];
const helpers = {
  page,
  log: (...a) => console.log('  ·', ...a),
  evaluate: (fn, arg) => page.evaluate(fn, arg),
  /** Step the simulation `seconds` at a fixed step with fixed pedals ({gas, clutch, brake}, 0..1). */
  advance: (seconds, input = {}) => page.evaluate(([s, i]) => window.__app.debugApi.advance(s, i), [seconds, input]),
  shot: async (name) => {
    await page.waitForTimeout(350); // let a couple of software-rendered frames land
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`  · screenshot ${file}`);
    return file;
  },
  expect: (cond, message) => {
    if (cond) console.log(`  ✓ ${message}`);
    else {
      console.log(`  ✗ ${message}`);
      failures.push(message);
    }
  },
  tap: (selector) => page.locator(selector).first().click(),
};

let status = 0;
const timer = setTimeout(() => {
  console.error(`TIMEOUT after ${timeoutMs} ms`);
  process.exit(2);
}, timeoutMs);
try {
  const url = `http://127.0.0.1:${port}/${pagePath}${pagePath.includes('?') ? '&' : '?'}debug`;
  await page.goto(url);
  await page.waitForFunction(() => window.__engineBooted === true, null, { timeout: 60000 });
  console.log(`booted ${url}`);
  const scenario = await import(pathToFileURL(path.resolve(scenarioPath)).href);
  await scenario.default(helpers);
} catch (err) {
  problems.push(`scenario threw: ${err.stack || err}`);
}
clearTimeout(timer);

if (logs.length) console.log(`page log (${logs.length}):\n${logs.slice(-40).map((l) => `  ${l}`).join('\n')}`);
if (problems.length) {
  console.log(`PROBLEMS (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  status = 1;
}
if (failures.length) {
  console.log(`FAILED EXPECTATIONS (${failures.length}):\n${failures.map((f) => `  ${f}`).join('\n')}`);
  status = 1;
}
console.log(status ? 'SMOKE: FAIL' : 'SMOKE: PASS');
await browser.close();
server.close();
process.exit(status);
