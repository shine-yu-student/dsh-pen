/**
 * Host half of the `dsh-pen` bundle: the drawing canvas service behind the
 * model-facing pen tools and the browser route the canvas panel reads.
 *
 * Tools: `pen_create`, `pen_draw`, `pen_edit`, `pen_canvas`, `pen_screenshot`,
 * and `pen_export`. The canvas itself is a per-session, in-memory, ordered
 * operation list (the session log stays the record of *what was asked*) that
 * `pen_edit` restructures by index and the shared software rasterizer at
 * `./pen-shared.cjs` renders on demand, so a screenshot, the panel preview,
 * and an exported file are the same pixels.
 *
 * Every extension point is optional except `tools`: a profile without a web
 * server or attachment store still gets the drawing tools.
 *
 * @module @local/dsh-pen
 */

import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Host module bundle that inlines the shared rasterizer and drawing model. */
const require = createRequire(import.meta.url);
const { raster, ops } = require('./lib/pen-shared.cjs');

/** Model-facing tool names, in registration order. */
export const PEN_TOOLS = ['pen_create', 'pen_draw', 'pen_edit', 'pen_canvas', 'pen_screenshot', 'pen_export'];

/** Required service: without a tool registry this plugin has nothing to contribute. */
export const inject = ['tools'];

/** Defaults and bounds; a `cordis.patch.yml` config may tighten them. */
const DEFAULTS = {
  defaultWidth: ops.DEFAULTS.width,
  defaultHeight: ops.DEFAULTS.height,
  defaultBackground: ops.DEFAULTS.background,
  maxWidth: 2048,
  maxHeight: 2048,
  previewMaxWidth: 1400,
  quality: 2,
  maxOperations: 4000,
  routePrefix: '/pen',
  exportDirectory: '',
  promptSection: true,
};

/** Coerce one configured value, falling back to the default when unusable. */
const number = (value, fallback, minimum) => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return parsed;
};

/** Resolve the plugin config against the defaults and the hard rasterizer caps. */
function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const resolved = Object.assign({}, DEFAULTS);
  resolved.defaultWidth = Math.round(number(config.defaultWidth, DEFAULTS.defaultWidth, 16));
  resolved.defaultHeight = Math.round(number(config.defaultHeight, DEFAULTS.defaultHeight, 16));
  resolved.maxWidth = Math.round(number(config.maxWidth, DEFAULTS.maxWidth, 64));
  resolved.maxHeight = Math.round(number(config.maxHeight, DEFAULTS.maxHeight, 64));
  resolved.previewMaxWidth = Math.round(number(config.previewMaxWidth, DEFAULTS.previewMaxWidth, 128));
  resolved.quality = Math.round(number(config.quality, DEFAULTS.quality, 1));
  resolved.maxOperations = Math.round(number(config.maxOperations, DEFAULTS.maxOperations, 1));
  if (typeof config.defaultBackground === 'string' && config.defaultBackground.trim() !== '') {
    resolved.defaultBackground = config.defaultBackground.trim();
  }
  if (typeof config.routePrefix === 'string' && /^\/[A-Za-z0-9._~/-]*$/.test(config.routePrefix)) {
    resolved.routePrefix = config.routePrefix.replace(/\/+$/, '');
  }
  if (typeof config.exportDirectory === 'string' && config.exportDirectory.trim() !== '') {
    resolved.exportDirectory = config.exportDirectory.trim();
  }
  resolved.promptSection = config.promptSection !== false;
  return resolved;
}

/** The raw compressor the shared PNG encoder expects. */
const compressor = { deflate: (bytes) => zlib.deflateSync(bytes, { level: 9 }) };

/** `#rrggbb` for a color the rasterizer already accepted. */
function hexColor(value, fallback) {
  const rgba = raster.parseColor(value === undefined ? fallback : value, raster.parseColor(fallback));
  const part = (byte) => byte.toString(16).padStart(2, '0');
  return `#${part(rgba[0])}${part(rgba[1])}${part(rgba[2])}`;
}

/** Byte count as a short human string. */
function describeBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** A plain JSON-Schema object node. */
const objectSchema = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required && required.length > 0 ? { required } : {}),
});

/** The color schema reused by every paint field. */
const COLOR = { type: 'string', description: 'CSS color: #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), or a named color such as red.' };

/**
 * The drawing-operation union every operation-aware tool projects.
 * One `oneOf` branch per operation kind keeps the mistakes out of the model's
 * reach instead of failing them in the tool body.
 */
