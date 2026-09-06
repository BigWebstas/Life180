// ./charts/positions.js
// Chart split into 4/6/8/12-hour segments in the "Chart" TAB
// - Global range: 00:00 (first day) -> 23:59 (last day)
// - Hours outside the real data range: blank
// - Pointer cursor when hovering the chart
// - No extra padding/gutter: avoids gaps on the left/right
// - Headers:
//     * Date (only on the first segment of the day) using formatDate()
//     * Hours (below each segment): start HH:mm on the left and end HH:mm on the right
// - Separators:
//     * Thin gray line flush with the chart (above the hours) on EVERY segment
//     * Blue end-of-day line (1px) below the hours on the LAST segment of each day
// - Marker:
//     * Triangle above the chart, pointing DOWN, with a fixed reserved strip (no dynamic changes)
//     * The vertical line goes into the triangle up to its center
//     * Triangle and line use the same color as the date/hours
// - Click on the chart: selects the nearest row in the table
//
// Usage: renderPositionsChart(positions, { segmentHours: 6, graphHeight: 50 })

import { handleZonePosition, getZoneStyleById } from '../screens/zones.js';
import { toRgba } from '../utils/dialogs.js';
import { formatDate } from '../globals.js';

const ALPHA = 0.3;

// Colores
const COLOR_DARK_BLUE = '#003366';
const COLOR_SEP_GRAY  = '#d1d5db'; // thin gray for the separator flush with the chart

// Alturas (en px)
const DATE_HDR_H               = 18;
const DATE_TOP_PAD             = 4;
const DATE_BOTTOM_GAP          = 6;
const INTRA_DAY_TOP_GAP        = 0;
const TIME_FOOTER_H            = 12;
const DAY_END_EXTRA_FOOTER_PAD = 18;

// Marker (triangle ABOVE the chart, pointing DOWN)
const MARKER_TRI_W   = 10;
const MARKER_TRI_H   = 10;
const MARKER_STRIP_H = 10; // fixed marker strip

// Fixed base height of the chart area
const DEFAULT_GRAPH_H = 50;

// State
let stackHost = null;
let scrollContainer = null; // resolves to the real scrollable container
let panels = [];            // [{ canvas, ctx, t0, t1, labelEnd, isDayStart, isDayEnd, _topGap, _footerH }]
let resizeObs = null;
let containerResizeObs = null;

let lastData = null; // { positions, opts, dataT0, dataT1, vmax, rangeStart, rangeEnd }
let clickBound = false;

/** Initializes/guarantees the segmented-header host in the Chart TAB */
export function initPositionsChart() {
  const chartSlot = document.getElementById('positions-chart');
  const chartContainer = document.querySelector('#chart .table-container');
  const positionsContainer = document.querySelector('#positions .table-container');

  // Prefer the Chart tab container if it exists
  scrollContainer = chartContainer || positionsContainer || scrollContainer || null;

  const hostParent = chartSlot || scrollContainer;
  if (!hostParent) return;

  if (!stackHost) {
    stackHost = document.createElement('div');
    stackHost.className = 'positions-chart-stack';
    stackHost.style.boxSizing = 'border-box';
    stackHost.style.cursor = 'default';
    stackHost.style.margin = '0';
    hostParent.prepend(stackHost);

    // Reserve thead space only in Positions (for the sticky thead)
    if (scrollContainer === positionsContainer) {
      positionsContainer.classList.add('chart-has-header');
    }

    if (!resizeObs) {
      resizeObs = new ResizeObserver(() => {
        if (lastData) drawAll(lastData.positions, lastData.opts || {});
      });
      resizeObs.observe(stackHost);
    }
  }

  // Bind listeners to the real scroller (can change when tabs change)
  bindRealScroller();

  updateHeaderMetrics();
  ensureClickHandlers();
}

