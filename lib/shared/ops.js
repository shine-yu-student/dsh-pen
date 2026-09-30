/**
 * Pen drawing model: the brush presets, the operation vocabulary shared by the
 * host tools and the canvas panel, and the pure functions that validate,
 * normalize, and paint an operation list onto a raster surface.
 *
 * The same source backs the Host module, so the operation vocabulary the tool
 * schema documents and the operations the rasterizer paints cannot drift.
 *
 * @module dsh-pen/lib/shared/ops
 */

globalThis.DSH_PEN = globalThis.DSH_PEN || {};

(function (PEN) {
  'use strict';

  /** Canvas defaults and hard limits; the plugin Config can lower, never raise, the limits. */
  const DEFAULTS = {
    width: 1024,
    height: 768,
    background: '#ffffff',
  };

  /** Hard bounds every operation value is validated against. */
  const LIMITS = {
    maxWidth: 4096,
    maxHeight: 4096,
    maxOperations: 512,
    maxPoints: 4096,
    maxCoord: 1000000,
  };

  /** Brush presets: one stroke style table, so a brush is data rather than code. */
  const BRUSHES = {
    pen: { width: 3, opacity: 1, dash: null, description: 'Opaque round pen.' },
    marker: { width: 10, opacity: 0.85, dash: null, description: 'Soft wide marker.' },
    highlighter: { width: 18, opacity: 0.35, dash: null, description: 'Translucent wide highlighter.' },
    dashed: { width: 3, opacity: 1, dash: [10, 8], description: 'Dashed pen.' },
    dotted: { width: 3, opacity: 1, dash: [1, 7], description: 'Dotted pen.' },
  };

  /** Operation kinds the drawing schema accepts. */
  const KINDS = ['line', 'polyline', 'curve', 'circle', 'ellipse', 'rect', 'arc', 'path', 'fill', 'clear'];

  /** One drawing operation's JSON description, used by the tool schema projections. */
  const OPERATION_DOCS = {
    line: 'Straight segment from (x1,y1) to (x2,y2).',
    polyline: 'Connected segment through every [x,y] in points; closed joins last to first; fill paints the interior.',
    curve: 'Smooth curve through every [x,y] in points (centripetal Catmull-Rom); closed and fill behave like polyline.',
    circle: 'Circle at (cx,cy) with radius; fill paints the interior.',
    ellipse: 'Ellipse at (cx,cy) with rx and ry; fill paints the interior.',
    rect: 'Axis-aligned rectangle at (x,y) with width and height; fill paints the interior.',
    arc: 'Circular arc at (cx,cy) with radius from startAngle to endAngle in degrees, clockwise unless counterclockwise is true.',
    path: 'Mini path string: M/m L/l H/h V/v C/c Q/q Z, using the same coordinate space.',
    fill: 'Filled polygon through every [x,y] in points (even-odd).',
    clear: 'Erase everything painted so far (background color only).',
  };

  /** Reject a value with one actionable message. */
  function fail(message) {
    throw new Error(message);
  }

  /** Whether a value is a plain object. */
  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** Read a finite number, or fail with the operation's own field path. */
  function number(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(path + ' must be a finite number');
    }
    return value;
  }

  /** Read an optional finite number, falling back when absent. */
  function optionalNumber(value, path, fallback) {
    if (value === undefined || value === null) return fallback;
    return number(value, path);
  }

  /** Read one point as [x, y]. */
  function point(value, path) {
    if (!Array.isArray(value) || value.length < 2) {
      fail(path + ' must be a [x, y] pair');
    }
    return [number(value[0], path + '[0]'), number(value[1], path + '[1]')];
  }

  /** Read a non-empty point list. */
  function points(value, path, minimum) {
    if (!Array.isArray(value)) fail(path + ' must be an array of [x, y] pairs');
    if (value.length < minimum) fail(path + ' needs at least ' + minimum + ' point(s)');
    if (value.length > LIMITS.maxPoints) fail(path + ' has more than ' + LIMITS.maxPoints + ' points');
    const out = [];
    for (let index = 0; index < value.length; index += 1) out.push(point(value[index], path + '[' + index + ']'));
    return out;
  }

  /** Read an optional color, leaving the resolved RGBA to the raster layer. */
  function color(value, path, fallback) {
    if (value === undefined || value === null) return fallback;
    if (Array.isArray(value) || typeof value === 'string') return value;
    fail(path + ' must be a color string or [r, g, b, a] array');
    return fallback;
  }

  /** Read an optional opacity in 0..1. */
  function opacity(value, path) {
    const raw = optionalNumber(value, path, undefined);
    if (raw === undefined) return undefined;
    if (raw < 0 || raw > 1) fail(path + ' must be between 0 and 1');
    return raw;
  }

  /** Read an optional positive width. */
  function width(value, path) {
    const raw = optionalNumber(value, path, undefined);
    if (raw === undefined) return undefined;
    if (!(raw > 0)) fail(path + ' must be greater than 0');
    return raw;
  }

  /** Resolve the stroke style one operation paints with. */
  function strokeStyle(op, brush, path) {
    const preset = BRUSHES[brush] || BRUSHES.pen;
    const style = {
      color: color(op.color, path + '.color', '#111111'),
      width: width(op.strokeWidth, path + '.strokeWidth'),
      opacity: opacity(op.opacity, path + '.opacity'),
    };
    if (style.width === undefined) style.width = preset.width;
    if (style.opacity === undefined) style.opacity = preset.opacity;
    if (op.dash !== undefined) {
      if (!Array.isArray(op.dash) || op.dash.length === 0 || op.dash.length % 2 !== 0) {
        fail(path + '.dash must be an even-length array of positive numbers');
      }
      style.dash = op.dash.map(function (value, index) {
        const raw = number(value, path + '.dash[' + index + ']');
        if (raw <= 0) fail(path + '.dash[' + index + '] must be greater than 0');
        return raw;
      });
    } else if (preset.dash) {
      style.dash = preset.dash.slice();
    }
    return style;
  }

  /**
   * Sample a centripetal Catmull-Rom spline through every control point.
   * @param {Array<number[]>} control - control points.
   * @param {boolean} closed - whether the curve wraps.
   * @param {number} [tension] - 0 (polyline) to 1 (loose); 0.5 is the standard spline.
   * @param {number} [segments] - samples per span.
   * @returns {Array<number[]>} the flattened polyline.
   */
  function sampleCurve(control, closed, tension, segments) {
    const n = control.length;
    if (n < 2) return control.slice();
    const alpha = 0.5 * (1 - PEN.raster.clamp(tension === undefined ? 0.5 : tension, 0, 1)) + 0.001;
    const perSpan = Math.max(2, Math.round(segments === undefined ? 24 : segments));
    const at = function (index) {
      if (closed) return control[((index % n) + n) % n];
      return control[Math.max(0, Math.min(n - 1, index))];
    };
    const out = [control[0].slice()];
    const last = closed ? n : n - 1;
    for (let span = 0; span < last; span += 1) {
      const p0 = at(span - 1);
      const p1 = at(span);
      const p2 = at(span + 1);
      const p3 = at(span + 2);
      const t0 = 0;
      const t1 = t0 + Math.pow(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), alpha) || t0 + 1e-6;
      const t2 = t1 + Math.pow(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), alpha) || t1 + 1e-6;
      const t3 = t2 + Math.pow(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), alpha) || t2 + 1e-6;
      for (let step = 1; step <= perSpan; step += 1) {
        const t = t1 + ((t2 - t1) * step) / perSpan;
        const a1 = mix(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
        const a2 = mix(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
        const a3 = mix(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
        const b1 = mix(a1, a2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
        const b2 = mix(a2, a3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
        out.push(mix(b1, b2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1)));
      }
    }
    return out;
  }

  /** Linear blend of two points. */
  function mix(a, b, wa, wb) {
    return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb];
  }

  /** Sample a circular arc into a polyline. */
  function sampleArc(cx, cy, radius, startDegrees, endDegrees, counterclockwise, segments) {
    let start = startDegrees;
    let end = endDegrees;
    if (counterclockwise) {
      if (end > start) end -= 360;
    } else if (end < start) {
      end += 360;
    }
    const sweep = end - start;
    const steps = Math.max(2, Math.round(segments === undefined ? Math.max(8, Math.abs(sweep) / 4) : segments));
    const out = [];
    for (let index = 0; index <= steps; index += 1) {
      const angle = ((start + (sweep * index) / steps) * Math.PI) / 180;
      out.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
    }
    if (counterclockwise) out.reverse();
    return out;
  }

  /**
   * Parse the mini path language into polyline pieces.
   * @param {string} text - path string with M/L/H/V/C/Q/Z commands.
   * @returns {Array<{points: Array<number[]>, closed: boolean}>} one entry per subpath.
   */
  function parsePath(text) {
    const tokens = String(text).match(/[MmLlHhVvCcQqZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
    if (!tokens) fail('path must contain at least one command');
    const pieces = [];
    let current = null;
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    let command = '';
    let index = 0;
    const readNumber = function () {
      if (index >= tokens.length || !/^[-+.\d]/.test(tokens[index])) fail('path command is missing a number');
      const value = Number(tokens[index]);
      index += 1;
      if (!Number.isFinite(value)) fail('path contains a non-finite number');
      return value;
    };
    const isCommand = function (token) { return /^[MmLlHhVvCcQqZz]$/.test(token); };
    while (index < tokens.length) {
      if (isCommand(tokens[index])) {
        command = tokens[index];
        index += 1;
      } else if (command === '') {
        fail('path must start with a command letter');
      }
      const relative = command === command.toLowerCase();
      const upper = command.toUpperCase();
      if (upper === 'Z') {
        if (current) {
          current.closed = true;
          current.points.push([startX, startY]);
          x = startX;
          y = startY;
        }
        continue;
      }
      if (upper === 'M') {
        const nx = readNumber();
        const ny = readNumber();
        x = relative ? x + nx : nx;
        y = relative ? y + ny : ny;
        startX = x;
        startY = y;
        current = { points: [[x, y]], closed: false };
        pieces.push(current);
        // A repeated coordinate pair after M is an implicit lineto.
        command = relative ? 'l' : 'L';
        continue;
      }
      if (upper === 'L' || upper === 'H' || upper === 'V') {
        if (!current) fail('path must start with M');
        if (upper === 'L') {
          const nx = readNumber();
          const ny = readNumber();
          x = relative ? x + nx : nx;
          y = relative ? y + ny : ny;
        } else if (upper === 'H') {
          const nx = readNumber();
          x = relative ? x + nx : nx;
        } else {
          const ny = readNumber();
          y = relative ? y + ny : ny;
        }
        current.points.push([x, y]);
        continue;
      }
      if (upper === 'C' || upper === 'Q') {
        if (!current) fail('path must start with M');
        if (upper === 'C') {
          const c1x = readNumber();
          const c1y = readNumber();
          const c2x = readNumber();
          const c2y = readNumber();
          const ex = readNumber();
          const ey = readNumber();
          const ax = x;
          const ay = y;
          const bx = relative ? x + c1x : c1x;
          const by = relative ? y + c1y : c1y;
          const cx2 = relative ? x + c2x : c2x;
          const cy2 = relative ? y + c2y : c2y;
          const dx = relative ? x + ex : ex;
          const dy = relative ? y + ey : ey;
          for (let step = 1; step <= 24; step += 1) {
            const t = step / 24;
            const u = 1 - t;
            current.points.push([
              u * u * u * ax + 3 * u * u * t * bx + 3 * u * t * t * cx2 + t * t * t * dx,
              u * u * u * ay + 3 * u * u * t * by + 3 * u * t * t * cy2 + t * t * t * dy,
            ]);
          }
          x = dx;
          y = dy;
        } else {
          const qx = readNumber();
          const qy = readNumber();
          const ex = readNumber();
          const ey = readNumber();
          const ax = x;
          const ay = y;
          const bx = relative ? x + qx : qx;
          const by = relative ? y + qy : qy;
          const dx = relative ? x + ex : ex;
          const dy = relative ? y + ey : ey;
          for (let step = 1; step <= 20; step += 1) {
            const t = step / 20;
            const u = 1 - t;
            current.points.push([
              u * u * ax + 2 * u * t * bx + t * t * dx,
              u * u * ay + 2 * u * t * by + t * t * dy,
            ]);
          }
          x = dx;
          y = dy;
        }
        continue;
      }
      fail('path command "' + command + '" is not supported; use M, L, H, V, C, Q, or Z');
    }
    return pieces.filter(function (piece) { return piece.points.length > 0; });
  }

  /**
   * Validate and normalize one operation.
   * @param {unknown} raw - the model's operation object.
   * @param {number} index - position in the batch, used in error messages.
   * @returns {object} the normalized operation.
   */
  function normalizeOperation(raw, index) {
    const path = 'operations[' + index + ']';
    if (!isRecord(raw)) fail(path + ' must be an object');
    const kind = raw.kind;
    if (typeof kind !== 'string' || KINDS.indexOf(kind) < 0) {
      fail(path + '.kind must be one of ' + KINDS.join(', '));
    }
    const brush = raw.brush === undefined ? 'pen' : raw.brush;
    if (typeof brush !== 'string' || !Object.prototype.hasOwnProperty.call(BRUSHES, brush)) {
      fail(path + '.brush must be one of ' + Object.keys(BRUSHES).join(', '));
    }
    const op = { kind: kind, brush: brush };
    const stroke = function () { return strokeStyle(raw, brush, path); };
    switch (kind) {
      case 'clear':
        return op;
      case 'line':
        op.x1 = number(raw.x1, path + '.x1');
        op.y1 = number(raw.y1, path + '.y1');
        op.x2 = number(raw.x2, path + '.x2');
        op.y2 = number(raw.y2, path + '.y2');
        op.style = stroke();
        return op;
      case 'polyline':
        op.points = points(raw.points, path + '.points', 2);
        op.closed = raw.closed === true;
        op.style = stroke();
        if (raw.fill !== undefined && raw.fill !== null) op.fill = color(raw.fill, path + '.fill');
        return op;
      case 'curve':
        op.points = points(raw.points, path + '.points', 2);
        op.closed = raw.closed === true;
        op.tension = optionalNumber(raw.tension, path + '.tension', 0.5);
        if (op.tension < 0 || op.tension > 1) fail(path + '.tension must be between 0 and 1');
        op.style = stroke();
        if (raw.fill !== undefined && raw.fill !== null) op.fill = color(raw.fill, path + '.fill');
        return op;
      case 'circle':
        op.cx = number(raw.cx, path + '.cx');
        op.cy = number(raw.cy, path + '.cy');
        op.radius = number(raw.radius, path + '.radius');
        if (!(op.radius > 0)) fail(path + '.radius must be greater than 0');
        op.style = stroke();
        if (raw.fill !== undefined && raw.fill !== null) op.fill = color(raw.fill, path + '.fill');
        return op;
      case 'ellipse':
        op.cx = number(raw.cx, path + '.cx');
        op.cy = number(raw.cy, path + '.cy');
        op.rx = number(raw.rx, path + '.rx');
        op.ry = number(raw.ry, path + '.ry');
        if (!(op.rx > 0) || !(op.ry > 0)) fail(path + '.rx and ' + path + '.ry must be greater than 0');
        op.style = stroke();
        if (raw.fill !== undefined && raw.fill !== null) op.fill = color(raw.fill, path + '.fill');
        return op;
      case 'rect':
        op.x = number(raw.x, path + '.x');
        op.y = number(raw.y, path + '.y');
        op.width = number(raw.width, path + '.width');
        op.height = number(raw.height, path + '.height');
        if (!(op.width > 0) || !(op.height > 0)) fail(path + '.width and .height must be greater than 0');
        op.style = stroke();
        if (raw.fill !== undefined && raw.fill !== null) op.fill = color(raw.fill, path + '.fill');
        return op;
      case 'arc':
        op.cx = number(raw.cx, path + '.cx');
        op.cy = number(raw.cy, path + '.cy');
        op.radius = number(raw.radius, path + '.radius');
        if (!(op.radius > 0)) fail(path + '.radius must be greater than 0');
        op.startAngle = optionalNumber(raw.startAngle, path + '.startAngle', 0);
        op.endAngle = optionalNumber(raw.endAngle, path + '.endAngle', 360);
        op.counterclockwise = raw.counterclockwise === true;
        op.style = stroke();
        return op;
      case 'path':
        if (typeof raw.d !== 'string' || raw.d.trim() === '') fail(path + '.d must be a non-empty path string');
        op.pieces = parsePath(raw.d);
        op.style = stroke();
        if (raw.fill !== undefined && raw.fill !== null) op.fill = color(raw.fill, path + '.fill');
        return op;
      case 'fill':
        op.points = points(raw.points, path + '.points', 3);
        op.fill = color(raw.fill, path + '.fill', '#111111');
        return op;
      default:
        return fail(path + '.kind is not supported');
    }
  }

  /**
   * Validate and normalize a whole batch.
   * @param {unknown} raw - the `operations` tool argument.
   * @returns {object[]} normalized operations in order.
   */
  function normalizeOperations(raw) {
    if (!Array.isArray(raw)) fail('operations must be an array of operation objects');
    if (raw.length === 0) fail('operations must contain at least one operation');
    if (raw.length > LIMITS.maxOperations) fail('operations may contain at most ' + LIMITS.maxOperations + ' operations per call');
    const out = [];
    const violations = [];
    for (let index = 0; index < raw.length; index += 1) {
      try {
        out.push(normalizeOperation(raw[index], index));
      } catch (error) {
        violations.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (violations.length > 0) {
      fail('no operation was drawn because ' + violations.length + ' of ' + raw.length
        + ' operations failed validation: ' + violations.join('; '));
    }
    return out;
  }

  /** Axis-aligned bounds of one normalized operation, or null when it paints nothing. */
  function operationBounds(op) {
    const pad = function (style) { return (style && style.width ? style.width : 0) / 2 + 1; };
    const boundsOfPoints = function (list, style, closed, filled) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < list.length; index += 1) {
        if (list[index][0] < minX) minX = list[index][0];
        if (list[index][1] < minY) minY = list[index][1];
        if (list[index][0] > maxX) maxX = list[index][0];
        if (list[index][1] > maxY) maxY = list[index][1];
      }
      const margin = closed || filled ? 0 : pad(style);
      return { x0: minX - margin, y0: minY - margin, x1: maxX + margin, y1: maxY + margin };
    };
    switch (op.kind) {
      case 'clear':
        return null;
      case 'line':
        return {
          x0: Math.min(op.x1, op.x2) - pad(op.style),
          y0: Math.min(op.y1, op.y2) - pad(op.style),
          x1: Math.max(op.x1, op.x2) + pad(op.style),
          y1: Math.max(op.y1, op.y2) + pad(op.style),
        };
      case 'polyline':
        return boundsOfPoints(op.points, op.style, op.closed, op.fill !== undefined);
      case 'curve':
        return boundsOfPoints(op.points, op.style, op.closed, op.fill !== undefined);
      case 'circle':
        return { x0: op.cx - op.radius - pad(op.style), y0: op.cy - op.radius - pad(op.style), x1: op.cx + op.radius + pad(op.style), y1: op.cy + op.radius + pad(op.style) };
      case 'ellipse':
        return { x0: op.cx - op.rx - pad(op.style), y0: op.cy - op.ry - pad(op.style), x1: op.cx + op.rx + pad(op.style), y1: op.cy + op.ry + pad(op.style) };
      case 'rect':
        return { x0: op.x - pad(op.style), y0: op.y - pad(op.style), x1: op.x + op.width + pad(op.style), y1: op.y + op.height + pad(op.style) };
      case 'arc':
        return { x0: op.cx - op.radius - pad(op.style), y0: op.cy - op.radius - pad(op.style), x1: op.cx + op.radius + pad(op.style), y1: op.cy + op.radius + pad(op.style) };
      case 'path': {
        let box = null;
        for (let index = 0; index < op.pieces.length; index += 1) {
          const piece = boundsOfPoints(op.pieces[index].points, op.style, op.pieces[index].closed, op.fill !== undefined);
          if (!box) box = piece;
          else {
            box.x0 = Math.min(box.x0, piece.x0);
            box.y0 = Math.min(box.y0, piece.y0);
            box.x1 = Math.max(box.x1, piece.x1);
            box.y1 = Math.max(box.y1, piece.y1);
          }
        }
        return box;
      }
      case 'fill':
        return boundsOfPoints(op.points, null, true, true);
      default:
        return null;
    }
  }

  /**
   * Paint one normalized operation.
   * @param {object} surface - the raster surface.
   * @param {object} op - a normalized operation.
   */
  function paintOperation(surface, op) {
    const style = op.style || {};
    switch (op.kind) {
      case 'clear':
        return;
      case 'line':
        surface.strokePolyline([[op.x1, op.y1], [op.x2, op.y2]], style);
        return;
      case 'polyline': {
        const list = op.closed && op.points.length > 2 ? op.points.concat([op.points[0]]) : op.points;
        if (op.fill !== undefined) surface.fillPolygon(op.points, op.fill);
        surface.strokePolyline(list, style);
        return;
      }
      case 'curve': {
        const list = sampleCurve(op.points, op.closed, op.tension, 24);
        if (op.fill !== undefined) surface.fillPolygon(list, op.fill);
        surface.strokePolyline(op.closed ? list.concat([list[0]]) : list, style);
        return;
      }
      case 'circle':
        if (op.fill !== undefined) surface.fillCircle(op.cx, op.cy, op.radius, op.fill);
        surface.strokePolyline(sampleArc(op.cx, op.cy, op.radius, 0, 360, false, 96), style);
        return;
      case 'ellipse': {
        const list = [];
        for (let index = 0; index <= 96; index += 1) {
          const angle = (index / 96) * Math.PI * 2;
          list.push([op.cx + op.rx * Math.cos(angle), op.cy + op.ry * Math.sin(angle)]);
        }
        if (op.fill !== undefined) surface.fillEllipse(op.cx, op.cy, op.rx, op.ry, op.fill);
        surface.strokePolyline(list, style);
        return;
      }
      case 'rect':
        if (op.fill !== undefined) surface.fillRect(op.x, op.y, op.width, op.height, op.fill);
        surface.strokePolyline([
          [op.x, op.y], [op.x + op.width, op.y], [op.x + op.width, op.y + op.height], [op.x, op.y + op.height], [op.x, op.y],
        ], style);
        return;
      case 'arc':
        surface.strokePolyline(sampleArc(op.cx, op.cy, op.radius, op.startAngle, op.endAngle, op.counterclockwise), style);
        return;
      case 'path':
        for (let index = 0; index < op.pieces.length; index += 1) {
          const piece = op.pieces[index];
          const list = piece.closed && piece.points.length > 2 ? piece.points.concat([piece.points[0]]) : piece.points;
          if (op.fill !== undefined && piece.closed) surface.fillPolygon(piece.points, op.fill);
          surface.strokePolyline(list, style);
        }
        return;
      case 'fill':
        surface.fillPolygon(op.points, op.fill);
        return;
      default:
        return;
    }
  }

  /**
   * Paint a whole normalized batch onto a surface.
   * @param {object} surface - the raster surface.
   * @param {object[]} operations - normalized operations in order.
   * @param {unknown} [background] - background repainted by `clear`.
   */
  function paintOperations(surface, operations, background) {
    for (let index = 0; index < operations.length; index += 1) {
      const op = operations[index];
      if (op.kind === 'clear') {
        surface.fillRect(0, 0, surface.width, surface.height, background === undefined ? DEFAULTS.background : background);
      } else {
        paintOperation(surface, op);
      }
    }
  }

  /**
   * Paint a whole operation list into a fresh surface.
   * @param {{width: number, height: number, background?: unknown, quality?: number}} canvas - canvas geometry.
   * @param {object[]} operations - normalized operations.
   * @returns {object} the painted surface.
   */
  function renderOperations(canvas, operations) {
    const surface = PEN.raster.createSurface(canvas.width, canvas.height, canvas.background, canvas.quality);
    paintOperations(surface, operations, canvas.background);
    return surface;
  }

  /** One decimal place, for compact geometry in descriptions. */
  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  /** A color as compact text, accepting the [r, g, b, a] array form too. */
  function colorText(value) {
    if (Array.isArray(value)) return 'rgba(' + value.join(',') + ')';
    return String(value);
  }

  /** Unpadded bounding box of a point list, as compact text. */
  function boxOf(list) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < list.length; index += 1) {
      if (list[index][0] < minX) minX = list[index][0];
      if (list[index][1] < minY) minY = list[index][1];
      if (list[index][0] > maxX) maxX = list[index][0];
      if (list[index][1] > maxY) maxY = list[index][1];
    }
    return ' bbox (' + round1(minX) + ',' + round1(minY) + ')-(' + round1(maxX) + ',' + round1(maxY) + ')';
  }

  /** The fill/stroke suffix of a description. */
  function styleOf(op) {
    const parts = [];
    if (op.fill !== undefined) parts.push('fill ' + colorText(op.fill));
    if (op.style) {
      parts.push('stroke ' + colorText(op.style.color) + ' w' + round1(op.style.width));
      if (op.brush && op.brush !== 'pen') parts.push(op.brush);
    }
    return parts.length === 0 ? '' : ' ' + parts.join(' ');
  }

  /**
   * One-line human summary of one normalized operation, detailed enough to
   * identify a stroke in a numbered listing (position, fill, stroke color, and
   * width) while staying compact enough to print a whole canvas.
   * @param {object} op - normalized operation.
   * @returns {string} summary text.
   */
  function describeOperation(op) {
    switch (op.kind) {
      case 'clear':
        return 'clear';
      case 'line':
        return 'line (' + round1(op.x1) + ',' + round1(op.y1) + ')->(' + round1(op.x2) + ',' + round1(op.y2) + ')' + styleOf(op);
      case 'polyline':
        return 'polyline ' + op.points.length + ' points' + boxOf(op.points) + (op.closed ? ' closed' : '') + styleOf(op);
      case 'curve':
        return 'curve ' + op.points.length + ' points' + boxOf(op.points) + (op.closed ? ' closed' : '') + styleOf(op);
      case 'circle':
        return 'circle r' + round1(op.radius) + ' @(' + round1(op.cx) + ',' + round1(op.cy) + ')' + styleOf(op);
      case 'ellipse':
        return 'ellipse ' + round1(op.rx) + 'x' + round1(op.ry) + ' @(' + round1(op.cx) + ',' + round1(op.cy) + ')' + styleOf(op);
      case 'rect':
        return 'rect ' + round1(op.width) + 'x' + round1(op.height) + ' @(' + round1(op.x) + ',' + round1(op.y) + ')' + styleOf(op);
      case 'arc':
        return 'arc r' + round1(op.radius) + ' @(' + round1(op.cx) + ',' + round1(op.cy) + ') '
          + round1(op.startAngle) + '->' + round1(op.endAngle) + 'deg' + styleOf(op);
      case 'path': {
        let all = [];
        for (let index = 0; index < op.pieces.length; index += 1) all = all.concat(op.pieces[index].points);
        return 'path ' + op.pieces.length + ' subpath(s)' + (all.length > 0 ? boxOf(all) : '') + styleOf(op);
      }
      case 'fill':
        return 'fill ' + op.points.length + ' points' + boxOf(op.points) + styleOf(op);
      default:
        return op.kind;
    }
  }

  /** Read a 0-based list position, inclusive of `limit`. */
  function position(value, path, limit) {
    if (typeof value !== 'number' || !Number.isInteger(value)) fail(path + ' must be an integer');
    if (value < 0 || value > limit) fail(path + ' must be between 0 and ' + limit);
    return value;
  }

  /**
   * Remove `remove` operations at `index` and insert `inserted` in their
   * place; the input list is never mutated.
   * @param {object[]} operations - the current operation list.
   * @param {unknown} index - 0-based splice position (0..length).
   * @param {unknown} remove - how many operations to drop (default 0).
   * @param {object[]} inserted - normalized operations to insert.
   * @param {string} path - diagnostic prefix, e.g. `edits[0]`.
   * @returns {object[]} a new operation list.
   */
  function spliceOperations(operations, index, remove, inserted, path) {
    const at = position(index, path + '.index', operations.length);
    const count = remove === undefined || remove === null ? 0 : position(remove, path + '.remove', operations.length - at);
    if (count === 0 && inserted.length === 0) fail(path + ' changes nothing: give remove, operations, or both');
    return operations.slice(0, at).concat(inserted, operations.slice(at + count));
  }

  /**
   * Restack one operation: drop it at `from` and reinsert it at `to` in the
   * list that remains; the input list is never mutated.
   * @param {object[]} operations - the current operation list.
   * @param {unknown} from - 0-based index of the operation to move.
   * @param {unknown} to - 0-based destination without that operation.
   * @param {string} path - diagnostic prefix, e.g. `edits[1]`.
   * @returns {object[]} a new operation list.
   */
  function moveOperation(operations, from, to, path) {
    const last = operations.length - 1;
    if (last < 0) fail(path + ' cannot move anything: the canvas has no operations');
    const source = position(from, path + '.from', last);
    const target = position(to, path + '.to', last);
    if (source === target) return operations.slice();
    const out = operations.slice();
    const moved = out.splice(source, 1)[0];
    out.splice(target, 0, moved);
    return out;
  }

  PEN.ops = {
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    BRUSHES: BRUSHES,
    KINDS: KINDS,
    OPERATION_DOCS: OPERATION_DOCS,
    normalizeOperation: normalizeOperation,
    normalizeOperations: normalizeOperations,
    operationBounds: operationBounds,
    paintOperation: paintOperation,
    paintOperations: paintOperations,
    renderOperations: renderOperations,
    describeOperation: describeOperation,
    spliceOperations: spliceOperations,
    moveOperation: moveOperation,
    sampleCurve: sampleCurve,
    sampleArc: sampleArc,
    parsePath: parsePath,
  };
}(globalThis.DSH_PEN));
