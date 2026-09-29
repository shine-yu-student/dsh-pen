/**
 * Browser-half exercise without a browser: the generated client bundle is
 * loaded through a stub `window.__ModuleLoader__`, its registered factory runs
 * against a minimal React shim and a stub right-Sidebar service, and the
 * rendered trees are driven against a local HTTP server that answers the pen
 * routes.
 *
 * This proves the parts a plain `apply()` check cannot: the factory
 * materializes, the `pen` tab type and its body register in the right Sidebar,
 * the composer toggle drives that column, the canvas renders, the zoom and pan
 * gestures move the view, and unmounting stops every timer.
 *
 * Run with `node tests/client.spec.mjs`.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundleSource = await readFile(join(here, '..', 'lib', 'client', 'pen-client.js'), 'utf8');

/** Silence window used to prove an unmounted panel stopped polling; exceeds the panel's own poll period. */
const POLL_SILENCE_MS = 900;

/** The stage's measured box in the shim; the component fits and pans inside it. */
const STAGE_BOX = { left: 0, top: 0, width: 640, height: 420 };

let failures = 0;
let checks = 0;

/** Assert one expectation. Failures are written synchronously: the run ends process.exit. */
function ok(condition, label, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  writeSync(2, `FAIL  ${label}${detail === undefined ? '' : `\n      ${detail}`}\n`);
}

/** Assert two numbers agree within a tolerance. */
function near(actual, expected, tolerance, label) {
  ok(Math.abs(actual - expected) <= tolerance, label, `expected ${expected}, got ${actual}`);
}

// ── React shim ──────────────────────────────────────────────────────────────

/**
 * Flatten nested child arguments while keeping both the shim's own nodes and
 * raw text; `false`/`null`/`undefined` are dropped the way React drops them.
 */
function flatten(values) {
  const out = [];
  for (const value of values) {
    if (Array.isArray(value)) out.push(...flatten(value));
    else if (value === null || value === undefined || value === false || value === true) continue;
    else out.push(value);
  }
  return out;
}

/** One virtual node of the shim's render output. */
class Node {
  constructor(type, props, children) {
    this.type = type;
    this.props = props || {};
    this.children = flatten(children);
  }
}

/**
 * The one DOM element the shim gives a `ref`: a persistent stand-in for the
 * panel's stage, which is what a real element is across renders. Listeners
 * attach to it and gestures read its measured box, exactly as the component
 * expects.
 */
const stageElement = {
  box: Object.assign({}, STAGE_BOX),
  listeners: new Map(),
  addEventListener(type, handler) { this.listeners.set(type, handler); },
  removeEventListener(type) { this.listeners.delete(type); },
  getBoundingClientRect() { return this.box; },
  setPointerCapture() {},
  releasePointerCapture() {},
};

/** Per-component hook state: slots by index, effect deps, and the live cleanups. */
const componentStates = new Map();
let activeState = null;
let hookCursor = 0;
let effectCursor = 0;
let pendingEffects = [];

/** The state record one component's hooks live in. */
function stateFor(type) {
  let state = componentStates.get(type);
  if (state === undefined) {
    state = { slots: [], filled: new Set(), deps: [], cleanups: new Map() };
    componentStates.set(type, state);
  }
  return state;
}

