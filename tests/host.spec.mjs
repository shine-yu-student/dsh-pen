/**
 * Host-half exercise without the Harness runtime: a stub Cordis context records
 * what `apply` registers, then every tool and every browser route is driven
 * through that stub and its output is checked.
 *
 * Run with `node tests/host.spec.mjs`.
 */

import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const pen = await import('../index.js');
const { raster, ops } = require('../lib/pen-shared.cjs');

let failures = 0;
let checks = 0;

/** Assert one expectation. */
function ok(condition, label, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`FAIL  ${label}${detail === undefined ? '' : `\n      ${detail}`}`);
}

/** Parse the output of `identify` to prove a PNG decodes outside this process. */
function identify(bytes) {
  const path = join(tmpdir(), `pen-check-${process.pid}-${Math.random().toString(16).slice(2)}.png`);
  const { writeFileSync, unlinkSync } = require('node:fs');
  writeFileSync(path, bytes);
  try {
    const out = execFileSync('identify', ['-format', '%m %w %h %[channels]', path], { encoding: 'utf8' });
    return out.trim();
  } finally {
    unlinkSync(path);
  }
}

/** Build a stub Context that satisfies the plugin's optional services. */
function createHarness(config) {
  const tools = new Map();
  const routes = [];
  const injected = [];
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    get: (name) => ctx.services[name],
    effect: (callback) => {
      const dispose = callback();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    inject: (names, callback) => {
      injected.push(names);
      callback({
        effect: (cb) => { const dispose = cb(); return () => { if (typeof dispose === 'function') dispose(); }; },
        systemPrompt: { section: (section) => { injected.push(section); return () => {}; } },
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
      });
    },
    services: {
      attachments: {
        saveImage: async (input) => ({
          attachmentId: `att-${input.data.length}`,
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: 0,
          height: 0,
          name: input.name,
        }),
      },
    },
  };
  pen.apply(ctx, config || {});
  return { tools, routes, injected };
}

/** Invoke one registered tool with a session-bound execution context. */
async function callTool(harness, name, args, session, cwd) {
  const tool = harness.tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return await tool.execute(args, {
    agent: { id: session || 'session-a', session: { header: { cwd: cwd || process.cwd() } } },
    signal: new AbortController().signal,
  });
}

/**
 * Violations of the registry's enforced JSON Schema subset in one node. The
 * registry asserts this subset on every tool's output schema when it registers
 * and rejects unknown types such as the author-DSL `json`, so a mistake here
 * costs every tool in the bundle rather than one call.
 * @param {unknown} node - candidate schema node.
 * @param {string} path - diagnostic path.
 * @returns {string[]} violations.
 */
function subsetViolations(node, path) {
  const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
  const keywords = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];
  const annotations = ['description', 'title', 'default', 'examples'];
  const violations = [];
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [`${path} must be a schema object`];
  for (const key of Object.keys(node)) {
    if (keywords.includes(key) || annotations.includes(key)) continue;
    violations.push(`${path}.${key} is not a supported keyword`);
  }
  const hasType = node.type !== undefined;
  const hasOneOf = node.oneOf !== undefined;
  if (hasType && hasOneOf) violations.push(`${path} cannot declare both type and oneOf`);
  if (!hasType && !hasOneOf) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items']) {
      if (node[key] !== undefined) violations.push(`${path}.${key} requires type or oneOf`);
    }
    return violations;
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${path}.oneOf needs at least two branches`);
    else node.oneOf.forEach((branch, index) => violations.push(...subsetViolations(branch, `${path}.oneOf[${index}]`)));
    return violations;
  }
  if (!types.includes(node.type)) {
    violations.push(`${path}.type must be one of ${types.join('/')}`);
    return violations;
  }
  const allowedFor = {
    properties: ['object'], required: ['object'], additionalProperties: ['object'], items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'], const: ['string', 'number', 'integer', 'boolean', 'null'],
  };
  for (const [key, owners] of Object.entries(allowedFor)) {
    if (node[key] !== undefined && !owners.includes(node.type)) violations.push(`${path}.${key} is not supported on type "${node.type}"`);
  }
  if (node.type === 'object' && node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`);
  }
  if (node.type === 'object') {
    const properties = node.properties || {};
    for (const [key, child] of Object.entries(properties)) violations.push(...subsetViolations(child, `${path}.properties.${key}`));
    for (const name of node.required || []) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) violations.push(`${path}.required names undeclared property "${name}"`);
    }
  }
  if (node.type === 'array' && node.items !== undefined) violations.push(...subsetViolations(node.items, `${path}.items`));
  return violations;
}

