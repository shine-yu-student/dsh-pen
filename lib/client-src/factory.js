/**
 * Browser half of the `dsh-pen` bundle: the live canvas panel docked in the
 * right Sidebar, with mouse zoom and pan.
 *
 * The panel is a thin viewer. The Host owns the canvas, so every frame arrives
 * as a rendered PNG from the pen route, and the panel only reports state
 * (revision, size, operation count) while driving the user's actions — create a
 * canvas, clear it, export the PNG, zoom and pan the view. That keeps one
 * rasterizer authoritative for what the model sees and what the user exports.
 *
 * Two registrations make the panel reachable, and neither of them draws above
 * the composer: a page type in the right Sidebar (a static definition in
 * `ctx.sidebarRightTabs` plus the keyed `sidebar.right.pane.tab` body it names,
 * opened by `ctx.sidebarRight.openTab('pen')`), and one compact toggle in the
 * composer's tool row that opens, focuses, or closes that tab. A canvas that
 * appears while the tab is closed is revealed once per session, so the model's
 * first `pen_create` shows up without the user hunting for it.
 *
 * This file is a function body: `scripts/build.mjs` indents it into
 * `factory(require) { … }` in `lib/client/pen-client.js`, so it may only rely
 * on the module-table `require` and the slot props, and it imports no Harness
 * client package.
 */

const React = require('react');
const h = React.createElement;

/** This package's id: the tab type's identity and the cell its body registers under. */
const PKG_ID = '@local/dsh-pen';

/** Tab kind the panel owns; `ctx.sidebarRight.openTab(TAB_KIND)` opens it. */
const TAB_KIND = 'pen';

/** Route prefix served by the Host half. */
const PEN_ROUTE = '/pen';

/** Polling cadence while the panel is open; one request per tick per session. */
const POLL_MS = 700;

/** Slower cadence for the reveal watcher a closed panel runs. */
const REVEAL_POLL_MS = 2000;

/** Zoom bounds, the wheel's sensitivity, and the wheel's per-line delta. */
const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const WHEEL_SPEED = 0.0015;
const WHEEL_LINE = 16;

/** How much of the canvas must stay inside the viewport, in pixels, when panning. */
const PAN_MARGIN = 48;

/** Inset kept around the canvas when fitting it to the viewport. */
const FIT_PADDING = 16;

/** Below this window width the right Sidebar opens fullscreen, so a reveal would cover the conversation. */
const NARROW_WIDTH = 768;

/** Form defaults mirroring the plugin's own canvas defaults. */
const NEW_CANVAS = { width: 1024, height: 768, background: '#ffffff' };

/** Composer tool-row order: past the shipped compact controls, before submit. */
const TOGGLE_ORDER = 30;

/**
 * Component-local stylesheet. Hover, focus and cursor affordances need real
 * rules; every color is a theme token. Class names carry a `dsh-pen-` prefix so
 * the sheet cannot collide with the shell's, and `apply` removes it with the
 * plugin.
 */