function operationSchema(description) {
  const shared = {
    brush: {
      type: 'string',
      enum: Object.keys(ops.BRUSHES),
      description: 'Stroke preset: ' + Object.keys(ops.BRUSHES).map((name) => `${name} (${ops.BRUSHES[name].description})`).join(', ') + '. Defaults to pen.',
    },
    color: COLOR,
    strokeWidth: { type: 'number', description: 'Stroke width in pixels; overrides the brush width.' },
    opacity: { type: 'number', description: 'Extra stroke opacity multiplier between 0 and 1.' },
    dash: {
      type: 'array',
      items: { type: 'number' },
      description: 'Even-length dash/ gap pattern in pixels, e.g. [10, 8]; overrides the brush pattern.',
    },
  };
  const closable = {
    closed: { type: 'boolean', description: 'Join the last point back to the first.' },
    fill: COLOR,
  };
  const strokeOf = (properties, required) => objectSchema(Object.assign({}, properties, shared), required);
  return {
    type: 'array',
    description: description || 'Drawing operations, painted in array order inside one call. Any number may be batched; independent batches can also run in parallel tool calls.',
    items: {
      oneOf: [
        strokeOf({
          kind: { type: 'string', const: 'line' },
          x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        }, ['kind', 'x1', 'y1', 'x2', 'y2']),
        strokeOf({
          kind: { type: 'string', const: 'polyline' },
          points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Vertices as [x, y] pairs, in order.' },
          ...closable,
        }, ['kind', 'points']),
        strokeOf({
          kind: { type: 'string', const: 'curve' },
          points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Control points as [x, y] pairs; the curve passes through all of them.' },
          tension: { type: 'number', description: 'Curve tightness from 0 (straight segments) to 1 (very loose); 0.5 is the default spline.' },
          ...closable,
        }, ['kind', 'points']),
        strokeOf({
          kind: { type: 'string', const: 'circle' },
          cx: { type: 'number' }, cy: { type: 'number' }, radius: { type: 'number' },
          fill: COLOR,
        }, ['kind', 'cx', 'cy', 'radius']),
        strokeOf({
          kind: { type: 'string', const: 'ellipse' },
          cx: { type: 'number' }, cy: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' },
          fill: COLOR,
        }, ['kind', 'cx', 'cy', 'rx', 'ry']),
        strokeOf({
          kind: { type: 'string', const: 'rect' },
          x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
          fill: COLOR,
        }, ['kind', 'x', 'y', 'width', 'height']),
        strokeOf({
          kind: { type: 'string', const: 'arc' },
          cx: { type: 'number' }, cy: { type: 'number' }, radius: { type: 'number' },
          startAngle: { type: 'number', description: 'Start angle in degrees, 0 = east, increasing clockwise.' },
          endAngle: { type: 'number', description: 'End angle in degrees.' },
          counterclockwise: { type: 'boolean', description: 'Sweep from start to end the short way round.' },
        }, ['kind', 'cx', 'cy', 'radius']),
        strokeOf({
          kind: { type: 'string', const: 'path' },
          d: { type: 'string', description: 'Mini path string with M/m, L/l, H/h, V/v, C/c, Q/q, and Z.' },
          fill: COLOR,
        }, ['kind', 'd']),
        objectSchema({
          kind: { type: 'string', const: 'fill' },
          points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Polygon vertices as [x, y] pairs.' },
          fill: COLOR,
        }, ['kind', 'points']),
        objectSchema({
          kind: { type: 'string', const: 'clear' },
        }, ['kind']),
      ],
    },
  };
}

/** Coordinates and stroke styles shared by both screenshot tools. */
const regionParameters = {
  x: { type: 'number', description: 'Left edge of the region in canvas pixels; defaults to 0.' },
  y: { type: 'number', description: 'Top edge of the region in canvas pixels; defaults to 0.' },
  width: { type: 'number', description: 'Region width in canvas pixels; defaults to the remaining canvas width.' },
  height: { type: 'number', description: 'Region height in canvas pixels; defaults to the remaining canvas height.' },
  maxWidth: { type: 'number', description: 'Maximum pixel width of the returned image; the region is downscaled to fit when needed.' },
};

/**
 * Output schemas, one per result shape. The registry asserts each schema
 * against the enforced JSON Schema subset at registration and validates the
 * body's value against it afterwards, so every returned field is declared
 * here — a text-only tool names just `text` instead of widening the image
 * schema with fields it never returns.
 */
const TEXT_OUTPUT = objectSchema({ text: { type: 'string' } }, ['text']);
const EXPORT_OUTPUT = objectSchema({ text: { type: 'string' }, path: { type: 'string' } }, ['text', 'path']);
const IMAGE_OUTPUT = objectSchema({
  text: { type: 'string' },
  width: { type: 'integer' },
  height: { type: 'integer' },
  image: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // An open node: the attachment store owns the reference's exact fields.
      attachment: { type: 'object', additionalProperties: true, description: 'Durable reference of the rendered PNG.' },
      width: { type: 'integer' },
      height: { type: 'integer' },
    },
    required: ['attachment', 'width', 'height'],
  },
}, ['text', 'image']);

/** Build one tool definition without importing the tool helper package. */
function defineTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    // Undeclared means exclusive: a call that replaces or wipes the canvas
    // must never share a scheduling group with a sibling that paints on it.
    ...(definition.isConcurrencySafe ? { isConcurrencySafe: definition.isConcurrencySafe } : {}),
    output: {
      schema: definition.output,
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: String(value.text) }];
        if (value.image && value.image.attachment) {
          blocks.push({ type: 'image', attachment: value.image.attachment });
        }
        return blocks;
      },
      presentationMeta: (_args, value) => ({ text: String(value.text) }),
    },
    async execute(args, exec) {
      return await definition.execute(validateArguments(definition.name, definition.parameters, args), exec);
    },
  };
}