/** Drive one route request through the registered handler. */
function callRoute(harness, { method, url, body }) {
  const route = harness.routes[0];
  if (!route) throw new Error('no route registered');
  return new Promise((resolvePromise, reject) => {
    const listeners = new Map();
    const request = {
      method,
      url,
      on: (event, listener) => { listeners.set(event, listener); return request; },
      destroy: () => {},
    };
    let status = 0;
    let headers = {};
    let payload = null;
    const response = {
      headersSent: false,
      writeHead: (code, nextHeaders) => { status = code; headers = nextHeaders || {}; response.headersSent = true; },
      end: (chunk) => {
        payload = chunk === undefined ? Buffer.alloc(0) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        resolvePromise({ status, headers, payload });
      },
    };
    const promise = route.handler(request, response);
    const deliver = async () => {
      if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)));
      listeners.get('end')?.();
    };
    // The handler reads the body asynchronously, so feed it after the call.
    setImmediate(() => { deliver().catch(reject); });
    if (promise && typeof promise.catch === 'function') promise.catch(reject);
  });
}

// ── Tool registration ───────────────────────────────────────────────────────

const harness = createHarness({ quality: 2 });
ok(harness.tools.size === pen.PEN_TOOLS.length, 'all five pen tools register',
  `registered: ${[...harness.tools.keys()].join(', ')}`);
for (const name of pen.PEN_TOOLS) ok(harness.tools.has(name), `tool ${name} exists`);
ok(harness.injected.some((entry) => Array.isArray(entry) && entry.includes('webServer')), 'the browser route is registered when webServer exists');
ok(harness.injected.some((entry) => entry && entry.name === 'dsh-pen:drawing-canvas'), 'the prompt section is registered');

// ── Registration contract ───────────────────────────────────────────────────

/**
 * Expected scheduling classification per call, keyed by tool name: `true` means
 * the call may share a parallel group with its siblings. A canvas-replacing or
 * clearing call must stay exclusive so it cannot race a sibling that paints.
 */
const SCHEDULING = {
  pen_create: [[{}, false]],
  pen_draw: [[{}, true]],
  pen_canvas: [[{}, true], [{ action: 'status' }, true], [{ action: 'clear' }, false]],
  pen_screenshot: [[{}, true]],
  pen_export: [[{}, true]],
};

for (const [name, tool] of harness.tools) {
  const violations = [
    ...subsetViolations(tool.parameters, `${name}.parameters`),
    ...subsetViolations(tool.output.schema, `${name}.output.schema`),
  ];
  ok(violations.length === 0, `${name} declares schemas inside the enforced subset`, violations.join('; '));
  ok(typeof tool.output.render === 'function' && typeof tool.execute === 'function', `${name} declares render and execute`);
  for (const [args, expected] of SCHEDULING[name]) {
    const actual = tool.isConcurrencySafe ? tool.isConcurrencySafe(args) : false;
    ok(actual === expected, `${name}${JSON.stringify(args)} scheduling is ${expected ? 'parallel' : 'exclusive'}`,
      `isConcurrencySafe -> ${actual}`);
  }
}
ok(harness.tools.get('pen_draw').parameters.properties.operations.items.oneOf.length === 10,
  'the drawing schema offers one branch per operation kind');

// ── Tool behaviour ──────────────────────────────────────────────────────────

const created = await callTool(harness, 'pen_create', { width: 320, height: 240, background: '#ffffff', name: 'unit' });
ok(/Created unit 320x240px/.test(created.text), 'pen_create reports the new canvas', created.text);
ok(created.text.includes('The canvas is empty.'), 'a fresh canvas reports empty', created.text);

const tooSmall = await callTool(harness, 'pen_create', { width: 4, height: 4 }).then(() => null, (error) => error);
ok(tooSmall instanceof Error && /at least 16 pixels/.test(tooSmall.message), 'an undersized canvas is refused', tooSmall && tooSmall.message);
const oversized = await callTool(harness, 'pen_create', { width: 9000, height: 100 }).then(() => null, (error) => error);
ok(oversized instanceof Error && /exceeds the 2048x2048 maximum/.test(oversized.message), 'an oversized canvas is refused', oversized && oversized.message);
const accepted = await callTool(harness, 'pen_create', { width: 320, height: 240, name: 'unit', background: '#ffffff' });
ok(/Created unit 320x240px/.test(accepted.text), 'a supported canvas is created again', accepted.text);