/** Minimal hook set covering what the panel uses: useState, useEffect, useRef. */
const reactShim = {
  createElement: (type, props, ...children) => new Node(type, props, children),
  useState: (initial) => {
    const owner = activeState;
    const index = hookCursor;
    hookCursor += 1;
    if (!owner.filled.has(index)) {
      owner.slots[index] = typeof initial === 'function' ? initial() : initial;
      owner.filled.add(index);
    }
    // Setters only store the next value; the test drives the next render with
    // `commit()`, which is what a committed React update amounts to here. The
    // owner is captured now: a setter outlives the render that created it.
    const set = (next) => {
      owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next;
    };
    return [owner.slots[index], set];
  },
  useRef: (initial) => {
    const owner = activeState;
    const index = hookCursor;
    hookCursor += 1;
    if (!owner.filled.has(index)) {
      owner.slots[index] = { current: initial === undefined ? null : initial };
      owner.filled.add(index);
    }
    return owner.slots[index];
  },
  useEffect: (callback, deps) => {
    const index = effectCursor;
    effectCursor += 1;
    const before = activeState.deps[index];
    const changed = before === undefined
      || !Array.isArray(deps)
      || deps.length !== before.length
      || deps.some((value, position) => !Object.is(value, before[position]));
    if (!changed) return;
    activeState.deps[index] = deps || [];
    pendingEffects.push({ state: activeState, index, callback });
  },
};

/** Point every `ref` prop at the shim's persistent stage element. */
function assignRefs(node) {
  if (!node || typeof node !== 'object') return;
  if (node.props && node.props.ref && typeof node.props.ref === 'object') node.props.ref.current = stageElement;
  for (const child of node.children || []) assignRefs(child);
}

/**
 * Render one element the way React does: a function type is called with its
 * props and its own hook state, and any component it returns is rendered in
 * place, so a registered wrapper resolves to the markup inside it.
 * @param {object} element - the element to render.
 * @returns {object} the rendered tree.
 */
function renderNode(element) {
  if (element === null || typeof element !== 'object') return element;
  if (typeof element.type !== 'function') {
    element.children = (element.children || []).map((child) => renderNode(child));
    return element;
  }
  activeState = stateFor(element.type);
  hookCursor = 0;
  effectCursor = 0;
  return renderNode(element.type(element.props));
}

/**
 * Render one element and commit it: refs attach, changed effects run after
 * their previous cleanup, exactly as a React commit orders them.
 * @param {object} element - the element to render.
 * @returns {object} the rendered tree.
 */
function commit(element) {
  pendingEffects = [];
  const tree = renderNode(element);
  assignRefs(tree);
  const queued = pendingEffects;
  pendingEffects = [];
  for (const effect of queued) {
    const previous = effect.state.cleanups.get(effect.index);
    if (typeof previous === 'function') previous();
    const cleanup = effect.callback();
    effect.state.cleanups.set(effect.index, typeof cleanup === 'function' ? cleanup : null);
  }
  return tree;
}

/** Run every mounted component's live cleanups, as unmounting them does. */
function unmountAll() {
  for (const state of componentStates.values()) {
    for (const cleanup of state.cleanups.values()) if (typeof cleanup === 'function') cleanup();
    state.cleanups.clear();
  }
}

/** Depth-first walk over the shim's node tree. */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) {
    if (child && typeof child === 'object' && child.type) walk(child, visit);
    else if (typeof child === 'string') visit({ type: '#text', props: { text: child }, children: [] });
  }
}

/** All nodes of one tag in a tree. */
function findAll(tree, tag) {
  const found = [];
  walk(tree, (node) => { if (node.type === tag) found.push(node); });
  return found;
}

/** Flat text content of a tree. */
function textOf(tree) {
  let text = '';
  walk(tree, (node) => {
    if (node.type === '#text') text += node.props.text;
    if (node.type === 'img') text += `[img ${node.props.src}]`;
  });
  return text;
}