/**
 * Validate arguments against the registered parameter schema before the body
 * runs, so a malformed call fails with the offending path rather than a
 * TypeError deep inside the rasterizer.
 * @param {string} toolName - the tool being called, for the error message.
 * @param {object} schema - the tool's JSON Schema.
 * @param {unknown} args - the model's arguments.
 * @returns {object} the validated arguments.
 */
function validateArguments(toolName, schema, args) {
  if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName}: arguments must be an object`);
  }
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      throw new Error(`${toolName}: unknown argument "${key}"`);
    }
  }
  for (const key of schema.required || []) {
    if (args[key] === undefined) throw new Error(`${toolName}: missing required argument "${key}"`);
  }
  return args;
}

/** The drawing guide appended to the system prompt while this plugin is mounted. */
const PROMPT_SECTION = `## Drawing canvas

The \`pen_*\` tools paint on a per-session raster canvas that keeps its strokes as an ordered list, and they can read it back. Paint order is list order: index 0 is painted first and sits underneath everything; each later stroke covers the earlier ones.

- Read the numbered strokes with \`pen_canvas { action: "list" }\` before changing a drawing.
- Change a drawing by editing it. \`pen_edit\` removes, replaces, inserts, and restacks strokes by index, and \`pen_draw\` takes \`at\` to paint a new batch underneath the strokes already there. Every stroke an edit does not touch keeps its exact pixels, so never call \`pen_create\` or clear the canvas to fix a detail, and never repaint strokes that are already right.
- Prefer one \`pen_draw\` call with many operations, and independent \`pen_draw\` calls for independent parts of a drawing: they may run in parallel. \`pen_create\`, \`pen_edit\`, and a clearing \`pen_canvas\` are scheduled exclusively, so a message that creates and paints still creates first.
- Coordinates are canvas pixels with the origin at the top-left and y growing downward. Strokes are centered on their path, so keep them at least half a stroke width inside the canvas edges.
- The user sees the canvas live in the right sidebar's "画笔/Canvas" tab (wheel zooms, drag pans; a compact pen button in the composer opens it) and can export it as a PNG there. Call \`pen_screenshot\` when you need to see the result yourself, and again after an edit.`;