const draw = await callTool(harness, 'pen_draw', {
  operations: [
    { kind: 'line', x1: 10, y1: 10, x2: 300, y2: 220, color: '#e63946', strokeWidth: 4 },
    { kind: 'rect', x: 40, y: 40, width: 120, height: 80, fill: '#ffe8a3', color: '#8d603c', strokeWidth: 3 },
    { kind: 'curve', points: [[20, 200], [120, 120], [240, 200]], color: '#2a9d5c', brush: 'marker' },
  ],
}, 'session-a');
ok(/Painted 3 operation\(s\)/.test(draw.text), 'pen_draw paints a batch', draw.text);

const invalid = await callTool(harness, 'pen_draw', {
  operations: [{ kind: 'line', x1: 1, y1: 1, x2: 2, y2: 2 }, { kind: 'circle', cx: 1, cy: 1 }],
}, 'session-a').then(() => null, (error) => error);
ok(invalid instanceof Error && /no operation was drawn/.test(invalid.message), 'an invalid batch paints nothing and names the failures', invalid && invalid.message);
ok(invalid instanceof Error && /operations\[1\]\.radius/.test(invalid.message), 'the failing operation is identified by index', invalid && invalid.message);

const status = await callTool(harness, 'pen_canvas', {}, 'session-a');
ok(/3 operation\(s\)/.test(status.text), 'pen_canvas reports the operation count', status.text);
ok((await callTool(harness, 'pen_draw', { operations: [] }, 'session-a').then(() => null, (error) => error)) instanceof Error,
  'an empty operation array is refused');
const unknownArg = await callTool(harness, 'pen_canvas', { nope: 1 }, 'session-a').then(() => null, (error) => error);
ok(unknownArg instanceof Error && /unknown argument/.test(unknownArg.message), 'unknown arguments are refused before the body runs', unknownArg && unknownArg.message);
const noCanvas = await callTool(harness, 'pen_canvas', {}, 'session-b').then(() => null, (error) => error);
ok(noCanvas instanceof Error && /no canvas for this session/.test(noCanvas.message), 'a session without a canvas is refused', noCanvas && noCanvas.message);

// ── Screenshot ──────────────────────────────────────────────────────────────

const shot = await callTool(harness, 'pen_screenshot', { maxWidth: 160 }, 'session-a');
ok(shot.image && shot.image.attachment.mediaType === 'image/png', 'pen_screenshot returns an image attachment');
ok(/Rendered region x=0 y=0 w=320 h=240/.test(shot.text), 'the screenshot names the full region', shot.text);
ok(shot.width <= 160 && shot.height <= 240, 'maxWidth caps the returned image', `${shot.width}x${shot.height}`);

const region = await callTool(harness, 'pen_screenshot', { x: 40, y: 40, width: 120, height: 80 }, 'session-a');
ok(/w=120 h=80/.test(region.text), 'a partial region is honoured', region.text);

// ── Export ──────────────────────────────────────────────────────────────────