/** Read the translate/scale the canvas image is drawn with. */
function viewOf(tree) {
  const image = findAll(tree, 'img')[0];
  if (image === undefined) return null;
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(image.props.style.transform);
  if (match === null) return null;
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

/** Wait for one condition, with a bounded number of ticks. */
async function until(condition, label, ticks) {
  for (let attempt = 0; attempt < (ticks || 60); attempt += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  ok(false, label, `condition never became true`);
  return false;
}

// ── Route server ────────────────────────────────────────────────────────────

const state = {
  canvas: null,
  calls: [],
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
};

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  state.calls.push(`${request.method} ${url.pathname}${url.search}`);
  if (url.pathname === '/pen/state' && request.method === 'GET') {
    const body = JSON.stringify({ ok: true, canvas: state.canvas });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
    return;
  }
  if (url.pathname === '/pen/state' && request.method === 'POST') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.action === 'create') {
        state.canvas = {
          name: 'canvas', width: body.width, height: body.height, background: body.background,
          operations: 0, revision: 1, empty: true,
        };
      } else if (body.action === 'clear' && state.canvas) {
        state.canvas = Object.assign({}, state.canvas, { operations: 0, empty: true, revision: state.canvas.revision + 1 });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (url.pathname === '/pen/image') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(state.png);
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: false, error: 'nope' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// The panel calls same-origin relative URLs; route them to the test server and
// stub the browser APIs the export path and the stylesheet touch.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => nativeFetch(typeof input === 'string' ? origin + input : input, init);
const createdObjects = [];
globalThis.URL.createObjectURL = (blob) => {
  const url = `blob:test/${createdObjects.length}`;
  createdObjects.push({ url, blob });
  return url;
};
globalThis.URL.revokeObjectURL = () => {};
const anchors = [];
const headChildren = [];
globalThis.document = {
  body: { appendChild: (node) => anchors.push(node) },
  head: {
    appendChild: (node) => headChildren.push(node),
    removeChild: (node) => { const at = headChildren.indexOf(node); if (at >= 0) headChildren.splice(at, 1); },
  },
  createElement: (tag) => {
    if (tag === 'a') return { tagName: 'a', clicked: false, click() { this.clicked = true; }, remove() {} };
    if (tag === 'style') return { tagName: 'style', textContent: '', remove() { const at = headChildren.indexOf(this); if (at >= 0) headChildren.splice(at, 1); } };
    return { tagName: tag };
  },
};
/** Resize observers the panel created, so the test can drive a column resize. */
const observers = [];
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() { const at = observers.indexOf(this); if (at >= 0) observers.splice(at, 1); }
};

try {
  // ── Load the generated bundle through the published protocol ──────────────
  let registration = null;
  globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry; } } };
  // eslint-disable-next-line no-new-func -- the bundle is a plain classic script.
  new Function(bundleSource)();
  ok(registration !== null, 'the bundle registers a factory through __ModuleLoader__');
  ok(registration.id === '@local/dsh-pen', 'the factory id matches the package name', registration && registration.id);
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return reactShim;
    throw new Error(`unexpected require("${specifier}")`);
  });
  ok(plugin && typeof plugin.apply === 'function', 'the factory returns a plugin with apply()');
  ok(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), 'the plugin injects the slot service');

  // ── Registration surface ──────────────────────────────────────────────────
  //
  // The right Sidebar is stubbed at its published face: a tab-type registry, the
  // navigation controller, and the open-tab inventory the toggle subscribes to.
  const registrations = [];
  const sections = [];
  const disposers = [];
  const tabTypes = [];
  const guideEntries = [];
  const sidebarState = { rows: [], expanded: false, active: null, opened: [], closed: [] };
  const inventoryListeners = new Set();
  const publish = () => { for (const listener of inventoryListeners) listener(); };
  const sidebar = {
    openTabs: {
      getSnapshot: () => sidebarState.rows,
      subscribe: (listener) => { inventoryListeners.add(listener); return () => inventoryListeners.delete(listener); },
    },
    isExpanded: () => sidebarState.expanded,
    active: () => (sidebarState.active === null ? undefined : { id: sidebarState.active, kind: 'pen' }),
    openTab: (kind) => { sidebarState.opened.push(kind); },
    close: (tabId) => { sidebarState.closed.push(tabId); },
  };
  const sidebarRightTabs = {
    register: (definition) => {
      tabTypes.push(definition);
      for (const entry of definition.guide || []) guideEntries.push(entry);
      return () => {};
    },
  };
  const ctx = {
    effect: (callback, label) => { const dispose = callback(); if (typeof dispose === 'function') disposers.push({ label, dispose }); return () => {}; },
    locale: {
      register: (namespace, dictionaries) => { sections.push({ namespace, dictionaries }); return () => {}; },
      bind: () => (key) => (sections[0] && sections[0].dictionaries.en[key]) || key,
    },
    slots: {
      inject: (owner, callback) => { callback(); },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
    inject: (services, callback) => {
      ok(services.includes('sidebarRight') && services.includes('sidebarRightTabs'),
        'the sidebar seats wait for the right-Sidebar services', services.join(', '));
      callback(Object.assign({}, ctx, { sidebarRight: sidebar, sidebarRightTabs }));
    },
  };
  plugin.apply(ctx);

  ok(sections.length === 1 && sections[0].namespace === 'penCanvas', 'the panel registers its own dictionary namespace');
  ok(sections[0].dictionaries.zh && sections[0].dictionaries.en, 'the dictionary carries both locales');
  ok(headChildren.length === 1, 'apply installs exactly one stylesheet', String(headChildren.length));
  ok(headChildren[0].textContent.includes('.dsh-pen-stage'), 'the stylesheet carries the panel rules');

  ok(tabTypes.length === 1, 'exactly one right-Sidebar tab type is registered', String(tabTypes.length));
  ok(tabTypes[0].id === '@local/dsh-pen', 'the tab type registers under the package id', tabTypes[0].id);
  ok(tabTypes[0].kind === 'pen', 'the tab type owns the "pen" kind', tabTypes[0].kind);
  ok(typeof tabTypes[0].title === 'function' && tabTypes[0].title() === 'Canvas', 'the tab chip title is localized lazily');
  ok(tabTypes[0].patterns === undefined, 'the type is a page type, opened by kind rather than by address');
  ok(guideEntries.length === 1 && guideEntries[0].title() === 'Canvas', 'the guide offers one entry that opens the page');

  ok(registrations.length === 2, 'two slot entries are registered', String(registrations.length));
  const bodyEntry = registrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab');
  const toggleEntry = registrations.find((entry) => entry.options.name === 'conversation.input.right');
  ok(bodyEntry !== undefined, 'the canvas panel registers a right-Sidebar body');
  ok(bodyEntry.options.key === '@local/dsh-pen', 'the body cell is keyed by the tab definition id', bodyEntry.options.key);
  ok(bodyEntry.options.locale === 'penCanvas', 'the body receives the panel dictionary');
  ok(typeof bodyEntry.component === 'function', 'the body component is a function');
  ok(toggleEntry !== undefined, 'the composer toggle registers in the tool row');
  ok(toggleEntry.options.id === 'pen-canvas-toggle', 'the toggle id is stable', toggleEntry.options.id);
  ok(toggleEntry.options.order === 30, 'the toggle sorts past the shipped compact controls', String(toggleEntry.options.order));
  ok(registrations.every((entry) => entry.options.name !== 'conversation.input.dock'),
    'nothing is drawn above the composer any more');

  // ── Render the panel with no canvas: the empty state and the create form ──
  const translator = (key) => sections[0].dictionaries.en[key] || key;
  const panelElement = { type: bodyEntry.component, props: { sessionId: 'session-1', t: translator } };
  let rendered = commit(panelElement);
  const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); };
  const look = () => { rendered = commit(panelElement); return textOf(rendered); };
  const buttons = () => { rendered = commit(panelElement); return findAll(rendered, 'button'); };
  const stage = () => { rendered = commit(panelElement); return findAll(rendered, 'div').find((node) => node.props.className === 'dsh-pen-stage'); };

  ok(textOf(rendered).includes('Checking for a canvas'), 'the first frame shows the loading state', textOf(rendered));
  await flush();
  ok(look().includes('No canvas in this session yet'), 'the empty state arrives after the first poll', look());
  ok(state.calls.some((call) => call.startsWith('GET /pen/state')), 'the panel polls the state route', state.calls.join(' | '));
  ok(findAll(rendered, 'img').length === 0, 'no canvas means no image');

  buttons().find((node) => node.props.title === 'New canvas').props.onClick();
  rendered = commit(panelElement);
  ok(findAll(rendered, 'button').every((node) => typeof node.props.onClick === 'function'), 'every panel control is a real button');
  const inputs = findAll(rendered, 'input');
  ok(inputs.length === 3, 'the create form offers width, height, and background', String(inputs.length));
  const widthInput = inputs.find((node) => node.props.type === 'number');
  ok(widthInput.props.value === 1024, 'the width field starts at the default', String(widthInput.props.value));

  const form = findAll(rendered, 'form')[0];
  ok(form !== undefined, 'the create form is rendered');
  form.props.onSubmit({ preventDefault() {} });
  await until(() => state.canvas !== null, 'submitting the form creates the canvas');
  ok(state.canvas.width === 1024 && state.canvas.height === 768, 'the canvas uses the submitted size', JSON.stringify(state.canvas));
  await until(() => look().includes('The canvas is ready'), 'an empty canvas stops asking for one');
  ok(look().includes('The canvas is ready'), 'an empty canvas reports that it is ready to draw on', look());

  // ── A canvas with content: the image, its fitted view, and the actions ────
  state.canvas = { name: 'sketch', width: 640, height: 480, background: '#ffffff', operations: 3, revision: 7, empty: false };
  await until(() => { look(); return findAll(rendered, 'img').length > 0; }, 'a painted canvas renders an image');
  look();
  const image = findAll(rendered, 'img')[0];
  ok(image.props.src.includes('mode=preview') && image.props.src.includes('rev=7'), 'the image URL carries the revision', image.props.src);
  ok(image.props.src.includes('session=session-1'), 'the image URL carries the session', image.props.src);
  ok(textOf(rendered).includes('640×480') && textOf(rendered).includes('3 operations'), 'the status line reports size and operations', textOf(rendered));
  ok(image.props.style.width === '640px' && image.props.style.height === '480px', 'the image is laid out at the canvas pixel size');

  // Fit: canvas 640x480 in a 640x420 stage pads 16px and centers.
  const fitted = viewOf(rendered);
  const fitScale = Math.min((STAGE_BOX.width - 32) / 640, (STAGE_BOX.height - 32) / 480, 1);
  near(fitted.scale, fitScale, 0.0005, 'a painted canvas opens fitted to the stage');
  near(fitted.x, (STAGE_BOX.width - 640 * fitScale) / 2, 0.0005, 'the fitted view is centered horizontally');
  near(fitted.y, (STAGE_BOX.height - 480 * fitScale) / 2, 0.0005, 'the fitted view is centered vertically');

  const exportButton = buttons().find((node) => node.props.title === 'Export PNG');
  ok(exportButton !== undefined, 'the panel offers an export-PNG control');
  exportButton.props.onClick();
  await until(() => anchors.length > 0, 'exporting downloads a file');
  ok(anchors[0].download === 'sketch-640x480.png', 'the download keeps a readable file name', anchors[0].download);
  ok(anchors[0].clicked === true, 'the download anchor is clicked');
  ok(state.calls.some((call) => call.includes('/pen/image') && call.includes('mode=full')), 'export fetches the full-resolution image', state.calls.join(' | '));

  // ── Wheel zoom: the pixel under the pointer stays under it ────────────────
  const wheel = stageElement.listeners.get('wheel');
  ok(typeof wheel === 'function', 'the stage consumes the wheel itself (a passive React handler could not)');
  const before = viewOf(rendered);
  const pointer = { x: 100, y: 100 };
  wheel({
    deltaY: -120, deltaMode: 0, clientX: pointer.x, clientY: pointer.y,
    preventDefault() { this.prevented = true; },
  });
  look();
  const zoomed = viewOf(rendered);
  ok(zoomed.scale > before.scale, 'wheeling up zooms in', `${before.scale} -> ${zoomed.scale}`);
  near((pointer.x - zoomed.x) / zoomed.scale, (pointer.x - before.x) / before.scale, 0.001,
    'the canvas pixel under the pointer does not move while zooming');
  near(zoomed.scale, before.scale * Math.exp(120 * 0.0015), 0.0005, 'one wheel notch applies the panel factor');

  wheel({ deltaY: 240, deltaMode: 0, clientX: pointer.x, clientY: pointer.y, preventDefault() {} });
  look();
  ok(viewOf(rendered).scale < zoomed.scale, 'wheeling down zooms out', `${zoomed.scale} -> ${viewOf(rendered).scale}`);

  // ── Buttons: zoom in, back to 1:1, and fit again ──────────────────────────
  buttons().find((node) => node.props.title === 'Zoom in').props.onClick();
  look();
  const stepped = viewOf(rendered);
  near(stepped.scale, viewOf(rendered).scale, 0.0001, 'the readout reads the live scale');
  ok(textOf(rendered).includes(`${Math.round(stepped.scale * 100)}%`), 'the readout shows the percentage', textOf(rendered));

  buttons().find((node) => node.props.title === 'Actual size').props.onClick();
  look();
  near(viewOf(rendered).scale, 1, 0.0005, 'the readout button returns the canvas to 1:1');

  buttons().find((node) => node.props.title === 'Fit to view').props.onClick();
  look();
  near(viewOf(rendered).scale, fitScale, 0.0005, 'the fit control restores the fitted view');

  // ── Drag to pan, clamped so the canvas cannot be lost ─────────────────────
  const stageNode = stage();
  const dragStart = viewOf(rendered);
  stageNode.props.onPointerDown({ button: 0, pointerId: 7, clientX: 200, clientY: 200, currentTarget: stageElement, preventDefault() {} });
  stageNode.props.onPointerMove({ pointerId: 7, clientX: 260, clientY: 230, currentTarget: stageElement, preventDefault() {} });
  look();
  const dragged = viewOf(rendered);
  near(dragged.x - dragStart.x, 60, 0.0005, 'dragging right moves the canvas right');
  near(dragged.y - dragStart.y, 30, 0.0005, 'dragging down moves the canvas down');
  ok(stageNode.props['data-panning'] === 'true' || stage().props['data-panning'] === 'true', 'the cursor switches to the panning state');

  stageNode.props.onPointerMove({ pointerId: 7, clientX: 90000, clientY: 200, currentTarget: stageElement, preventDefault() {} });
  look();
  ok(viewOf(rendered).x <= STAGE_BOX.width - 48 + 0.001, 'panning cannot push the canvas out of the viewport', String(viewOf(rendered).x));

  stageNode.props.onPointerUp({ pointerId: 7, clientX: 90000, clientY: 200, currentTarget: stageElement, preventDefault() {} });
  look();
  ok(stage().props['data-panning'] === 'false', 'releasing the pointer ends the pan');

  stageNode.props.onPointerMove({ pointerId: 7, clientX: 100, clientY: 100, currentTarget: stageElement, preventDefault() {} });
  look();
  ok(viewOf(rendered).x <= STAGE_BOX.width - 48 + 0.001, 'a pointer that never pressed cannot pan');

  // ── Resizing the column refits, until the user takes over the view ────────
  buttons().find((node) => node.props.title === 'Fit to view').props.onClick();
  look();
  stageElement.box = { left: 0, top: 0, width: 360, height: 500 };
  const observer = observers[observers.length - 1];
  ok(observer !== undefined, 'the panel observes its own box for resizes');
  observer.callback();
  look();
  const refitted = viewOf(rendered);
  near(refitted.scale, Math.min((360 - 32) / 640, (500 - 32) / 480, 1), 0.0005, 'a column resize refits the canvas');
  stageElement.box = Object.assign({}, STAGE_BOX);

  // ── The composer toggle drives the column ─────────────────────────────────
  //
  // It mounts with no pen tab open and a canvas already on the server, so its
  // first check reveals the panel without the user hunting for it.
  const toggleElement = { type: toggleEntry.component, props: { sessionId: 'session-1', t: translator } };
  let toggleTree = commit(toggleElement);
  await until(() => sidebarState.opened.length > 0, 'a canvas that appears while the tab is closed is revealed once');
  ok(sidebarState.opened[0] === 'pen', 'the reveal opens the pen page', sidebarState.opened.join(', '));
  ok(findAll(toggleTree, 'button')[0].props['data-open'] === 'false', 'the toggle starts unpressed');

  sidebarState.rows = [{ sessionId: 'session-1', tabId: 'tab-1', kind: 'pen', contentId: 'sidebar://pen' }];
  sidebarState.expanded = true;
  sidebarState.active = 'tab-1';
  publish();
  toggleTree = commit(toggleElement);
  ok(findAll(toggleTree, 'button')[0].props['data-open'] === 'true', 'the toggle lights up while the pen tab is open');

  findAll(toggleTree, 'button')[0].props.onClick();
  ok(sidebarState.closed.includes('tab-1'), 'clicking the toggle while the panel is in front closes it', sidebarState.closed.join(', '));

  sidebarState.rows = [];
  publish();
  toggleTree = commit(toggleElement);
  findAll(toggleTree, 'button')[0].props.onClick();
  ok(sidebarState.opened.length === 2 && sidebarState.opened[1] === 'pen', 'clicking it again opens the panel', sidebarState.opened.join(', '));
  ok(toggleTree.props.className === 'dsh-pen-toggle', 'the toggle renders one compact control', String(toggleTree.props.className));

  // ── Failure handling ──────────────────────────────────────────────────────
  const failing = createServer((request, response) => { response.writeHead(500); response.end('boom'); });
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
  const goodOrigin = origin;
  globalThis.fetch = (input, init) => nativeFetch(typeof input === 'string' ? `http://127.0.0.1:${failing.address().port}${input}` : input, init);
  await until(() => look().includes('canvas state request failed'), 'a failing route surfaces an inline error');
  globalThis.fetch = (input, init) => nativeFetch(typeof input === 'string' ? goodOrigin + input : input, init);
  failing.close();
  // The panel keeps its last canvas while the route is down, and recovers with it.
  ok(findAll(rendered, 'img').length === 1, 'the panel keeps the last frame through a failure');

  // ── Clear, and disposal ───────────────────────────────────────────────────
  buttons().find((node) => node.props.title === 'Clear').props.onClick();
  await until(() => state.canvas.operations === 0, 'clearing empties the canvas');
  ok(state.canvas.revision === 8, 'clearing bumps the revision', String(state.canvas.revision));

  // The panel owns one poll timer while it is mounted; the cleanup it returns
  // must stop it, or a closed conversation would keep requesting state forever.
  unmountAll();
  await flush(); // let a request already in flight land before the baseline
  const callsBefore = state.calls.length;
  await new Promise((resolve) => setTimeout(resolve, POLL_SILENCE_MS));
  ok(state.calls.length === callsBefore, 'unmounting stops the panel poll', `${callsBefore} -> ${state.calls.length}`);

  for (const entry of disposers.reverse()) entry.dispose();
  ok(headChildren.length === 0, 'disposing the plugin removes its stylesheet', String(headChildren.length));
} finally {
  server.close();
}

// The panel's poll timer is cancelled above, but the export path's object-URL
// revocation timer belongs to the page and cannot be; the result is written
// synchronously and the run ends here instead of waiting for it.
writeSync(1, `\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures > 0 ? 1 : 0);
