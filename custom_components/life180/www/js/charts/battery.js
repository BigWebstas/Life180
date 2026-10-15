// ./charts/battery.js
// Battery level over the filtered range, in the "Chart" tab under the speed chart.
// Step line: green where the level rose (charging), accent otherwise, and a red band
// below the low-battery threshold.

import { t } from '../utils/i18n.js';
import { formatDate } from '../globals.js';

const LOW_BATTERY_PCT = 15;
const HEIGHT = 120;
const PAD = { left: 30, right: 8, top: 8, bottom: 18 };

let series = [];

const token = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function draw() {
    const host = document.getElementById('battery-chart');
    const canvas = host?.querySelector('canvas');
    if (!canvas || series.length === 0) return;

    const width = host.clientWidth;
    if (!width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    canvas.style.height = `${HEIGHT}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    const text = token('--l180-text-2', '#444');
    const divider = token('--l180-divider', '#d1d5db');
    const accent = token('--l180-primary', '#0b57d0');
    const danger = token('--l180-danger', '#b3261e');
    const success = token('--l180-success', '#2e7d32');

    const t0 = Date.parse(series[0][0]);
    const t1 = Date.parse(series[series.length - 1][0]);
    const x = ts => PAD.left + (t1 > t0 ? (ts - t0) / (t1 - t0) : 0) * (width - PAD.left - PAD.right);
    const y = pct => PAD.top + (1 - pct / 100) * (HEIGHT - PAD.top - PAD.bottom);

    ctx.fillStyle = danger;
    ctx.globalAlpha = 0.15;
    ctx.fillRect(PAD.left, y(LOW_BATTERY_PCT), width - PAD.left - PAD.right, y(0) - y(LOW_BATTERY_PCT));
    ctx.globalAlpha = 1;

    ctx.font = '11px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    ctx.fillStyle = text;
    ctx.strokeStyle = divider;
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const pct of [0, 50, 100]) {
        ctx.beginPath();
        ctx.moveTo(PAD.left, Math.round(y(pct)) + 0.5);
        ctx.lineTo(width - PAD.right, Math.round(y(pct)) + 0.5);
        ctx.stroke();
        ctx.fillText(`${pct}%`, PAD.left - 4, y(pct));
    }
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(formatDate(series[0][0]), PAD.left, HEIGHT - PAD.bottom + 4);
    ctx.textAlign = 'right';
    ctx.fillText(formatDate(series[series.length - 1][0]), width - PAD.right, HEIGHT - PAD.bottom + 4);

    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let i = 1; i < series.length; i++) {
        const [ta, pa] = series[i - 1];
        const [tb, pb] = series[i];
        ctx.strokeStyle = pb > pa ? success : accent;
        ctx.beginPath();
        ctx.moveTo(x(Date.parse(ta)), y(pa));
        ctx.lineTo(x(Date.parse(tb)), y(pa));
        ctx.lineTo(x(Date.parse(tb)), y(pb));
        ctx.stroke();
    }
}

function ensureHost() {
    const host = document.getElementById('battery-chart');
    if (host && !host.querySelector('canvas')) {
        const title = document.createElement('div');
        title.className = 'battery-chart-title';
        title.textContent = t('battery');
        host.append(title, document.createElement('canvas'));
        new ResizeObserver(draw).observe(host);
    }
    return host;
}

/** series: [[iso, pct], ...] from the server's `battery`. */
export function renderBatteryChart(data = []) {
    series = data;
    const host = ensureHost();
    if (!host) return;
    host.classList.toggle('hidden', series.length === 0);
    draw();
}

export function clearBatteryChart() {
    renderBatteryChart([]);
}
