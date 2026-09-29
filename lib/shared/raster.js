/**
 * Pen raster: a dependency-free, host-and-browser-identical software rasterizer
 * plus a PNG encoder written on top of it.
 *
 * The file is deliberately plain (no `import`/`export`): scripts/build.mjs
 * embeds the very same source into the Host module, so one implementation
 * produces the PNG the model sees, the PNG the canvas panel shows, and the PNG
 * the export button downloads.
 *
 * Supported painting primitives are the ones the drawing schema exposes:
 * filled polygons (even-odd), filled circles, filled axis-aligned rectangles,
 * and round-capped/round-joined strokes with an optional dash pattern.
 *
 * Antialiasing comes from supersampling: each operation is scanned inside its
 * own bounding box at `quality` samples per axis and box-filtered into the
 * destination pixel grid, so cost follows the painted area rather than the
 * canvas size.
 *
 * @module dsh-pen/lib/shared/raster
 */

globalThis.DSH_PEN = globalThis.DSH_PEN || {};

(function (PEN) {
  'use strict';

  /** Named colors accepted anywhere a color is accepted, alongside #RGB/#RRGGBB/#RRGGBBAA. */
  const NAMED_COLORS = {
    transparent: [0, 0, 0, 0],
    black: [0, 0, 0, 255],
    white: [255, 255, 255, 255],
    red: [230, 57, 70, 255],
    orange: [244, 132, 31, 255],
    amber: [255, 191, 0, 255],
    yellow: [255, 214, 10, 255],
    lime: [140, 200, 60, 255],
    green: [42, 157, 92, 255],
    teal: [24, 156, 155, 255],
    cyan: [34, 184, 207, 255],
    blue: [36, 123, 191, 255],
    indigo: [76, 82, 178, 255],
    violet: [126, 87, 194, 255],
    purple: [140, 70, 180, 255],
    magenta: [214, 51, 132, 255],
    pink: [232, 122, 168, 255],
    brown: [141, 96, 60, 255],
    gray: [128, 134, 141, 255],
    grey: [128, 134, 141, 255],
    silver: [190, 195, 200, 255],
    navy: [22, 60, 110, 255],
    olive: [120, 130, 40, 255],
    maroon: [120, 30, 40, 255],
  };

  /** Clamp a finite number into [lo, hi]; a non-finite value yields lo. */
  function clamp(value, lo, hi) {
    if (!Number.isFinite(value)) return lo;
    return value < lo ? lo : value > hi ? hi : value;
  }

  /** Round into an unsigned byte. */
  function byte(value) {
    const rounded = Math.round(value);
    return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
  }

  /**
   * Parse one color into straight (non-premultiplied) RGBA bytes.
   * @param {unknown} value - a #RGB/#RGBA/#RRGGBB/#RRGGBBAA string, `rgb()`/`rgba()`, or a name from NAMED_COLORS.
   * @param {number[]} [fallback] - RGBA returned when the value is absent or unparsable.
   * @returns {number[]} four bytes.
   */
  function parseColor(value, fallback) {
    const miss = fallback || [0, 0, 0, 255];
    if (value === undefined || value === null || value === '') return miss.slice();
    if (Array.isArray(value)) {
      if (value.length < 3) return miss.slice();
      const a = value.length > 3 ? clamp(Number(value[3]), 0, 1) * 255 : 255;
      return [byte(Number(value[0])), byte(Number(value[1])), byte(Number(value[2])), byte(a)];
    }
    const text = String(value).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, text)) return NAMED_COLORS[text].slice();
    if (text === 'none') return [0, 0, 0, 0];
    if (text.charAt(0) === '#') {
      const hex = text.slice(1);
      if (/^[0-9a-f]{3}$/.test(hex)) {
        return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16), 255];
      }
      if (/^[0-9a-f]{4}$/.test(hex)) {
        return [
          parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16),
          parseInt(hex[2] + hex[2], 16), parseInt(hex[3] + hex[3], 16),
        ];
      }
      if (/^[0-9a-f]{6}$/.test(hex)) {
        return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255];
      }
      if (/^[0-9a-f]{8}$/.test(hex)) {
        return [
          parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16), parseInt(hex.slice(6, 8), 16),
        ];
      }
      return miss.slice();
    }
    const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
    if (rgb) {
      const parts = rgb[1].split(/[,/\s]+/).filter(function (part) { return part !== ''; });
      if (parts.length < 3) return miss.slice();
      const read = function (part) {
        return part.indexOf('%') >= 0 ? (parseFloat(part) / 100) * 255 : parseFloat(part);
      };
      const alpha = parts.length > 3
        ? (parts[3].indexOf('%') >= 0 ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]))
        : 1;
      return [byte(read(parts[0])), byte(read(parts[1])), byte(read(parts[2])), byte(clamp(alpha, 0, 1) * 255)];
    }
    return miss.slice();
  }

  /**
   * Scale one straight RGBA color's contribution by an extra opacity factor.
   * @param {number[]} rgba - straight RGBA bytes.
   * @param {number} opacity - 0..1 multiplier applied to the alpha channel.
   * @returns {number[]} straight RGBA bytes with the scaled alpha.
   */
  function withOpacity(rgba, opacity) {
    return [rgba[0], rgba[1], rgba[2], byte(rgba[3] * clamp(opacity, 0, 1))];
  }

  // ── PNG encoding ──────────────────────────────────────────────────────────

  /** Cached CRC-32 table for PNG chunk checksums. */
  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  /** CRC-32 of a byte range. */
  function crc32(bytes, start, end) {
    let crc = 0xffffffff;
    for (let index = start; index < end; index += 1) {
      crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** A PNG chunk-count limit shared by both chunk emitters. */
  const CHUNK_BYTES = 1 << 16;

  /**
   * Encode one image as a PNG byte stream.
   * @param {{width: number, height: number, getRGBA: function(): Uint8Array}} image - image surface.
   * @param {{deflate: function(Uint8Array): Uint8Array}} [compressor] - raw-deflate provider; the Host passes node:zlib.
   * @returns {Uint8Array} PNG bytes.
   */
  function encodePNG(image, compressor) {
    const width = image.width;
    const height = image.height;
    const rgba = image.getRGBA();
    const rowBytes = width * 4 + 1;

    const chunks = [];
    let total = 8;
    const push = function (type, data) {
      chunks.push({ type: type, data: data });
      total += 12 + data.length;
    };

    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    push('IHDR', ihdr);

    // Filter 0 (None) on every scanline; the model-facing images are flat art,
    // where the zlib window still finds most of the redundancy.
    const rows = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y += 1) {
      const target = y * rowBytes;
      const source = y * width * 4;
      rows[target] = 0;
      for (let index = 0; index < width * 4; index += 1) rows[target + 1 + index] = rgba[source + index];
    }

    let raw = rows;
    if (compressor && typeof compressor.deflate === 'function') {
      const deflated = compressor.deflate(rows);
      raw = deflated instanceof Uint8Array ? deflated : new Uint8Array(deflated);
    }
    for (let offset = 0; offset < raw.length; offset += CHUNK_BYTES) {
      push('IDAT', raw.subarray(offset, Math.min(offset + CHUNK_BYTES, raw.length)));
    }
    push('IEND', new Uint8Array(0));

    const out = new Uint8Array(total);
    out[0] = 0x89;
    out[1] = 0x50;
    out[2] = 0x4e;
    out[3] = 0x47;
    out[4] = 0x0d;
    out[5] = 0x0a;
    out[6] = 0x1a;
    out[7] = 0x0a;
    let cursor = 8;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const data = chunk.data;
      out[cursor] = (data.length >>> 24) & 0xff;
      out[cursor + 1] = (data.length >>> 16) & 0xff;
      out[cursor + 2] = (data.length >>> 8) & 0xff;
      out[cursor + 3] = data.length & 0xff;
      out[cursor + 4] = chunk.type.charCodeAt(0);
      out[cursor + 5] = chunk.type.charCodeAt(1);
      out[cursor + 6] = chunk.type.charCodeAt(2);
      out[cursor + 7] = chunk.type.charCodeAt(3);
      out.set(data, cursor + 8);
      const crc = crc32(out, cursor + 4, cursor + 8 + data.length);
      out[cursor + 8 + data.length] = (crc >>> 24) & 0xff;
      out[cursor + 9 + data.length] = (crc >>> 16) & 0xff;
      out[cursor + 10 + data.length] = (crc >>> 8) & 0xff;
      out[cursor + 11 + data.length] = crc & 0xff;
      cursor += 12 + data.length;
    }
    return out;
  }

  // ── Surface ───────────────────────────────────────────────────────────────

  /**
   * Create one paintable surface filled with a background color.
   * @param {number} width - pixel width (positive integer).
   * @param {number} height - pixel height (positive integer).
   * @param {unknown} [background] - background color, `#ffffff` by default.
   * @param {number} [quality] - supersampling factor per axis, clamped to 1..4.
   * @returns {object} the surface.
   */
  function createSurface(width, height, background, quality) {
    const fill = parseColor(background, [255, 255, 255, 255]);
    const red = new Uint8ClampedArray(width * height);
    const green = new Uint8ClampedArray(width * height);
    const blue = new Uint8ClampedArray(width * height);
    const alpha = new Uint8ClampedArray(width * height);
    for (let index = 0; index < red.length; index += 1) {
      red[index] = fill[0];
      green[index] = fill[1];
      blue[index] = fill[2];
      alpha[index] = fill[3];
    }
    // Non-integer scales re-render the whole surface; integer ones scale the
    // destination pixel and its background together.
    const scale = clamp(Math.round(quality || 1), 1, 4);
    const cellWeight = 1 / (scale * scale);
    const samples = new Float64Array(scale * scale);

    /** Composite one straight RGBA color over the destination pixel. */
    const blend = function (index, rgba, coverage) {
      if (coverage <= 0) return;
      const sourceAlpha = (rgba[3] / 255) * coverage;
      if (sourceAlpha <= 0) return;
      const targetAlpha = alpha[index] / 255;
      const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      if (outAlpha <= 0) {
        red[index] = 0;
        green[index] = 0;
        blue[index] = 0;
        alpha[index] = 0;
        return;
      }
      red[index] = (rgba[0] * sourceAlpha + red[index] * targetAlpha * (1 - sourceAlpha)) / outAlpha;
      green[index] = (rgba[1] * sourceAlpha + green[index] * targetAlpha * (1 - sourceAlpha)) / outAlpha;
      blue[index] = (rgba[2] * sourceAlpha + blue[index] * targetAlpha * (1 - sourceAlpha)) / outAlpha;
      alpha[index] = outAlpha * 255;
    };

    /** Composite one sample-coverage field over a bounding box. */
    const composite = function (box, coverageAt, rgba) {
      let maxCoverage = 0;
      for (let py = box.y0; py <= box.y1; py += 1) {
        for (let px = box.x0; px <= box.x1; px += 1) {
          let filled = 0;
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              filled += coverageAt(px, py, sx, sy);
            }
          }
          const coverage = filled * cellWeight;
          if (coverage > maxCoverage) maxCoverage = coverage;
          if (coverage > 0) blend(py * width + px, rgba, coverage);
        }
      }
      // A stroke thinner than one device pixel at this quality must stay
      // visible; lifting it to one device pixel keeps hairline art legible.
      if (rgba[3] > 0 && maxCoverage > 0 && maxCoverage * (rgba[3] / 255) < 0.35) {
        const lifted = Math.min(1, 0.35 / (rgba[3] / 255));
        for (let py = box.y0; py <= box.y1; py += 1) {
          for (let px = box.x0; px <= box.x1; px += 1) {
            let filled = 0;
            for (let sy = 0; sy < scale; sy += 1) {
              for (let sx = 0; sx < scale; sx += 1) {
                filled += coverageAt(px, py, sx, sy);
              }
            }
            if (filled > 0) blend(py * width + px, rgba, Math.max(filled * cellWeight, lifted));
          }
        }
      }
    };

    /** Integer bounding box clipped to the surface. */
    const boxOf = function (minX, minY, maxX, maxY) {
      const x0 = Math.max(0, Math.floor(minX));
      const y0 = Math.max(0, Math.floor(minY));
      const x1 = Math.min(width - 1, Math.ceil(maxX));
      const y1 = Math.min(height - 1, Math.ceil(maxY));
      if (x0 > x1 || y0 > y1) return null;
      return { x0: x0, y0: y0, x1: x1, y1: y1 };
    };

    const emptyBox = function () {
      return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    };
    const grow = function (box, minX, minY, maxX, maxY) {
      if (minX < box.x0) box.x0 = minX;
      if (minY < box.y0) box.y0 = minY;
      if (maxX > box.x1) box.x1 = maxX;
      if (maxY > box.y1) box.y1 = maxY;
    };

    /** Reusable scanline crossing buffer. */
    let crossings = new Float64Array(64);

    /** Even-odd coverage of one polygon over one sample point. */
    const polygonCoverage = function (points, px, py, sx, sy) {
      const x = px + (sx + 0.5) / scale;
      const y = py + (sy + 0.5) / scale;
      let count = 0;
      const total = points.length;
      if (total < 3) return 0;
      for (let index = 0; index < total; index += 1) {
        const ax = points[index][0];
        const ay = points[index][1];
        const next = points[(index + 1) % total];
        const bx = next[0];
        const by = next[1];
        if ((ay <= y) === (by <= y) || ay === by) continue;
        const t = (y - ay) / (by - ay);
        const xCross = ax + t * (bx - ax);
        if (count === crossings.length) {
          const grown = new Float64Array(crossings.length * 2);
          grown.set(crossings);
          crossings = grown;
        }
        crossings[count] = xCross;
        count += 1;
      }
      let inside = false;
      for (let index = 0; index < count; index += 1) {
        if (crossings[index] <= x) inside = !inside;
      }
      return inside ? 1 : 0;
    };

    /** Distance from a point to a segment. */
    const distanceToSegment = function (px, py, ax, ay, bx, by) {
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      let t = 0;
      if (lengthSquared > 0) {
        t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const ox = px - cx;
      const oy = py - cy;
      return Math.sqrt(ox * ox + oy * oy);
    };

    const surface = {
      width: width,
      height: height,
      quality: scale,

      /** Packed RGBA bytes for PNG encoding. */
      getRGBA: function () {
        const out = new Uint8Array(width * height * 4);
        for (let index = 0; index < red.length; index += 1) {
          out[index * 4] = red[index];
          out[index * 4 + 1] = green[index];
          out[index * 4 + 2] = blue[index];
          out[index * 4 + 3] = alpha[index];
        }
        return out;
      },

      /** One destination pixel as straight RGBA bytes. */
      pixel: function (x, y) {
        const index = y * width + x;
        return [red[index], green[index], blue[index], alpha[index]];
      },

      /**
       * Fill a polygon with the even-odd rule.
       * @param {Array<number[]>} points - polygon vertices.
       * @param {unknown} color - fill color.
       * @param {number} [opacity] - extra opacity multiplier.
       */
      fillPolygon: function (points, color, opacity) {
        if (points.length < 3) return;
        const rgba = withOpacity(parseColor(color), opacity === undefined ? 1 : opacity);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let index = 0; index < points.length; index += 1) {
          const point = points[index];
          if (point[0] < minX) minX = point[0];
          if (point[1] < minY) minY = point[1];
          if (point[0] > maxX) maxX = point[0];
          if (point[1] > maxY) maxY = point[1];
        }
        const box = boxOf(minX, minY, maxX, maxY);
        if (!box) return;
        composite(box, function (px, py, sx, sy) {
          return polygonCoverage(points, px, py, sx, sy);
        }, rgba);
      },

      /** Fill an axis-aligned rectangle. */
      fillRect: function (x, y, rectWidth, rectHeight, color, opacity) {
        if (!(rectWidth > 0) || !(rectHeight > 0)) return;
        const points = [[x, y], [x + rectWidth, y], [x + rectWidth, y + rectHeight], [x, y + rectHeight]];
        surface.fillPolygon(points, color, opacity);
      },

      /** Fill a circle. */
      fillCircle: function (cx, cy, radius, color, opacity) {
        if (!(radius > 0)) return;
        const rgba = withOpacity(parseColor(color), opacity === undefined ? 1 : opacity);
        const box = boxOf(cx - radius, cy - radius, cx + radius, cy + radius);
        if (!box) return;
        const r2 = radius * radius;
        composite(box, function (px, py, sx, sy) {
          const dx = px + (sx + 0.5) / scale - cx;
          const dy = py + (sy + 0.5) / scale - cy;
          return dx * dx + dy * dy <= r2 ? 1 : 0;
        }, rgba);
      },

      /** Fill an ellipse. */
      fillEllipse: function (cx, cy, radiusX, radiusY, color, opacity) {
        if (!(radiusX > 0) || !(radiusY > 0)) return;
        const rgba = withOpacity(parseColor(color), opacity === undefined ? 1 : opacity);
        const box = boxOf(cx - radiusX, cy - radiusY, cx + radiusX, cy + radiusY);
        if (!box) return;
        composite(box, function (px, py, sx, sy) {
          const dx = (px + (sx + 0.5) / scale - cx) / radiusX;
          const dy = (py + (sy + 0.5) / scale - cy) / radiusY;
          return dx * dx + dy * dy <= 1 ? 1 : 0;
        }, rgba);
      },

      /**
       * Stroke a polyline with round joins and round caps.
       * @param {Array<number[]>} points - polyline vertices.
       * @param {{color?: unknown, width?: number, opacity?: number, dash?: number[]}} options - stroke style.
       */
      strokePolyline: function (points, options) {
        const style = options || {};
        const strokeWidth = style.width === undefined ? 2 : Number(style.width);
        if (!(strokeWidth > 0) || points.length === 0) return;
        const rgba = withOpacity(parseColor(style.color), style.opacity === undefined ? 1 : style.opacity);
        if (rgba[3] <= 0) return;
        const half = strokeWidth / 2;
        const dash = Array.isArray(style.dash) && style.dash.length > 0
          ? style.dash.map(function (value) { return Math.max(0, Number(value) || 0); })
          : null;

        const source = points.length === 1 ? [points[0], points[0]] : points;
        if (dash) {
          // Walk the polyline in dash-length steps so each painted run is an
          // independent capsule: dashes then join exactly like Canvas dashes.
          let dashIndex = 0;
          let remaining = dash[0];
          let on = true;
          for (let index = 0; index + 1 < source.length; index += 1) {
            let ax = source[index][0];
            let ay = source[index][1];
            const bx = source[index + 1][0];
            const by = source[index + 1][1];
            const segmentLength = Math.hypot(bx - ax, by - ay);
            let travelled = 0;
            while (travelled < segmentLength) {
              if (remaining <= 0) {
                dashIndex = (dashIndex + 1) % dash.length;
                remaining = dash[dashIndex];
                on = !on;
                if (!(remaining > 0)) {
                  remaining = 1e-9;
                }
                continue;
              }
              const step = Math.min(remaining, segmentLength - travelled);
              const t0 = travelled / segmentLength;
              const t1 = (travelled + step) / segmentLength;
              const sx0 = ax + (bx - ax) * t0;
              const sy0 = ay + (by - ay) * t0;
              const sx1 = ax + (bx - ax) * t1;
              const sy1 = ay + (by - ay) * t1;
              if (on && step > 0) surface.strokePolyline([[sx0, sy0], [sx1, sy1]], {
                color: style.color, width: strokeWidth, opacity: style.opacity,
              });
              travelled += step;
              remaining -= step;
            }
          }
          return;
        }

        const box = emptyBox();
        for (let index = 0; index + 1 < source.length; index += 1) {
          const ax = source[index][0];
          const ay = source[index][1];
          const bx = source[index + 1][0];
          const by = source[index + 1][1];
          grow(box,
            Math.min(ax, bx) - half - 1, Math.min(ay, by) - half - 1,
            Math.max(ax, bx) + half + 1, Math.max(ay, by) + half + 1);
        }
        const clipped = boxOf(box.x0, box.y0, box.x1, box.y1);
        if (!clipped) return;

        composite(clipped, function (px, py, sx, sy) {
          const x = px + (sx + 0.5) / scale;
          const y = py + (sy + 0.5) / scale;
          for (let index = 0; index + 1 < source.length; index += 1) {
            const ax = source[index][0];
            const ay = source[index][1];
            const bx = source[index + 1][0];
            const by = source[index + 1][1];
            if (distanceToSegment(x, y, ax, ay, bx, by) <= half) return 1;
          }
          return 0;
        }, rgba);
      },
    };

    return surface;
  }

  /**
   * Nearest-neighbour scale factor mapping a destination surface onto a source one.
   * @param {object} source - the surface whose pixels are read.
   * @param {number} targetWidth - destination pixel width.
   * @param {number} targetHeight - destination pixel height.
   * @returns {{x: function(number): number, y: function(number): number}} coordinate mappers.
   */
  function scalers(source, targetWidth, targetHeight) {
    const sx = source.width / targetWidth;
    const sy = source.height / targetHeight;
    return {
      x: function (px) { return Math.min(source.width - 1, Math.floor((px + 0.5) * sx)); },
      y: function (py) { return Math.min(source.height - 1, Math.floor((py + 0.5) * sy)); },
    };
  }

  /**
   * Downscale a surface with box averaging.
   * @param {object} source - the surface to read.
   * @param {number} width - destination width.
   * @param {number} height - destination height.
   * @returns {Uint8Array} packed RGBA bytes of the smaller image.
   */
  function downsample(source, width, height) {
    const out = new Uint8Array(width * height * 4);
    const sx = source.width / width;
    const sy = source.height / height;
    for (let py = 0; py < height; py += 1) {
      const y0 = Math.floor(py * sy);
      const y1 = Math.max(y0 + 1, Math.min(source.height, Math.ceil((py + 1) * sy)));
      for (let px = 0; px < width; px += 1) {
        const x0 = Math.floor(px * sx);
        const x1 = Math.max(x0 + 1, Math.min(source.width, Math.ceil((px + 1) * sx)));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let count = 0;
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const pixel = source.pixel(x, y);
            r += pixel[0];
            g += pixel[1];
            b += pixel[2];
            a += pixel[3];
            count += 1;
          }
        }
        const offset = (py * width + px) * 4;
        out[offset] = r / count;
        out[offset + 1] = g / count;
        out[offset + 2] = b / count;
        out[offset + 3] = a / count;
      }
    }
    return out;
  }

  /** A surface view over already-packed RGBA bytes. */
  function surfaceFromRGBA(width, height, rgba) {
    return {
      width: width,
      height: height,
      getRGBA: function () { return rgba; },
      pixel: function (x, y) {
        const offset = (y * width + x) * 4;
        return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
      },
    };
  }

  PEN.raster = {
    NAMED_COLORS: NAMED_COLORS,
    clamp: clamp,
    parseColor: parseColor,
    withOpacity: withOpacity,
    createSurface: createSurface,
    encodePNG: encodePNG,
    downsample: downsample,
    surfaceFromRGBA: surfaceFromRGBA,
    scalers: scalers,
  };
}(globalThis.DSH_PEN));