/**
 * Register the pen tools, the browser route, and the prompt guidance.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {object} rawConfig - the row's `config`, already validated by the Loader.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  /** @type {Map<string, object>} one canvas per session id, insertion-ordered for eviction. */
  const canvases = new Map();

  /** The canvas for a session, or undefined before `pen_create`. */
  const canvasOf = (sessionId) => canvases.get(sessionId);

  /** Create (or replace) one session's canvas. */
  const createCanvas = (sessionId, request) => {
    const width = Math.round(number(request.width, config.defaultWidth, 1));
    const height = Math.round(number(request.height, config.defaultHeight, 1));
    if (width < 16 || height < 16) throw new Error('canvas width and height must be at least 16 pixels');
    if (width > config.maxWidth || height > config.maxHeight) {
      throw new Error(`canvas ${width}x${height} exceeds the ${config.maxWidth}x${config.maxHeight} maximum`);
    }
    const background = hexColor(request.background, config.defaultBackground);
    const name = typeof request.name === 'string' && request.name.trim() !== ''
      ? request.name.trim().slice(0, 120)
      : 'canvas';
    const canvas = {
      sessionId,
      name,
      width,
      height,
      background,
      operations: [],
      revision: 0,
      render: null,
      preview: null,
    };
    canvases.delete(sessionId);
    canvases.set(sessionId, canvas);
    evictCanvases();
    return canvas;
  };

  /** Keep at most 32 sessions' canvases; the oldest untouched one goes first. */
  const evictCanvases = () => {
    while (canvases.size > 32) {
      const oldest = canvases.keys().next();
      if (oldest.done) return;
      canvases.delete(oldest.value);
    }
  };

  /** Render (or reuse) one canvas at full size. */
  const fullImage = (canvas) => {
    if (canvas.render && canvas.render.revision === canvas.revision) return canvas.render;
    const built = renderImage(canvas, canvas.width, canvas.height);
    canvas.render = Object.assign({ revision: canvas.revision }, built);
    return canvas.render;
  };

  /**
   * Render (or reuse) the panel preview: the full canvas, capped in width.
   * @param {object} canvas - the session canvas.
   * @returns {{png: Uint8Array, width: number, height: number}} preview bytes and size.
   */
  const previewImage = (canvas) => {
    if (canvas.preview && canvas.preview.revision === canvas.revision) return canvas.preview;
    if (canvas.width <= config.previewMaxWidth) {
      const full = fullImage(canvas);
      canvas.preview = Object.assign({ revision: canvas.revision }, full);
      return canvas.preview;
    }
    const ratio = config.previewMaxWidth / canvas.width;
    const built = renderImage(canvas, config.previewMaxWidth, Math.max(1, Math.round(canvas.height * ratio)));
    canvas.preview = Object.assign({ revision: canvas.revision }, built);
    return canvas.preview;
  };

  /**
   * Paint one canvas and encode it at (at most) a requested size.
   * @param {object} canvas - the source canvas.
   * @param {number} outWidth - target pixel width; clamped to the canvas width.
   * @param {number} outHeight - target pixel height; clamped to the canvas height.
   * @returns {{png: Uint8Array, rgba: Uint8Array, width: number, height: number}} the image.
   */
  function renderImage(canvas, outWidth, outHeight) {
    const width = Math.max(1, Math.min(canvas.width, Math.round(outWidth)));
    const height = Math.max(1, Math.min(canvas.height, Math.round(outHeight)));
    const surface = ops.renderOperations({
      width: canvas.width,
      height: canvas.height,
      background: canvas.background,
      quality: config.quality,
    }, canvas.operations);
    if (width === canvas.width && height === canvas.height) {
      const rgba = surface.getRGBA();
      return { png: raster.encodePNG(surface, compressor), rgba: rgba, width: width, height: height };
    }
    const rgba = raster.downsample(surface, width, height);
    const view = raster.surfaceFromRGBA(width, height, rgba);
    return { png: raster.encodePNG(view, compressor), rgba: rgba, width: width, height: height };
  }

  /**
   * Crop a region out of an already-rendered image.
   * @param {{rgba: Uint8Array, width: number, height: number}} image - a rendered image.
   * @param {{x: number, y: number, width: number, height: number}} region - region in canvas pixels.
   * @param {number} canvasWidth - the source canvas width, for region scaling.
   * @param {number} canvasHeight - the source canvas height.
   * @returns {{png: Uint8Array, width: number, height: number, region: object}} the crop.
   */
  function cropImage(image, region, canvasWidth, canvasHeight) {
    const scaleX = image.width / canvasWidth;
    const scaleY = image.height / canvasHeight;
    const x0 = Math.max(0, Math.min(image.width - 1, Math.round(region.x * scaleX)));
    const y0 = Math.max(0, Math.min(image.height - 1, Math.round(region.y * scaleY)));
    const x1 = Math.max(x0 + 1, Math.min(image.width, Math.round((region.x + region.width) * scaleX)));
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.round((region.y + region.height) * scaleY)));
    const width = x1 - x0;
    const height = y1 - y0;
    const bytes = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceStart = ((y0 + y) * image.width + x0) * 4;
      bytes.set(image.rgba.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
    }
    const surface = raster.surfaceFromRGBA(width, height, bytes);
    return {
      png: raster.encodePNG(surface, compressor),
      width: width,
      height: height,
      region: { x: x0 / scaleX, y: y0 / scaleY, width: width / scaleX, height: height / scaleY },
    };
  }

  /** Session id a tool call belongs to. */
  const sessionOf = (exec) => {
    const id = exec && exec.agent && exec.agent.id;
    if (typeof id !== 'string' || id === '') {
      throw new Error('pen: this tool needs a session-bound agent; call it from a normal session');
    }
    return id;
  };

  /** The canvas a tool call targets, refusing when none was created yet. */
  const requireCanvas = (exec) => {
    const sessionId = sessionOf(exec);
    const canvas = canvasOf(sessionId);
    if (!canvas) throw new Error('pen: no canvas for this session yet — call pen_create first');
    return canvas;
  };

  /** Bump the revision and drop both cached renders. */
  const markDirty = (canvas) => {
    canvas.revision += 1;
    canvas.render = null;
    canvas.preview = null;
  };

  /** The status line shared by tool results and the panel header. */
  const describeCanvas = (canvas) => `${canvas.name} ${canvas.width}x${canvas.height}px, background ${canvas.background}, `
    + `${canvas.operations.length} operation(s), revision ${canvas.revision}`;

  /**
   * Resolve a requested region against one canvas.
   * @param {object} canvas - the source canvas.
   * @param {object} request - tool arguments carrying x/y/width/height/maxWidth.
   * @returns {{x: number, y: number, width: number, height: number}} a clamped region.
   */
  const resolveRegion = (canvas, request) => {
    const x = Math.max(0, Math.min(canvas.width - 1, number(request.x, 0, -Infinity)));
    const y = Math.max(0, Math.min(canvas.height - 1, number(request.y, 0, -Infinity)));
    const width = Math.max(1, Math.min(canvas.width - x, number(request.width, canvas.width - x, 1)));
    const height = Math.max(1, Math.min(canvas.height - y, number(request.height, canvas.height - y, 1)));
    return { x, y, width, height };
  };

  /**
   * Commit one PNG to the attachment store and produce the tool's image block.
   * @param {object} exec - the tool run context.
   * @param {Uint8Array} png - encoded image bytes.
   * @param {string} name - attachment display name.
   * @returns {Promise<object>} the `image` field of the tool result value.
   */
  const attachImage = async (exec, png, name) => {
    const attachments = ctx.get('attachments');
    if (!attachments) {
      throw new Error('pen: no attachment service is mounted, so the rendered image cannot be returned');
    }
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name });
    return { attachment: ref, width: ref.width, height: ref.height };
  };

  // ── Tools ────────────────────────────────────────────────────────────────

  const createTool = defineTool({
    name: 'pen_create',
    output: TEXT_OUTPUT,
    description: 'Create a drawing canvas of an exact pixel size for this session, replacing any previous canvas. '
      + 'Call this before the first pen_draw; the canvas then appears in the right sidebar\'s canvas panel.',
    parameters: objectSchema({
      width: { type: 'number', description: `Canvas width in pixels (default ${DEFAULTS.defaultWidth}).` },
      height: { type: 'number', description: `Canvas height in pixels (default ${DEFAULTS.defaultHeight}).` },
      background: { type: 'string', description: 'Canvas background color; defaults to white.' },
      name: { type: 'string', description: 'Short label shown in the canvas panel, e.g. "logo sketch".' },
    }, []),
    async execute(args, exec) {
      const canvas = createCanvas(sessionOf(exec), args);
      return { text: `Created ${describeCanvas(canvas)}. The canvas is empty.` };
    },
  });

  const drawTool = defineTool({
    name: 'pen_draw',
    output: TEXT_OUTPUT,
    description: 'Paint a batch of drawing operations on this session\'s canvas in one call. '
      + 'Operations are applied in array order; independent pen_draw calls in the same message may run in parallel. '
      + 'Nothing is painted if any single operation is invalid.',
    parameters: objectSchema({
      operations: operationSchema(),
      at: {
        type: 'number',
        description: 'Insert the batch at this 0-based operation index instead of appending it; 0 paints underneath every stroke already on the canvas.',
      },
    }, ['operations']),
    // One batch splices between two awaits, so sibling calls of a step cannot
    // interleave inside it; a `clear` operation is atomic for the same reason.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const canvas = requireCanvas(exec);
      const normalized = ops.normalizeOperations(args.operations);
      const at = args.at;
      let insertAt = null;
      if (at !== undefined) {
        if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at > canvas.operations.length) {
          throw new Error(`pen_draw: at must be an integer between 0 and ${canvas.operations.length} (the current operation count)`);
        }
        if (normalized.some((operation) => operation.kind === 'clear')) {
          throw new Error('pen_draw: at cannot insert a clear operation; clear the canvas first, or draw without at');
        }
        insertAt = at;
      }
      if (canvas.operations.length + normalized.length > config.maxOperations) {
        throw new Error(`pen: this canvas already holds ${canvas.operations.length} operations; at most ${config.maxOperations} fit — remove some with pen_edit, clear it, or start a new canvas`);
      }
      let painted = 0;
      const summaries = [];
      for (let index = 0; index < normalized.length; index += 1) {
        const operation = normalized[index];
        if (operation.kind === 'clear') {
          canvas.operations.length = 0;
          painted = 0;
          summaries.length = 0;
          continue;
        }
        const target = insertAt === null ? canvas.operations.length : insertAt + painted;
        canvas.operations.splice(target, 0, operation);
        painted += 1;
        if (summaries.length < 8) summaries.push(ops.describeOperation(operation));
      }
      markDirty(canvas);
      const tail = summaries.length < painted ? `, … ${painted - summaries.length} more` : '';
      const where = insertAt === null ? '' : ` at ${insertAt}`;
      return {
        text: `Painted ${painted} operation(s)${where} on ${describeCanvas(canvas)}: ${summaries.join('; ')}${tail}. `
          + 'Call pen_screenshot to see the result.',
      };
    },
  });

  const canvasTool = defineTool({
    name: 'pen_canvas',
    output: TEXT_OUTPUT,
    description: 'Read this session\'s canvas, or clear it. '
      + 'The default status action reports size, revision, and operation count; list prints the numbered strokes in paint order (index 0 is underneath); clear wipes the canvas without starting a new one.',
    parameters: objectSchema({
      action: {
        type: 'string',
        enum: ['status', 'list', 'clear'],
        description: 'status (default) reports the canvas; list prints the numbered operations in paint order; clear erases every operation but keeps the size.',
      },
      from: { type: 'number', description: 'list only: first operation index to print (default 0).' },
      limit: { type: 'number', description: 'list only: maximum operations to print (default 40, at most 200).' },
    }, []),
    // Reporting and listing share a group with anything; wiping the canvas does not.
    isConcurrencySafe: (args) => !(args && args.action === 'clear'),
    async execute(args, exec) {
      const action = args.action === undefined ? 'status' : args.action;
      if (action === 'clear') {
        const canvas = requireCanvas(exec);
        canvas.operations.length = 0;
        markDirty(canvas);
        return { text: `Cleared ${describeCanvas(canvas)}.` };
      }
      const canvas = requireCanvas(exec);
      if (action === 'list') {
        const total = canvas.operations.length;
        const from = args.from === undefined ? 0 : args.from;
        const limit = args.limit === undefined ? 40 : args.limit;
        if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
          throw new Error('pen_canvas: from must be a non-negative integer');
        }
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
          throw new Error('pen_canvas: limit must be a positive integer');
        }
        const shown = canvas.operations.slice(from, from + Math.min(limit, 200));
        const footer = shown.length === 0
          ? `No operations at ${from}-${from + Math.min(limit, 200) - 1}; the canvas holds ${total} operation(s).`
          : `Showing ${from}-${from + shown.length - 1} of ${total}. pen_edit removes, replaces, inserts, and restacks by index; pen_draw with at inserts underneath.`;
        return {
          text: `Operations of ${canvas.name} (${canvas.width}x${canvas.height}px) in paint order — 0 is underneath, the last is on top:\n`
            + shown.map((operation, offset) => `${from + offset}: ${ops.describeOperation(operation)}`).join('\n')
            + `\n${footer}`,
        };
      }
      return {
        text: `${describeCanvas(canvas)}. ${canvas.operations.length === 0 ? 'The canvas is empty.' : 'The canvas has painted content.'} `
          + 'Call pen_canvas with action "list" to read the numbered operations.',
      };
    },
  });

  /**
   * Validate one structural edit before anything is applied, so a batch that
   * names an impossible position leaves the canvas untouched.
   * @param {unknown} raw - one entry of the `edits` argument.
   * @param {number} index - position in the batch, for error messages.
   * @returns {object} the prepared edit.
   */
  const prepareEdit = (raw, index) => {
    const path = `edits[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`pen_edit: ${path} must be an object`);
    }
    for (const key of Object.keys(raw)) {
      if (key !== 'index' && key !== 'remove' && key !== 'operations' && key !== 'from' && key !== 'to') {
        throw new Error(`pen_edit: ${path} has unknown field "${key}"`);
      }
    }
    const splices = raw.index !== undefined || raw.remove !== undefined || raw.operations !== undefined;
    const moves = raw.from !== undefined || raw.to !== undefined;
    if (splices && moves) {
      throw new Error(`pen_edit: ${path} mixes index/remove/operations with from/to; give one shape per edit`);
    }
    if (moves) {
      if (raw.from === undefined || raw.to === undefined) throw new Error(`pen_edit: ${path} needs both from and to`);
      return { kind: 'move', from: raw.from, to: raw.to };
    }
    if (!splices) throw new Error(`pen_edit: ${path} needs index (with optional remove/operations) or from/to`);
    let inserted = [];
    if (raw.operations !== undefined) {
      try {
        inserted = ops.normalizeOperations(raw.operations);
      } catch (error) {
        throw new Error(`pen_edit: ${path}.operations: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const operation of inserted) {
        if (operation.kind === 'clear') {
          throw new Error(`pen_edit: ${path}.operations cannot contain a clear operation; remove the range instead, or clear the canvas with pen_canvas`);
        }
      }
    }
    if ((raw.remove === undefined || raw.remove === 0) && inserted.length === 0) {
      throw new Error(`pen_edit: ${path} changes nothing: give remove, operations, or both`);
    }
    return { kind: 'splice', index: raw.index, remove: raw.remove, inserted: inserted };
  };

  const editTool = defineTool({
    name: 'pen_edit',
    output: TEXT_OUTPUT,
    description: 'Edit this session\'s canvas in place by operation index: insert, remove, replace, or restack strokes. '
      + 'Every stroke the edit does not touch keeps its exact pixels, so a detail is fixed without repainting the picture. '
      + 'Paint order is list order (index 0 is underneath); read the numbered strokes with pen_canvas action "list" first.',
    parameters: objectSchema({
      edits: {
        type: 'array',
        description: 'Edits applied in array order; each index refers to the operation list as it stands when that edit runs.',
        items: {
          oneOf: [
            objectSchema({
              index: { type: 'number', description: '0-based splice position: 0 inserts underneath everything, the current operation count appends on top.' },
              remove: { type: 'number', description: 'How many operations starting at index to remove (default 0).' },
              operations: operationSchema('Operations to insert at index; they paint in array order, above the strokes before index and below the ones after it.'),
            }, ['index']),
            objectSchema({
              from: { type: 'number', description: '0-based index of the operation to restack.' },
              to: { type: 'number', description: '0-based destination after removal: 0 sends it underneath everything, the last index brings it to the top.' },
            }, ['from', 'to']),
          ],
        },
      },
    }, ['edits']),
    // An edit rewrites the shared operation list by index, so it is scheduled
    // alone: a sibling paint could shift the positions this call addresses.
    async execute(args, exec) {
      const canvas = requireCanvas(exec);
      const raw = args.edits;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('pen_edit: edits must be a non-empty array');
      if (raw.length > 200) throw new Error('pen_edit: at most 200 edits fit in one call');
      const prepared = raw.map(prepareEdit);
      let list = canvas.operations.slice();
      const summaries = [];
      try {
        for (let index = 0; index < prepared.length; index += 1) {
          const edit = prepared[index];
          const path = `edits[${index}]`;
          if (edit.kind === 'move') {
            list = ops.moveOperation(list, edit.from, edit.to, path);
            summaries.push(`moved ${edit.from} -> ${edit.to}`);
            continue;
          }
          list = ops.spliceOperations(list, edit.index, edit.remove, edit.inserted, path);
          const parts = [];
          if (edit.remove > 0) parts.push(`removed ${edit.remove} at ${edit.index}`);
          if (edit.inserted.length > 0) {
            const names = edit.inserted.slice(0, 3).map(ops.describeOperation).join('; ');
            const more = edit.inserted.length > 3 ? '; …' : '';
            parts.push(`inserted ${edit.inserted.length} at ${edit.index} (${names}${more})`);
          }
          summaries.push(parts.join(', '));
        }
      } catch (error) {
        throw new Error(`pen_edit: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (list.length > config.maxOperations) {
        throw new Error(`pen: the edit would leave ${list.length} operations; at most ${config.maxOperations} fit on one canvas`);
      }
      canvas.operations = list;
      markDirty(canvas);
      return {
        text: `Edited ${describeCanvas(canvas)}: ${summaries.join('; ')}. Call pen_screenshot to check the result.`,
      };
    },
  });

  /**
   * The pixel width one screenshot render may use: the canvas width, the
   * attachment store's own dimension and decoded-pixel budgets (a reference the
   * store would refuse must never be produced), and the model's `maxWidth`.
   * @param {object} canvas - the source canvas.
   * @param {unknown} maxWidth - the model's optional width cap.
   * @returns {number} a positive pixel width no larger than the canvas.
   */
  const renderWidthFor = (canvas, maxWidth) => {
    const attachments = ctx.get('attachments');
    const limits = attachments && attachments.imageLimits;
    let allowed = canvas.width;
    if (limits) {
      const bySide = number(limits.maxImageDimension, allowed, 1);
      const byArea = Math.floor(Math.sqrt(number(limits.maxImagePixels, allowed * allowed, 1)));
      allowed = Math.max(1, Math.min(allowed, Math.round(bySide), byArea));
    }
    const requested = number(maxWidth, undefined, 1);
    return requested === undefined ? allowed : Math.max(1, Math.round(Math.min(requested, allowed)));
  };

  /**
   * Render one region of a canvas and attach it as an image.
   * @param {object} args - tool arguments carrying x/y/width/height/maxWidth.
   * @param {object} exec - the tool run context.
   * @returns {Promise<object>} the tool result value.
   */
  const renderRegion = async (args, exec) => {
    const canvas = requireCanvas(exec);
    const region = resolveRegion(canvas, args);
    // A capped render paints straight at the smaller size, which is cheaper
    // than rendering full size and scaling the crop afterwards.
    const targetWidth = renderWidthFor(canvas, args.maxWidth);
    const image = targetWidth === canvas.width
      ? fullImage(canvas)
      : renderImage(canvas, targetWidth, Math.max(1, Math.round((canvas.height * targetWidth) / canvas.width)));
    const crop = cropImage(image, region, canvas.width, canvas.height);
    const name = `pen-${canvas.name}-${canvas.revision}-${Math.round(region.x)},${Math.round(region.y)}.png`;
    const imageField = await attachImage(exec, crop.png, name);
    const downscaled = Math.round(crop.region.width) !== Math.round(region.width)
      || Math.round(crop.region.height) !== Math.round(region.height);
    const sizeAdvice = `${crop.width}x${crop.height}px${downscaled ? ` (downscaled from the ${Math.round(region.width)}x${Math.round(region.height)}px region)` : ''}`;
    return {
      text: `Rendered region x=${Math.round(crop.region.x)} y=${Math.round(crop.region.y)} w=${Math.round(crop.region.width)} h=${Math.round(crop.region.height)} `
        + `of ${canvas.name} (${canvas.width}x${canvas.height}px, revision ${canvas.revision}) as a ${sizeAdvice} PNG, ${describeBytes(crop.png.length)}. `
        + 'The image is attached below.',
      image: imageField,
      width: crop.width,
      height: crop.height,
    };
  };

  const screenshotTool = defineTool({
    name: 'pen_screenshot',
    output: IMAGE_OUTPUT,
    description: 'Render a rectangular region of this session\'s canvas and return it as a PNG image so you can look at it. '
      + 'Omit the region to see the whole canvas; use maxWidth when you only need an overview of a large canvas.',
    parameters: objectSchema(regionParameters, []),
    // Rendering reads the canvas and returns a new attachment; no sibling can
    // observe an intermediate state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await renderRegion(args, exec);
    },
  });

  /**
   * The calling session's working directory, against which a relative export
   * path resolves. Read from the live session header; a caller without a
   * session (or one whose workspace was never set) falls back to the process
   * directory.
   * @param {object} exec - the tool run context.
   * @returns {string} an absolute directory.
   */
  const sessionCwd = (exec) => {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
      ? exec.agent.session.header.cwd
      : undefined;
    return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  };

  /**
   * Resolve an export path inside the session workspace.
   * @param {object} exec - the tool run context (carries the session working directory).
   * @param {string} requested - the model's `path` argument, possibly relative.
   * @param {string} fallbackName - the file name used when `path` is a directory or absent.
   * @returns {Promise<string>} an absolute path.
   */
  const resolveExportPath = async (exec, requested, fallbackName) => {
    const sessionDirectory = sessionCwd(exec);
    let target = config.exportDirectory !== '' ? config.exportDirectory : sessionDirectory;
    if (typeof requested === 'string' && requested.trim() !== '') {
      const trimmed = requested.trim();
      target = isAbsolute(trimmed) ? trimmed : resolve(sessionDirectory, trimmed);
    } else {
      target = join(target, fallbackName);
    }
    if (!isAbsolute(target)) target = resolve(sessionDirectory, target);
    return target;
  };

  const exportTool = defineTool({
    name: 'pen_export',
    output: EXPORT_OUTPUT,
    description: 'Write this session\'s canvas to a PNG file. '
      + 'Use it when the user wants the drawing on disk; the user can also export from the canvas panel at any time.',
    parameters: objectSchema({
      path: { type: 'string', description: 'File path for the PNG, absolute or relative to the session working directory; defaults to <working directory>/<canvas name>.png.' },
    }, []),
    // Two exports of one revision render the same cached image; the only shared
    // resource is the caller's own directory.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const canvas = requireCanvas(exec);
      const fallback = `${canvas.name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'canvas'}.png`;
      const filePath = await resolveExportPath(exec, args.path, fallback);
      const image = fullImage(canvas);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, image.png);
      return {
        text: `Exported ${describeCanvas(canvas)} to ${filePath} (${image.width}x${image.height}px, ${describeBytes(image.png.length)}).`,
        path: filePath,
      };
    },
  });

  // ── Registration ─────────────────────────────────────────────────────────

  ctx.effect(() => {
    const disposers = [createTool, drawTool, editTool, canvasTool, screenshotTool, exportTool]
      .map((tool) => ctx.tools.register(tool));
    return () => { for (const dispose of disposers) dispose(); };
  }, 'dsh-pen: drawing tools');

  if (config.promptSection) {
    ctx.inject(['systemPrompt'], (scoped) => {
      scoped.effect(() => scoped.systemPrompt.section({
        name: 'dsh-pen:drawing-canvas',
        order: 3200,
        text: PROMPT_SECTION,
      }), 'dsh-pen: prompt section');
    });
  }

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: config.routePrefix,
      handler: (request, response) => {
        handleRoute(request, response).catch((error) => {
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        });
      },
    }), 'dsh-pen: canvas route');
  });

  /** Read and parse a JSON request body, bounded to 512 KiB. */
  const readJsonBody = (request) => new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolvePromise({});
      try {
        resolvePromise(JSON.parse(text));
      } catch (error) {
        reject(new Error('request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });

  /** Answer one `/pen` route request. */
  async function handleRoute(request, response) {
    const url = new URL(request.url || '/', 'http://localhost');
    const route = url.pathname.slice(config.routePrefix.length) || '/';
    const sessionId = (url.searchParams.get('session') || '').trim();
    const sendJson = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
      response.end(body);
    };

    if (route === '/state' && request.method === 'GET') {
      if (sessionId === '') return sendJson(400, { ok: false, error: 'session is required' });
      const canvas = canvasOf(sessionId);
      if (!canvas) return sendJson(200, { ok: true, canvas: null });
      return sendJson(200, {
        ok: true,
        canvas: {
          name: canvas.name,
          width: canvas.width,
          height: canvas.height,
          background: canvas.background,
          operations: canvas.operations.length,
          revision: canvas.revision,
          empty: canvas.operations.length === 0,
        },
      });
    }

    if (route === '/state' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const target = String(body.session || sessionId || '').trim();
      if (target === '') return sendJson(400, { ok: false, error: 'session is required' });
      const action = String(body.action || '');
      if (action === 'create') {
        const canvas = createCanvas(target, body);
        return sendJson(200, { ok: true, revision: canvas.revision, name: canvas.name, width: canvas.width, height: canvas.height });
      }
      if (action === 'clear') {
        const canvas = canvasOf(target);
        if (!canvas) return sendJson(404, { ok: false, error: 'no canvas for this session' });
        canvas.operations.length = 0;
        markDirty(canvas);
        return sendJson(200, { ok: true, revision: canvas.revision });
      }
      return sendJson(400, { ok: false, error: `unknown action "${action}"` });
    }

    if (route === '/image' && request.method === 'GET') {
      if (sessionId === '') return sendJson(400, { ok: false, error: 'session is required' });
      const canvas = canvasOf(sessionId);
      if (!canvas) return sendJson(404, { ok: false, error: 'no canvas for this session' });
      const mode = url.searchParams.get('mode') || 'preview';
      const image = mode === 'full' ? fullImage(canvas) : previewImage(canvas);
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': image.png.length,
        'cache-control': 'no-cache',
        etag: `"pen-${canvas.revision}-${mode}"`,
      });
      response.end(Buffer.from(image.png));
      return;
    }

    return sendJson(404, { ok: false, error: `unknown pen route "${route}"` });
  }
}