export function onChartTabShown() {
  initPositionsChart();   // ensure the host
  bindRealScroller();     // re-resolve the real scroller if it changed with the tab
  updateHeaderMetrics();  // recompute the header metrics

  const t = toTsMs(lastData?.opts?.markerTs);
  if (Number.isFinite(t)) {
    afterReflow(() => ensureMarkerPanelInView(t)); // center the marker segment
  }
}

/** Fully clears the header and the chart state */
export function clearPositionsChart() {
  if (!stackHost) return;
  stackHost.innerHTML = '';
  panels = [];
  lastData = null;
  stackHost.style.cursor = 'default';
  updateHeaderMetrics();
}

/** Renders positions. opts may carry { segmentHours: 4|6|8|12, markerTs, graphHeight } */
export function renderPositionsChart(positions, opts = {}) {
  initPositionsChart();
  if (!stackHost) return;

  if (!Array.isArray(positions) || positions.length < 1) {
    clearPositionsChart();
    return;
  }

  const data = [...positions].sort(
    (a, b) => +new Date(a.last_updated) - +new Date(b.last_updated)
  );

  // Data extremes (honoring possible stop_start/stop_end)
  const startOf = (p) => {
    const tLU = +new Date(p.last_updated);
    const tSS = (p.stop && p.stop_start) ? +new Date(p.stop_start) : NaN;
    return Number.isFinite(tSS) ? Math.min(tLU, tSS) : tLU;
  };
  const endOf = (p) => {
    const tLU = +new Date(p.last_updated);
    const tSE = (p.stop && p.stop_end) ? +new Date(p.stop_end) : NaN;
    return Number.isFinite(tSE) ? Math.max(tLU, tSE) : tLU;
  };

  let dataT0 = startOf(data[0]);
  let dataT1 = endOf(data[0]);
  for (let i = 1; i < data.length; i++) {
    dataT0 = Math.min(dataT0, startOf(data[i]));
    dataT1 = Math.max(dataT1, endOf(data[i]));
  }

  // Segmented global range: 00:00 first day -> 23:59:59.999 last day (local time)
  const rangeStart = floorToLocalMidnight(new Date(dataT0));
  const rangeEnd   = setLocalTime(new Date(dataT1), 23, 59, 59, 999);

  const segH = normalizeSegHours(opts.segmentHours);
  const segments = buildSegments(rangeStart, rangeEnd, segH);

  // vmax global
  let vmax = 0;
  for (const p of data) {
    const v = Number(p?.attributes?.speed) || 0;
    if (v > vmax) vmax = v;
  }
  if (!Number.isFinite(vmax) || vmax <= 0) vmax = 1;

  lastData = { positions: data, opts, dataT0, dataT1, vmax, rangeStart: +rangeStart, rangeEnd: +rangeEnd };

  // Build/update panels with day start and end markers
  ensurePanelsWithDayMarkers(segments);

  // "pointer" cursor when there is data
  stackHost.style.cursor = 'pointer';
  for (const p of panels) p.canvas.style.cursor = 'pointer';

  // Draw all panels
  drawAll(data, opts);

  updateHeaderMetrics();

  // --- NEW: if there is already a marker, make sure to scroll to its segment when entering the tab ---
  const markerTs = toTsMs(lastData?.opts?.markerTs);
  if (Number.isFinite(markerTs)) {
    // wait for the tab to be visible and the canvas to reflow
    waitUntilVisible(stackHost, () => afterReflow(() => ensureMarkerPanelInView(markerTs)));
  }

  ensureClickHandlers();
}

/** Marks a time position (vertical line). */
export function setPositionsMarker(tsLike) {
  initPositionsChart();
  if (!lastData) return;
  const t = toTsMs(tsLike);
  lastData.opts = { ...(lastData.opts || {}), markerTs: t };
  drawAll(lastData.positions, lastData.opts);

  // --- NEW: try to scroll to the segment right away (if not visible, retry when it becomes visible) ---
  waitUntilVisible(stackHost, () => afterReflow(() => ensureMarkerPanelInView(t)));
}

