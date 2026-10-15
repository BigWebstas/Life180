//
// SNAPSHOT
// Saves/shares the current map (people pins, names, battery) as a PNG.
//

import { isAdmin } from '../globals.js';
import { t } from '../utils/i18n.js';
import { toast } from '../utils/dialogs.js';
import { map } from '../utils/map.js';
import { getSnapshotPeople } from './persons.js';

function drawPin(ctx, x, y, person, s) {
    const label = person.battery == null ? person.name : `${person.name} · ${person.battery}%`;
    ctx.font = `600 ${13 * s}px sans-serif`;
    const w = ctx.measureText(label).width + 16 * s;
    const h = 22 * s;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = s;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 34 * s - h, w, h, 11 * s);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y - 34 * s - h / 2);
    ctx.fillStyle = '#1a73e8';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.arc(x, y, 9 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
}

function renderSnapshot() {
    const ml = map._ml;
    const src = ml.getCanvas();
    const s = src.width / ml.getContainer().clientWidth;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0);
    getSnapshotPeople().forEach(p => {
        const pt = ml.project([p.lng, p.lat]);
        drawPin(ctx, pt.x * s, pt.y * s, p, s);
    });
    const stamp = `${new Date().toLocaleString()}  ·  © OpenStreetMap contributors`;
    ctx.font = `${11 * s}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(out.width - ctx.measureText(stamp).width - 12 * s, out.height - 18 * s, out.width, 18 * s);
    ctx.fillStyle = '#222';
    ctx.fillText(stamp, out.width - 6 * s, out.height - 4 * s);
    return new Promise(resolve => out.toBlob(resolve, 'image/png'));
}

async function takeSnapshot() {
    const blob = await renderSnapshot();
    if (!blob) return;
    const file = new File([blob], 'life180-snapshot.png', { type: 'image/png' });
    try {
        if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: 'Life180' });
            return;
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    toast(t('snapshot_saved'));
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function initSnapshot() {
    const btn = document.getElementById('snapshot-button');
    if (!btn || !isAdmin) return;
    btn.style.display = '';
    btn.addEventListener('click', () => takeSnapshot().catch(e => console.error('Snapshot failed:', e)));
}