const CSS = `
.dsh-pen-root {
  display: flex; flex: 1 1 auto; flex-direction: column; height: 100%; min-height: 0;
  color: var(--dsw-alias-label-primary); font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.5;
}
.dsh-pen-head {
  display: flex; flex: 0 0 auto; align-items: center; gap: 4px; box-sizing: border-box;
  height: 38px; padding: 0 6px 0 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.dsh-pen-status {
  flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
}
.dsh-pen-icon {
  display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dsh-pen-icon:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-pen-icon:disabled { opacity: 0.4; cursor: default; }
.dsh-pen-icon:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-pen-form {
  display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 6px;
  padding: 8px 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.dsh-pen-form label { color: var(--dsw-alias-label-secondary); }
.dsh-pen-form input[type="number"] {
  width: 68px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: inherit; font-variant-numeric: tabular-nums;
}
.dsh-pen-form input[type="color"] {
  width: 28px; height: 24px; padding: 0; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; background: transparent; cursor: pointer;
}
.dsh-pen-cta {
  padding: 3px 10px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 6px;
  background: var(--dsw-alias-brand-primary); color: #ffffff; font: inherit; cursor: pointer;
}
.dsh-pen-cta:disabled { opacity: 0.5; cursor: default; }
.dsh-pen-cta:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-pen-hint { color: var(--dsw-alias-label-secondary); }
.dsh-pen-error { flex: 0 0 auto; padding: 6px 12px; color: var(--dsw-alias-state-error-primary); }
.dsh-pen-stage {
  position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden;
  background: var(--dsw-alias-bg-base); touch-action: none; cursor: default;
  background-image:
    linear-gradient(45deg, var(--dsw-alias-bg-layer-2) 25%, transparent 25%, transparent 75%, var(--dsw-alias-bg-layer-2) 75%),
    linear-gradient(45deg, var(--dsw-alias-bg-layer-2) 25%, transparent 25%, transparent 75%, var(--dsw-alias-bg-layer-2) 75%);
  background-position: 0 0, 8px 8px; background-size: 16px 16px;
}
.dsh-pen-stage[data-pannable="true"] { cursor: grab; }
.dsh-pen-stage[data-panning="true"] { cursor: grabbing; }
.dsh-pen-canvas {
  position: absolute; left: 0; top: 0; display: block; transform-origin: 0 0;
  user-select: none; -webkit-user-drag: none;
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l1);
}
.dsh-pen-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px;
  align-items: center; justify-content: center; padding: 16px; text-align: center;
}
.dsh-pen-pill {
  position: absolute; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 2px;
  padding: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  background: var(--dsw-alias-bg-overlay); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.dsh-pen-pill button {
  display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px;
  padding: 0 6px; border: 0; border-radius: 999px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-variant-numeric: tabular-nums; cursor: pointer;
}
.dsh-pen-pill button:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-pen-pill button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-pen-pill .dsh-pen-readout { min-width: 44px; }
.dsh-pen-toggle {
  display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  padding: 0; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-state-idle-primary); cursor: pointer;
}
.dsh-pen-toggle:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-pen-toggle[data-open="true"] { color: var(--dsw-alias-brand-primary); }
.dsh-pen-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
`;

/** Stroke icons drawn locally, so the panel needs no icon package. */
const PATHS = {
  /** Placeholder-free mark for the dock toggle and the guide entry. */
  pen: ['M4 20l4.6-1.2L19.6 7.7a2.2 2.2 0 0 0-3.1-3.1L5.6 15.4 4 20z', 'M14.3 6.4l3.3 3.3'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M5 7h14', 'M10 7V4.8h4V7', 'M6.4 7l.9 12.2A1.8 1.8 0 0 0 9.1 21h5.8a1.8 1.8 0 0 0 1.8-1.8L17.6 7'],
  download: ['M12 4v11', 'M8 11.5l4 4 4-4', 'M5 19.5h14'],
  fit: ['M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9', 'M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9', 'M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15', 'M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15'],
};

/**
 * One stroke icon.
 * @param {{name: string, size?: number, className?: string}} props - glyph name and geometry.
 */
function Icon(props) {
  const size = props.size === undefined ? 16 : props.size;
  const paths = PATHS[props.name] || [];
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    className: props.className, 'aria-hidden': true, focusable: false,
  }, paths.map((d, index) => h('path', { key: index, d })));
}

/** The guide entry's glyph; the guide draws it before the title. */
function PenGuideIcon(props) {
  return h(Icon, { name: 'pen', size: props.size === undefined ? 16 : props.size, className: props.className });
}

/** Build the query string for one pen route call. */
function penUrl(path, sessionId, extra) {
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  for (const key of Object.keys(extra || {})) {
    if (extra[key] !== undefined && extra[key] !== null) params.set(key, String(extra[key]));
  }
  const query = params.toString();
  return `${PEN_ROUTE}${path}${query === '' ? '' : `?${query}`}`;
}