/** Limpia el marcador */
export function clearPositionsMarker() {
  if (!lastData) return;
  if (lastData.opts) delete lastData.opts.markerTs;
  drawAll(lastData.positions, lastData.opts || {});
}

/* ===================== helpers de tiempo y segmentos ===================== */

function toTsMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return parseInt(v, 10);
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function floorToLocalMidnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function setLocalTime(d, hh, mm, ss = 0, ms = 0) {
  const x = new Date(d);
  x.setHours(hh, mm, ss, ms);
  return x;
}

function normalizeSegHours(h) {
  const ok = [4, 6, 8, 12];
  const n = Number(h);
  return ok.includes(n) ? n : 6;
}

/**
 * Construye tramos desde startDate hasta endDate (INCLUSIVE),
 * guardando:
 * - t0..t1: fin real a pintar (recortado a endDate)
 * - labelEnd: logical end of the segment (e.g. 00:00 of the next day)
 */
function buildSegments(startDate, endDate, segH) {
  const segs = [];
  let t0 = +startDate;
  const tEnd = +endDate;                  // 23:59:59.999
  const stepMs = segH * 3600 * 1000;

  while (t0 <= tEnd) {
    const logicalEnd = t0 + stepMs;
    const t1 = Math.min(logicalEnd, tEnd);
    segs.push({ t0, t1, labelEnd: logicalEnd });
    t0 += stepMs;
  }
  return segs;
}