const directory = await mkdtemp(join(tmpdir(), 'pen-export-'));
try {
  const target = join(directory, 'nested', 'drawing.png');
  const exported = await callTool(harness, 'pen_export', { path: target }, 'session-a');
  ok(exported.path === target, 'pen_export returns the written path', exported.path);
  const bytes = await readFile(target);
  ok(bytes.length > 0 && bytes[0] === 0x89, 'the exported file is a PNG');
  ok((await stat(target)).size === bytes.length, 'the exported file is complete');
  ok(identify(bytes).startsWith('PNG 320 240'), 'an external decoder reads the exported PNG', identify(bytes));

  // The default path is the calling session's workspace, not the server's
  // launch directory, so a bare export lands beside the session's files.
  const workspace = await mkdtemp(join(tmpdir(), 'pen-workspace-'));
  try {
    const fallback = await callTool(harness, 'pen_export', {}, 'session-a', workspace);
    ok(fallback.path === join(workspace, 'unit.png'), 'the default export path follows the session workspace', fallback.path);
    const relative = await callTool(harness, 'pen_export', { path: 'art/unit.png' }, 'session-a', workspace);
    ok(relative.path === join(workspace, 'art', 'unit.png'), 'a relative export path resolves inside the session workspace', relative.path);
    ok((await readFile(fallback.path)).length > 0, 'the defaulted export wrote a real file');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

// ── Routes ──────────────────────────────────────────────────────────────────

const stateBefore = await callRoute(harness, { method: 'GET', url: '/pen/state?session=session-a' });
ok(stateBefore.status === 200, 'GET /pen/state answers 200', String(stateBefore.status));
const stateBody = JSON.parse(stateBefore.payload.toString('utf8'));
ok(stateBody.canvas && stateBody.canvas.width === 320 && stateBody.canvas.operations === 3, 'the state route reports the live canvas',
  stateBefore.payload.toString('utf8'));

const missing = await callRoute(harness, { method: 'GET', url: '/pen/state?session=none' });
ok(JSON.parse(missing.payload.toString('utf8')).canvas === null, 'an unknown session reports no canvas');

const noSession = await callRoute(harness, { method: 'GET', url: '/pen/state' });
ok(noSession.status === 400, 'a missing session is a bad request', String(noSession.status));

const image = await callRoute(harness, { method: 'GET', url: '/pen/image?session=session-a&mode=preview' });
ok(image.status === 200 && image.headers['content-type'] === 'image/png', 'GET /pen/image serves a PNG', JSON.stringify(image.headers));
ok(identify(image.payload).startsWith('PNG 320 240'), 'the served preview decodes externally', identify(image.payload));

const created2 = await callRoute(harness, { method: 'POST', url: '/pen/state?session=session-c', body: { action: 'create', width: 200, height: 150, name: 'from-panel' } });
ok(created2.status === 200, 'POST create answers 200', String(created2.status));
const cleared = await callRoute(harness, { method: 'POST', url: '/pen/state?session=session-a', body: { action: 'clear' } });
ok(cleared.status === 200, 'POST clear answers 200', String(cleared.status));
const afterClear = await callRoute(harness, { method: 'GET', url: '/pen/state?session=session-a' });
ok(JSON.parse(afterClear.payload.toString('utf8')).canvas.operations === 0, 'clear empties the canvas');

const unknownAction = await callRoute(harness, { method: 'POST', url: '/pen/state?session=session-a', body: { action: 'explode' } });
ok(unknownAction.status === 400, 'an unknown action is refused', String(unknownAction.status));
const unknownRoute = await callRoute(harness, { method: 'GET', url: '/pen/nope?session=session-a' });
ok(unknownRoute.status === 404, 'an unknown pen route is 404', String(unknownRoute.status));

// ── Shared rasterizer spot checks ───────────────────────────────────────────

const surface = ops.renderOperations({ width: 64, height: 64, background: '#ffffff', quality: 2 }, ops.normalizeOperations([
  { kind: 'circle', cx: 32, cy: 32, radius: 20, fill: '#247bbf' },
]));
ok(surface.pixel(32, 32).join(',') === '36,123,191,255', 'the rasterizer fills the circle interior', surface.pixel(32, 32).join(','));
ok(surface.pixel(2, 2).join(',') === '255,255,255,255', 'the rasterizer leaves the background outside');
// A fill-only circle leaves its boundary antialiased: some pixel of the
// boundary column has to be a blend of the fill and the background.
const blended = [];
for (let y = 6; y <= 18; y += 1) {
  const pixel = surface.pixel(32, y);
  if (pixel[0] > 36 && pixel[0] < 255) blended.push(`${y}:${pixel.join(',')}`);
}
ok(blended.length > 0, 'supersampling produces partial coverage at the edge', blended.join(' '));
ok(surface.pixel(32, 20).join(',') === '36,123,191,255', 'the fill reaches the interior');
ok(raster.parseColor('rgba(10, 20, 30, 0.5)').join(',') === '10,20,30,128', 'rgba() parses', raster.parseColor('rgba(10, 20, 30, 0.5)').join(','));
ok(raster.parseColor('#abc').join(',') === '170,187,204,255', '#rgb expands', raster.parseColor('#abc').join(','));
ok(raster.parseColor('nonsense').join(',') === '0,0,0,255', 'an unparsable color falls back to black');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