/** Read the canvas state for one session; `null` means no canvas exists yet. */
async function fetchState(sessionId, signal) {
  const response = await fetch(penUrl('/state', sessionId), { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`canvas state request failed (${response.status})`);
  const body = await response.json();
  if (!body || body.ok !== true) throw new Error((body && body.error) || 'canvas state request failed');
  return body.canvas || null;
}

/** Ask the Host to create or clear this session's canvas. */
async function postState(sessionId, body) {
  const response = await fetch(penUrl('/state', sessionId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ session: sessionId }, body)),
  });
  const answer = await response.json().catch(() => null);
  if (!response.ok || !answer || answer.ok !== true) {
    throw new Error((answer && answer.error) || `canvas request failed (${response.status})`);
  }
  return answer;
}

/** Download the full-resolution canvas as a PNG file. */
async function downloadPng(sessionId, canvas) {
  const response = await fetch(penUrl('/image', sessionId, { mode: 'full', rev: canvas.revision }));
  if (!response.ok) throw new Error(`canvas image request failed (${response.status})`);
  const blob = await response.blob();
  const safeName = String(canvas.name || 'canvas').replace(/[^A-Za-z0-9._-]+/g, '-') || 'canvas';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName}-${canvas.width}x${canvas.height}.png`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Clamp a zoom factor to the panel's bounds. */
function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Keep a piece of the canvas inside the viewport, so panning can never lose it.
 * @param {{scale: number, x: number, y: number}} view - the candidate view.
 * @param {{width: number, height: number}} box - the viewport's measured box.
 * @param {number} width - canvas width in canvas pixels.
 * @param {number} height - canvas height in canvas pixels.
 * @returns {object} the clamped view.
 */
function clampView(view, box, width, height) {
  const span = (offset, extent, limit) => {
    const low = PAN_MARGIN - extent;
    const high = limit - PAN_MARGIN;
    if (low > high) return (low + high) / 2;
    return Math.min(high, Math.max(low, offset));
  };
  return {
    scale: view.scale,
    x: span(view.x, width * view.scale, box.width),
    y: span(view.y, height * view.scale, box.height),
  };
}

/** Scale around one point of the viewport, so the pixel under the cursor stays put. */
function zoomAt(view, pointX, pointY, factor, box, width, height) {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  return clampView({
    scale,
    x: pointX - (pointX - view.x) * ratio,
    y: pointY - (pointY - view.y) * ratio,
  }, box, width, height);
}

/** Fit the whole canvas into the viewport, centered, never magnified past 100%. */
function fitView(box, width, height) {
  const scale = clampScale(Math.min(
    (box.width - FIT_PADDING * 2) / width,
    (box.height - FIT_PADDING * 2) / height,
    1,
  ));
  return {
    scale,
    x: (box.width - width * scale) / 2,
    y: (box.height - height * scale) / 2,
  };
}

/** The measured box of an element, in the shape the view math wants. */
function boxOf(element) {
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/**
 * The canvas panel: status line, the zoomable stage, and the panel's own actions.
 * @param {{sessionId: string, t: function(string): string}} props - slot props plus the bound translator.
 */
function PenCanvasPanel(props) {
  const sessionId = props.sessionId;
  const t = props.t;
  const [canvas, setCanvas] = React.useState(null);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(NEW_CANVAS);
  const [view, setView] = React.useState({ scale: 1, x: 0, y: 0 });
  const [panning, setPanning] = React.useState(false);
  const stage = React.useRef(null);
  const drag = React.useRef(null);
  // Once the user zooms or pans, a resize must not throw their view away.
  const adjusted = React.useRef(false);

  const painted = canvas !== null && canvas.operations > 0;
  const width = canvas === null ? 0 : canvas.width;
  const height = canvas === null ? 0 : canvas.height;
  const sizeKey = canvas === null ? 'none' : `${canvas.width}x${canvas.height}:${painted ? 'painted' : 'empty'}`;

  // A transient failure clears itself; the next successful poll also clears it.
  React.useEffect(() => {
    if (error === null) return undefined;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  // One poll per open panel. The revision doubles as the image cache key, so a
  // canvas change is what flips the <img> source and repaints the panel.
  React.useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await fetchState(sessionId, controller.signal);
        if (cancelled) return;
        setCanvas(next);
        setLoaded(true);
      } catch (failure) {
        if (cancelled || controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoaded(true);
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [sessionId]);

  // A new canvas size, and the first painted frame, start from a fitted view.
  React.useEffect(() => {
    const element = stage.current;
    if (element === null || !painted) return undefined;
    adjusted.current = false;
    setView(fitView(boxOf(element), width, height));
    return undefined;
  }, [sizeKey]);

  // Resizing the column or the pane refits, while the view is still the panel's.
  React.useEffect(() => {
    const element = stage.current;
    if (element === null || !painted || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (adjusted.current) return;
      setView(fitView(boxOf(element), width, height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sizeKey]);

  // Wheel zoom rides a native listener: React's own is passive, and this gesture
  // must consume the wheel instead of scrolling the column behind it.
  React.useEffect(() => {
    const element = stage.current;
    if (element === null || !painted || typeof element.addEventListener !== 'function') return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const box = { width: rect.width, height: rect.height };
      const unit = event.deltaMode === 1 ? WHEEL_LINE : event.deltaMode === 2 ? box.height : 1;
      adjusted.current = true;
      setView((previous) => zoomAt(
        previous,
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-event.deltaY * unit * WHEEL_SPEED),
        box, width, height,
      ));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [sizeKey, painted]);

  /** Run one panel action with the shared busy/error handling and a state refresh. */
  const run = async (action) => {
    setBusy(true);
    try {
      await action();
      setError(null);
      setCanvas(await fetchState(sessionId));
      setLoaded(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  /** One zoom step around the middle of the stage, which is where the buttons point. */
  const zoomBy = (factor) => {
    const element = stage.current;
    if (element === null) return;
    const box = boxOf(element);
    adjusted.current = true;
    setView((previous) => zoomAt(previous, box.width / 2, box.height / 2, factor, box, width, height));
  };

  /** Put the canvas back at its own pixel size, centered on the current point of interest. */
  const zoomToActual = () => {
    const element = stage.current;
    if (element === null) return;
    const box = boxOf(element);
    adjusted.current = true;
    setView((previous) => zoomAt(previous, box.width / 2, box.height / 2, 1 / previous.scale, box, width, height));
  };

  /** Fit the whole canvas again; a later resize keeps fitting until the user zooms. */
  const fitNow = () => {
    const element = stage.current;
    if (element === null) return;
    adjusted.current = false;
    setView(fitView(boxOf(element), width, height));
  };

  const onPointerDown = (event) => {
    if (!painted || (event.button !== 0 && event.button !== 1)) return;
    // The stage owns the gesture: no text selection under the drag, and no
    // middle-click autoscroll widget over the canvas.
    event.preventDefault();
    const element = event.currentTarget;
    if (typeof element.setPointerCapture === 'function') {
      try { element.setPointerCapture(event.pointerId); } catch (_unsupported) { /* capture is a nicety */ }
    }
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setPanning(true);
  };

  const onPointerMove = (event) => {
    const held = drag.current;
    if (held === null || held.pointerId !== event.pointerId) return;
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    held.x = event.clientX;
    held.y = event.clientY;
    const box = boxOf(event.currentTarget);
    adjusted.current = true;
    setView((previous) => clampView(
      { scale: previous.scale, x: previous.x + dx, y: previous.y + dy }, box, width, height,
    ));
  };

  const onPointerUp = (event) => {
    const held = drag.current;
    if (held === null || held.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    const element = event.currentTarget;
    if (typeof element.releasePointerCapture === 'function') {
      try { element.releasePointerCapture(event.pointerId); } catch (_unsupported) { /* already released */ }
    }
  };

  const onCreate = (event) => {
    event.preventDefault();
    void run(async () => {
      await postState(sessionId, {
        action: 'create',
        width: Number(draft.width) || NEW_CANVAS.width,
        height: Number(draft.height) || NEW_CANVAS.height,
        background: String(draft.background || NEW_CANVAS.background),
        name: 'canvas',
      });
      setFormOpen(false);
    });
  };

  const status = canvas === null
    ? (loaded ? t('none') : t('loading'))
    : `${canvas.width}×${canvas.height} · ${canvas.operations === 0 ? t('empty') : `${canvas.operations} ${t('operations')}`} · ${t('revision')} ${canvas.revision}`;

  const head = h('div', { className: 'dsh-pen-head' },
    h('span', { className: 'dsh-pen-status', title: status }, status),
    h('button', {
      type: 'button', className: 'dsh-pen-icon', disabled: busy,
      title: t('newCanvas'), 'aria-label': t('newCanvas'),
      'aria-pressed': formOpen ? 'true' : 'false',
      onClick: () => setFormOpen(!formOpen),
    }, h(Icon, { name: 'plus' })),
    h('button', {
      type: 'button', className: 'dsh-pen-icon', disabled: busy || canvas === null || canvas.operations === 0,
      title: t('clear'), 'aria-label': t('clear'),
      onClick: () => { void run(async () => { await postState(sessionId, { action: 'clear' }); }); },
    }, h(Icon, { name: 'trash' })),
    h('button', {
      type: 'button', className: 'dsh-pen-icon', disabled: busy || canvas === null,
      title: t('export'), 'aria-label': t('export'),
      onClick: () => { void run(async () => { await downloadPng(sessionId, canvas); }); },
    }, h(Icon, { name: 'download' })));

  // A click runs the same handler the form's submit does; the button stays
  // outside the submit path so one click cannot create the canvas twice.
  const form = !formOpen ? null : h('form', { className: 'dsh-pen-form', onSubmit: onCreate },
    h('label', { htmlFor: 'dsh-pen-width' }, t('width')),
    h('input', {
      id: 'dsh-pen-width', type: 'number', min: 16, max: 4096, step: 1, value: draft.width,
      onChange: (event) => setDraft(Object.assign({}, draft, { width: event.target.value })),
    }),
    h('label', { htmlFor: 'dsh-pen-height' }, t('height')),
    h('input', {
      id: 'dsh-pen-height', type: 'number', min: 16, max: 4096, step: 1, value: draft.height,
      onChange: (event) => setDraft(Object.assign({}, draft, { height: event.target.value })),
    }),
    h('label', { htmlFor: 'dsh-pen-background' }, t('background')),
    h('input', {
      id: 'dsh-pen-background', type: 'color', value: draft.background,
      onChange: (event) => setDraft(Object.assign({}, draft, { background: event.target.value })),
    }),
    h('button', { type: 'button', className: 'dsh-pen-cta', disabled: busy, onClick: onCreate }, t('create')));

  const image = h('img', {
    className: 'dsh-pen-canvas',
    alt: t('title'),
    draggable: false,
    src: penUrl('/image', sessionId, { mode: 'preview', rev: canvas === null ? 0 : canvas.revision }),
    style: {
      width: `${width}px`,
      height: `${height}px`,
      background: canvas === null ? 'transparent' : canvas.background,
      transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
      imageRendering: view.scale >= 3 ? 'pixelated' : 'auto',
    },
  });

  const pill = !painted ? null : h('div', { className: 'dsh-pen-pill' },
    h('button', {
      type: 'button', title: t('zoomOut'), 'aria-label': t('zoomOut'), onClick: () => zoomBy(1 / 1.4),
    }, '\u2212'),
    h('button', {
      type: 'button', className: 'dsh-pen-readout', title: t('zoomActual'), 'aria-label': t('zoomActual'),
      onClick: zoomToActual,
    }, `${Math.round(view.scale * 100)}%`),
    h('button', {
      type: 'button', title: t('zoomIn'), 'aria-label': t('zoomIn'), onClick: () => zoomBy(1.4),
    }, '+'),
    h('button', {
      type: 'button', title: t('zoomFit'), 'aria-label': t('zoomFit'), onClick: fitNow,
    }, h(Icon, { name: 'fit', size: 14 })));

  const stageNode = h('div', {
    className: 'dsh-pen-stage',
    ref: stage,
    'data-pannable': painted ? 'true' : 'false',
    'data-panning': panning ? 'true' : 'false',
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onDoubleClick: painted ? fitNow : undefined,
  },
  painted ? image : h('div', { className: 'dsh-pen-empty' },
    h('span', { className: 'dsh-pen-hint' }, canvas === null ? t('promptHint') : t('emptyHint')),
    h('button', { type: 'button', className: 'dsh-pen-cta', disabled: busy, onClick: () => setFormOpen(true) }, t('newCanvas'))),
  pill);

  return h('section', { className: 'dsh-pen-root', 'aria-label': t('title') },
    head,
    form,
    error === null ? null : h('div', { className: 'dsh-pen-error' }, error),
    stageNode);
}

/**
 * The composer's pen control: one compact button that opens the canvas tab,
 * focuses it when it is already open elsewhere in the column, closes it when it
 * is the visible tab, and — before either happens — reveals it once for a
 * session whose canvas appears while the tab is closed.
 * @param {{sessionId: string, t: function(string): string, sidebar: object}} props - slot props, the bound translator, and the right Sidebar service.
 */
function PenSidebarToggle(props) {
  const sessionId = props.sessionId;
  const t = props.t;
  const sidebar = props.sidebar;
  const [openTabId, setOpenTabId] = React.useState(null);
  const revealed = React.useRef(false);

  // The inventory is the one reactive source of "the pen tab is open here"; it
  // also marks any open — the user's or the watcher's — as already revealed, so
  // a tab the user closes is never reopened behind their back.
  React.useEffect(() => {
    if (!sidebar || !sessionId) return undefined;
    const read = () => {
      const row = sidebar.openTabs.getSnapshot().find((entry) => entry.kind === TAB_KIND && entry.sessionId === sessionId);
      if (row !== undefined) revealed.current = true;
      setOpenTabId(row === undefined ? null : row.tabId);
    };
    const unsubscribe = sidebar.openTabs.subscribe(read);
    read();
    return () => unsubscribe();
  }, [sidebar, sessionId]);

  // Reveal the panel once per session, when the model has something to show. A
  // narrow window is skipped: there the column opens fullscreen over the
  // conversation, which is not a reveal but an interruption. The first check
  // runs immediately, so a reload with a canvas already on it lands open.
  React.useEffect(() => {
    if (!sidebar || !sessionId || openTabId !== null || revealed.current) return undefined;
    if (typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth < NARROW_WIDTH) return undefined;
    let cancelled = false;
    let timer = null;
    const check = async () => {
      let state = null;
      try {
        state = await fetchState(sessionId);
      } catch (_offline) {
        return;
      }
      if (cancelled || state === null) return;
      revealed.current = true;
      if (timer !== null) clearInterval(timer);
      try {
        sidebar.openTab(TAB_KIND);
      } catch (_noSurface) { /* no mounted Session surface: the button still works */ }
    };
    timer = setInterval(() => { void check(); }, REVEAL_POLL_MS);
    void check();
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [sidebar, sessionId, openTabId]);

  const open = openTabId !== null;
  const frontTab = sidebar && open && sidebar.isExpanded() ? sidebar.active() : undefined;
  const front = frontTab !== undefined && frontTab.id === openTabId;

  const onClick = () => {
    if (!sidebar) return;
    try {
      if (front) sidebar.close(openTabId);
      else sidebar.openTab(TAB_KIND);
    } catch (_noSurface) { /* the column is not drawn for this Session */ }
  };

  return h('button', {
    type: 'button', className: 'dsh-pen-toggle', title: t('toggle'), 'aria-label': t('toggle'),
    'aria-pressed': open ? 'true' : 'false', 'data-open': open ? 'true' : 'false',
    onClick,
  }, h(Icon, { name: 'pen', size: 18 }));
}

/** Dictionary namespace the panel's own strings live under. */
const NS = 'penCanvas';

/** Both dictionaries, registered once with the Client locale service. */
const DICTIONARIES = {
  zh: {
    title: '画笔',
    toggle: '在右侧栏打开画布',
    loading: '正在检查画布…',
    none: '本会话还没有画布',
    empty: '空白',
    operations: '个操作',
    revision: '版本',
    newCanvas: '新建画布',
    create: '创建',
    export: '导出 PNG',
    clear: '清空',
    width: '宽',
    height: '高',
    background: '背景',
    zoomIn: '放大',
    zoomOut: '缩小',
    zoomFit: '适应窗口',
    zoomActual: '恢复 1:1',
    guideHint: '在右侧栏查看画布，滚轮缩放、拖拽移动',
    promptHint: '模型调用 pen_create 创建画布后，这里会显示画布内容。',
    emptyHint: '画布已就绪，模型的每一笔都会实时出现在这里。',
  },
  en: {
    title: 'Canvas',
    toggle: 'Open the canvas in the right sidebar',
    loading: 'Checking for a canvas…',
    none: 'No canvas in this session yet',
    empty: 'empty',
    operations: 'operations',
    revision: 'revision',
    newCanvas: 'New canvas',
    create: 'Create',
    export: 'Export PNG',
    clear: 'Clear',
    width: 'W',
    height: 'H',
    background: 'Background',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomFit: 'Fit to view',
    zoomActual: 'Actual size',
    guideHint: 'Watch the canvas in the right sidebar; wheel zooms, drag pans',
    promptHint: 'The canvas appears here after the model calls pen_create.',
    emptyHint: 'The canvas is ready; every stroke lands here as it is drawn.',
  },
};

return {
  inject: ['slots', 'locale'],
  apply(ctx) {
    const t = ctx.locale.bind(NS);
    ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-pen: panel dictionary');

    // One stylesheet for both seats: the composer toggle must be styled before
    // the panel body has ever mounted. Hover and focus need real rules, and the
    // sheet leaves with the plugin.
    ctx.effect(() => {
      if (typeof document === 'undefined' || document.head === undefined) return () => {};
      const sheet = document.createElement('style');
      sheet.textContent = CSS;
      document.head.appendChild(sheet);
      return () => { sheet.remove(); };
    }, 'dsh-pen: panel stylesheet');

    // The panel lives in the right Sidebar, so its two seats wait for that
    // column's services: without them this bundle simply contributes no UI
    // instead of failing to load.
    ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
      const sidebar = scope.sidebarRight;

      // Stage one: what the `pen` kind is — a page type, opened by kind.
      scope.effect(() => scope.sidebarRightTabs.register({
        id: PKG_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: () => t('title'),
        guide: [{ id: 'canvas', order: 40, title: () => t('title'), description: () => t('guideHint'), icon: PenGuideIcon }],
      }), 'dsh-pen: sidebar tab type');

      // Stage two: the body the kind's tabs render, keyed by the definition id.
      scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
        name: 'sidebar.right.pane.tab',
        key: PKG_ID,
        locale: NS,
      }, PenCanvasPanel)), 'dsh-pen: sidebar canvas body');

      // The way in and out of the column, in the composer's compact tool row.
      scope.effect(() => scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'pen-canvas-toggle',
        order: TOGGLE_ORDER,
        locale: NS,
      }, (props) => h(PenSidebarToggle, Object.assign({}, props, { sidebar })))), 'dsh-pen: composer toggle');
    });
  },
};