function sameLocalDay(aMs, bMs) {
  const a = new Date(aMs), b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function fmtHM(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/* ===================== panel construction ===================== */

function ensurePanelsWithDayMarkers(segments) {
  // If the length matches, update times and recompute flags
  if (panels.length === segments.length) {
    for (let i = 0; i < panels.length; i++) {
      panels[i].t0 = segments[i].t0;
      panels[i].t1 = segments[i].t1;
      panels[i].labelEnd = segments[i].labelEnd;
      panels[i].isDayStart = (i === 0) || !sameLocalDay(segments[i].t0, segments[i - 1].t0);
      panels[i].isDayEnd   = (i === segments.length - 1) ||
                             !sameLocalDay(segments[i].t0, segments[i + 1]?.t0 || segments[i].t0);
    }
    return;
  }

  stackHost.innerHTML = '';
  panels = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const next = segments[i + 1];

    const canvas = document.createElement('canvas');
    canvas.className = 'positions-chart-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.border = 'none';
    stackHost.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    panels.push({
      canvas, ctx,
      t0: seg.t0,
      t1: seg.t1,
      labelEnd: seg.labelEnd,
      isDayStart: (i === 0) || !sameLocalDay(seg.t0, segments[i - 1]?.t0),
      isDayEnd:   (i === segments.length - 1) || !sameLocalDay(seg.t0, next?.t0 ?? seg.t0),
    });
  }
}

/* ===================== dibujo ===================== */

function drawAll(positions, opts) {
  if (!panels.length) return;

  const vmax = lastData?.vmax || 1;
  const dataT0 = lastData?.dataT0 ?? +new Date(positions[0].last_updated);
  const dataT1 = lastData?.dataT1 ?? +new Date(positions.at(-1).last_updated);

  // Fixed base height of the chart area
  const graphH = Number.isFinite(+opts.graphHeight) && +opts.graphHeight > 0
    ? Math.round(+opts.graphHeight)
    : DEFAULT_GRAPH_H;

  // 1) Adjust the HEIGHT of each panel (FIXED top gap + fixed marker strip)
  for (const panel of panels) {
    const dateH   = panel.isDayStart ? DATE_HDR_H : 0;
    const topGap  = panel.isDayStart ? DATE_BOTTOM_GAP : INTRA_DAY_TOP_GAP;
    const footerH = TIME_FOOTER_H + (panel.isDayEnd ? DAY_END_EXTRA_FOOTER_PAD : 0);
    const totalH  = MARKER_STRIP_H + graphH + dateH + topGap + footerH;

    panel._topGap = topGap;
    panel._footerH = footerH;

    panel.canvas.style.height = `${totalH}px`;
  }

  // 2) Draw each panel
  for (const panel of panels) {
    drawPanel(panel, positions, { vmax, dataT0, dataT1, markerTs: toTsMs(opts?.markerTs), graphH });
  }

  updateHeaderMetrics();
}

function drawPanel(panel, positions, meta) {
  const { canvas, ctx, t0, t1, labelEnd, isDayStart, isDayEnd } = panel;
  const dpr = window.devicePixelRatio || 1;

  // Dimensiones (tras fijar height arriba)
  const { width: cssW, height: cssH } = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const H = cssH;

  // Headers (fixed top gap) + fixed marker strip
  const dateH   = isDayStart ? DATE_HDR_H : 0;
  const topGap  = panel._topGap != null ? panel._topGap : (isDayStart ? DATE_BOTTOM_GAP : INTRA_DAY_TOP_GAP);
  const footerH = panel._footerH != null ? panel._footerH : (TIME_FOOTER_H + (isDayEnd ? DAY_END_EXTRA_FOOTER_PAD : 0));
  const headerH = MARKER_STRIP_H + dateH + topGap;

  // Chart area (two rows)
  const GAP_TRACKS = 0;
  const tracksH = Math.max(10, H - headerH - footerH);
  const trackH  = (tracksH - GAP_TRACKS) / 2;
  const topY    = headerH;
  const botY    = topY + trackH + GAP_TRACKS;

  // Fondo blanco
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // === DATE header (only the first segment of the day) ===
  if (dateH > 0) {
    ctx.save();
    ctx.fillStyle = COLOR_DARK_BLUE;
    ctx.font = 'bold 12px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const dateLabel = formatDate(new Date(t0), false);
    ctx.fillText(dateLabel, Math.floor(W / 2), DATE_TOP_PAD);
    ctx.restore();
  }

  // Intersection with the real data range
  const vis0 = Math.max(t0, meta.dataT0);
  const vis1 = Math.min(t1, meta.dataT1);

  // X scale local to the segment
  const xAt = (t) => {
    const span = Math.max(1, (t1 - t0));
    return ((t - t0) / span) * W;
  };

  // Points that intersect the visible segment
  const data = positions.filter(p => {
    const ts = +new Date(p.last_updated);
    const tsStart = p.stop && p.stop_start ? Math.min(ts, +new Date(p.stop_start)) : ts;
    const tsEnd   = p.stop && p.stop_end   ? Math.max(ts, +new Date(p.stop_end))   : ts;
    return !(tsEnd < vis0 || tsStart > vis1);
  });

  // Bands and speed line
  if (vis1 > vis0 && data.length) {
    drawBandByZone(ctx, data, { xAt, topY,        height: trackH, colorAlpha: ALPHA, clipStart: vis0, clipEnd: vis1 });
    drawBandStopMove(ctx, data, { xAt, topY: botY, height: trackH,                 clipStart: vis0, clipEnd: vis1 });
    drawSpeedStepLine(ctx, data, { xAt, topY: botY, height: trackH, vmax: lastData.vmax, clipStart: vis0, clipEnd: vis1 });

    // Marker: triangle ABOVE + line going in up to the center of the triangle
    const mTs = toTsMs(lastData?.opts?.markerTs);
    if (Number.isFinite(mTs) && mTs >= vis0 && mTs <= vis1) {
      const x = Math.round(xAt(mTs));

      ctx.save();
      ctx.lineCap = 'butt';
      ctx.fillStyle = COLOR_DARK_BLUE;
      ctx.strokeStyle = COLOR_DARK_BLUE;

      // Triangle above the chart
      const apexY = topY;                 // apex
      const baseY = apexY - MARKER_TRI_H; // top base
      ctx.beginPath();
      ctx.moveTo(x - MARKER_TRI_W / 2, baseY);
      ctx.lineTo(x + MARKER_TRI_W / 2, baseY);
      ctx.lineTo(x, apexY);
      ctx.closePath();
      ctx.fill();

      // Vertical line: starts at the middle of the triangle and goes down
      const insideY = apexY - (MARKER_TRI_H / 2);
      ctx.beginPath();
      ctx.moveTo(x, insideY);
      ctx.lineTo(x, topY + tracksH / 2);
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();
    }
  }

  // Gray separator flush with the chart (just above the hours)
  drawGraphBottomSeparator(ctx, W, headerH + tracksH);

  // Footer con horas
  drawTimesFooter(ctx, W, H, footerH, t0, labelEnd);

  // Blue end-of-day line
  if (isDayEnd) drawDayEndLine(ctx, W, H);
}

/* ====== piezas de dibujo ====== */

function zoneColorForPoint(p) {
  const lat = Number(p?.attributes?.latitude);
  const lon = Number(p?.attributes?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return toRgba('#ffffff', ALPHA);
  try {
    const z = handleZonePosition(lat, lon);
    if (z && z.id != null) {
      const style = getZoneStyleById(z.id);
      if (style?.color) return toRgba(style.color, ALPHA);
    }
  } catch {}
  return toRgba('#ffffff', ALPHA);
}

function drawBandByZone(ctx, data, { xAt, topY, height, colorAlpha, clipStart, clipEnd }) {
  let segStart = null;
  let curColor = null;

  for (let i = 0; i < data.length; i++) {
    const p = data[i];
    const ts = +new Date(p.last_updated);
    const col = zoneColorForPoint(p);
    const x = xAt(clamp(ts, clipStart, clipEnd));

    if (segStart == null) {
      segStart = x;
      curColor = col;
      continue;
    }

    if (col !== curColor) {
      drawRect(ctx, segStart, x, topY, height, curColor);
      segStart = x;
      curColor = col;
    }
  }
  if (segStart != null) {
    const xEnd = xAt(clipEnd);
    drawRect(ctx, segStart, xEnd, topY, height, curColor || toRgba('#ffffff', colorAlpha));
  }
}

function drawBandStopMove(ctx, data, { xAt, topY, height, clipStart, clipEnd }) {
  const colStop = toRgba('#ff0000', ALPHA);
  const colMove = toRgba('#00ff00', ALPHA);

  let segStart = null;
  let curStop = null;

  for (let i = 0; i < data.length; i++) {
    const p = data[i];
    const ts = +new Date(p.last_updated);
    const s = !!p.stop;
    const x = xAt(clamp(ts, clipStart, clipEnd));

    if (segStart == null) {
      segStart = x;
      curStop = s;
      continue;
    }

    if (s !== curStop) {
      drawRect(ctx, segStart, x, topY, height, curStop ? colStop : colMove);
      segStart = x;
      curStop = s;
    }
  }
  if (segStart != null) {
    drawRect(ctx, segStart, xAt(clipEnd), topY, height, curStop ? colStop : colMove);
  }
}

function drawSpeedStepLine(ctx, data, { xAt, topY, height, vmax, clipStart, clipEnd }) {
  const yFromV = (v) => {
    const vv = Math.max(0, Number(v) || 0);
    const yRel = vv / vmax;
    return topY + (1 - yRel) * height;
  };

  const pts = data.filter(p => {
    const ts = +new Date(p.last_updated);
    return ts >= clipStart && ts <= clipEnd;
  });
  if (!pts.length) return;

  ctx.beginPath();
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#227722';
  ctx.lineWidth = 1.2;

  const first = pts[0];
  let xPrev = xAt(+new Date(first.last_updated));
  let yPrev = yFromV(first?.attributes?.speed);

  if (pts.length === 1) {
    ctx.moveTo(xPrev, yPrev);
    ctx.lineTo(xAt(clipEnd), yPrev);
  } else {
    ctx.moveTo(xPrev, yPrev);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const xCur = xAt(+new Date(p.last_updated));
      const yCur = yFromV(p?.attributes?.speed);

      ctx.lineTo(xCur, yPrev);
      ctx.lineTo(xCur, yCur);

      xPrev = xCur;
      yPrev = yCur;
    }
    ctx.lineTo(xAt(clipEnd), yPrev);
  }
  ctx.stroke();
}

function drawRect(ctx, x0, x1, y, h, fill) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const w = Math.max(1, right - left);
  ctx.fillStyle = fill || '#fff';
  ctx.fillRect(left, y, w, h);
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* ====== separadores y footer ====== */

function drawGraphBottomSeparator(ctx, W, yBottomOfGraph) {
  ctx.save();
  ctx.strokeStyle = COLOR_SEP_GRAY;
  ctx.lineWidth = 1;
  const y = Math.floor(yBottomOfGraph) - 0.5;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(W, y);
  ctx.stroke();
  ctx.restore();
}

function drawTimesFooter(ctx, W, H, footerH, t0, labelEnd) {
  const yText = H - footerH + 1;
  ctx.save();
  ctx.fillStyle = COLOR_DARK_BLUE;
  ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.textBaseline = 'top';

  const startLabel = fmtHM(t0);
  const endLabel   = fmtHM(labelEnd);

  ctx.textAlign = 'left';
  ctx.fillText(startLabel, 4, yText);

  ctx.textAlign = 'right';
  ctx.fillText(endLabel, W - 4, yText);

  ctx.restore();
}

function drawDayEndLine(ctx, W, H) {
  ctx.save();
  ctx.strokeStyle = COLOR_DARK_BLUE;
  ctx.lineWidth = 1;
  const y = Math.floor(H) - 0.5;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(W, y);
  ctx.stroke();
  ctx.restore();
}

/* ===================== SCROLL AL TRAMO DEL MARCADOR ===================== */

// Encuentra el scroller real que contiene a stackHost
function resolveScrollContainer() {
  if (!stackHost) return document.scrollingElement || document.documentElement;

  // If we already have a valid scroller that contains stackHost, use it
  if (scrollContainer && scrollContainer.contains?.(stackHost)) return scrollContainer;

  // Walk up the ancestors looking for a scrollable overflowY
  for (let el = stackHost.parentElement; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay') &&
        el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return document.scrollingElement || document.documentElement;
}

function bindRealScroller() {
  const real = resolveScrollContainer();
  if (!real) return;

  if (containerResizeObs) containerResizeObs.disconnect?.();
  containerResizeObs = new ResizeObserver(updateHeaderMetrics);
  containerResizeObs.observe(real);

  real.removeEventListener?.('scroll', updateHeaderMetrics);
  real.addEventListener('scroll', updateHeaderMetrics, { passive: true });

  scrollContainer = real;
}

function afterReflow(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

function isDocScroller(scroller) {
  return !scroller || scroller === window ||
         scroller === document.scrollingElement ||
         scroller === document.documentElement ||
         scroller === document.body;
}

function getTopWithinScroller(el, scroller) {
  const er = el.getBoundingClientRect();
  if (isDocScroller(scroller)) {
    const st = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    return er.top + st;
  }
  const sr = scroller.getBoundingClientRect();
  return er.top - sr.top + scroller.scrollTop;
}

function panelIsVisible(panel, scroller) {
  if (!panel?.canvas) return true;
  const sTop = isDocScroller(scroller)
    ? (window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0)
    : scroller.scrollTop;
  const sH = isDocScroller(scroller) ? window.innerHeight : scroller.clientHeight;
  const pTop = getTopWithinScroller(panel.canvas, scroller);
  const pH = panel.canvas.offsetHeight || 1;
  return (pTop < sTop + sH) && (pTop + pH > sTop);
}

function findPanelForTs(ts) {
  if (!Array.isArray(panels) || panels.length === 0) return null;
  for (const p of panels) if (ts >= p.t0 && ts < p.labelEnd) return p;
  if (ts === panels.at(-1)?.labelEnd) return panels.at(-1);

  // the nearest one
  let best = null;
  for (const p of panels) {
    const mid = (p.t0 + p.labelEnd) / 2;
    const d = Math.abs(ts - mid);
    if (!best || d < best.d) best = { p, d };
  }
  return best?.p || null;
}

function scrollPanelIntoView(panel) {
  if (!panel?.canvas) return;
  const scroller = resolveScrollContainer();
  const sH = isDocScroller(scroller) ? window.innerHeight : scroller.clientHeight;
  const pTop = getTopWithinScroller(panel.canvas, scroller);
  const pH = panel.canvas.offsetHeight || 1;
  const target = Math.max(0, Math.round(pTop - (sH - pH) / 2));

  try {
    if (isDocScroller(scroller)) {
      window.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      scroller.scrollTo({ top: target, behavior: 'smooth' });
    }
  } catch {
    if (isDocScroller(scroller)) window.scrollTo(0, target);
    else scroller.scrollTop = target;
  }
}

function ensureMarkerPanelInView(ts) {
  const panel = findPanelForTs(ts);
  if (!panel) return;
  const scroller = resolveScrollContainer();
  if (!panelIsVisible(panel, scroller)) {
    scrollPanelIntoView(panel);
  }
}

/**
 * Waits until the element is "visible" (has layout and size)
 * y entonces ejecuta cb(). Si ya es visible, ejecuta ya.
 * Auto-detaches after 5s as a safeguard.
 */
function waitUntilVisible(el, cb) {
  if (!el?.isConnected) return;
  const isVisibleNow = () => {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // it used to require offsetParent !== null; that fails with certain layouts
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };

  if (isVisibleNow()) { cb(); return; }

  const mo = new MutationObserver(() => {
    if (isVisibleNow()) {
      mo.disconnect();
      afterReflow(cb);
    }
  });
  mo.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 5000); // safeguard
}

/* ===================== interaction (click -> select row) ===================== */

function ensureClickHandlers() {
  if (!stackHost || !panels.length) return;
  if (clickBound) return;

  stackHost.addEventListener('click', (ev) => {
    if (!lastData || !Array.isArray(lastData.positions) || lastData.positions.length === 0) return;

    // Locate the clicked panel by Y
    let chosen = null;
    for (const panel of panels) {
      const r = panel.canvas.getBoundingClientRect();
      if (ev.clientY >= r.top && ev.clientY <= r.bottom) { chosen = panel; break; }
    }
    if (!chosen) return;

    const rect = chosen.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const W = rect.width || 1;

    // Map X to time within the panel
    const t = chosen.t0 + (Math.max(0, Math.min(W, x)) / W) * (chosen.t1 - chosen.t0);

    // Only if it falls within the real data range (not blank)
    if (!(t >= lastData.dataT0 && t <= lastData.dataT1)) return;

    // Nearest position
    let best = null;
    for (const p of lastData.positions) {
      const ts = +new Date(p.last_updated);
      const d = Math.abs(ts - t);
      if (!best || d < best.d) best = { p, d };
    }
    if (!best) return;

    // Mark on the chart (this in turn forces a scroll if needed)
    setPositionsMarker(best.p.last_updated);

    // Fire an event so FILTER selects the row
    const uniqueId = `${best.p.entity_id}_${new Date(best.p.last_updated).toISOString()}`;
    document.dispatchEvent(new CustomEvent('positions:select-by-id', {
      detail: { uniqueId }
    }));
  });

  clickBound = true;
}

/* ===================== header metrics / scrollbar ===================== */

function updateHeaderMetrics() {
  if (!stackHost) return;

  // No side padding
  stackHost.style.paddingLeft = '0px';
  stackHost.style.paddingRight = '0px';

  // Reserve thead height ONLY when using the POSITIONS container
  const positionsContainer = document.querySelector('#positions .table-container');
  const sc = resolveScrollContainer();
  if (positionsContainer && sc === positionsContainer) {
    const stackH = stackHost.getBoundingClientRect().height;
    positionsContainer.style.setProperty('--chart-header-h', `${Math.ceil(stackH)}px`);
  }
}

