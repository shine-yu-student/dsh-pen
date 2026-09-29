/**
 * Build the two artifacts the bundle ships from the one shared source.
 *
 * `lib/shared/*.js` contains the rasterizer, the PNG encoder, and the drawing
 * model. A model-facing image, the canvas panel's preview, and the exported
 * file must agree pixel for pixel, so one implementation paints all three:
 *
 *   - `lib/pen-shared.cjs` — a CommonJS module the Host `index.js` requires.
 *     Every pixel a screenshot, a preview, or an export carries comes from it.
 *   - `lib/client/pen-client.js` — the browser bundle `package.json`
 *     `dsh.client` points at. The panel is a viewer: it requests the Host's
 *     rendered PNGs, so the drawing sources stay out of the browser artifact.
 *
 * Run `node scripts/build.mjs` after editing anything under `lib/shared/` or
 * `lib/client-src/`.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Shared sources, in dependency order (raster before ops). */
const SHARED = ['raster.js', 'ops.js'];

const read = async (relative) => await readFile(join(root, relative), 'utf8');

/** Indent one generated block so the artifacts stay readable. */
const indent = (text, spaces) => text
  .split('\n')
  .map((line) => (line.length === 0 ? line : ' '.repeat(spaces) + line))
  .join('\n');

const sharedSources = [];
for (const name of SHARED) sharedSources.push(await read(join('lib', 'shared', name)));

// ── Host module ─────────────────────────────────────────────────────────────
const hostExpression = [
  "'use strict';",
  'const PEN = {};',
  ...sharedSources.map((source) => `(function (globalThis) {\n${source}\n})({ DSH_PEN: PEN });`),
  'return PEN;',
].join('\n');

const hostModule = `/**
 * GENERATED FILE — do not edit.
 *
 * Regenerate with \`node scripts/build.mjs\` from \`lib/shared/raster.js\` and
 * \`lib/shared/ops.js\`. It evaluates the shared sources in a private scope and
 * exports the two faces the Host half uses: the rasterizer and the drawing
 * model.
 *
 * @module dsh-pen/lib/pen-shared
 */
'use strict';

const PEN = new Function(${JSON.stringify(hostExpression)})();

module.exports = {
  raster: PEN.raster,
  ops: PEN.ops,
};
`;

await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib', 'pen-shared.cjs'), hostModule, 'utf8');

// ── Browser bundle ──────────────────────────────────────────────────────────
const factory = await read(join('lib', 'client-src', 'factory.js'));

const clientBundle = `/**
 * GENERATED FILE — do not edit.
 *
 * Regenerate with \`node scripts/build.mjs\` from \`lib/client-src/factory.js\`.
 * The panel renders the PNGs the Host served for the current revision, so the
 * drawing sources are deliberately absent from this artifact.
 *
 * The module table needs only \`react\`; every other asset is local.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-pen',
  factory(require) {
${indent(factory, 4)}
  },
});
`;

await mkdir(join(root, 'lib', 'client'), { recursive: true });
await writeFile(join(root, 'lib', 'client', 'pen-client.js'), clientBundle, 'utf8');

const bytes = (text) => Buffer.byteLength(text, 'utf8');
console.log(`lib/pen-shared.cjs        ${bytes(hostModule)} bytes`);
console.log(`lib/client/pen-client.js  ${bytes(clientBundle)} bytes`);
