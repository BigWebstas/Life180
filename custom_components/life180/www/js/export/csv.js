// export/csv.js
// Builds and downloads a CSV of positions (stops / non-stops)
// Fields: local date, stop, lat, lon, speed, battery, zone, address.

import { t } from '../utils/i18n.js';

function sanitizeField(v) {
    if (v == null)
        return '';
    const s = String(v).replace(/\r?\n/g, ' ').trim();
    // CSV-safe within double quotes (doubling internal quotes)
    return `"${s.replace(/"/g, '""')}"`;
}

function toFixed6(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(6) : '';
}

function speedInConfiguredUnits(mps) {
    if (!Number.isFinite(mps))
        return '';
    const mph = mps * 3.6 * 0.621371192;
    return Math.round(mph);
}

/**
 * Construye el CSV (texto). Velocidad siempre en mph.
 *
 * @param {Array} positions  [{ last_updated, stop, battery, zone, address, attributes:{latitude, longitude, speed(m/s)}}, ...]
 * @param {Object} options
 * @param {(d:any)=>string} options.formatLocal  formateador de fecha local (p.ej. formatDate)
 * @param {string} [options.delimiter=';']  separador (por defecto ';' para Excel ES)
 * @returns {string} CSV
 */
export function buildCsv(positions, {
    formatLocal,
    delimiter = ';',
} = {}) {
    const speedHeader = t('mi_per_hour');

    const header = [
        t('date'),
        t('stops'),
        t('latitude'),
        t('longitude'),
        speedHeader,
        t('battery'),
        t('zone'),
        t('address'),
    ];

    const rows = [header.map(sanitizeField).join(delimiter)];

    for (const p of(positions || [])) {
        const lat = p?.attributes?.latitude;
        const lon = p?.attributes?.longitude;

        const fechaLocal = formatLocal ? formatLocal(p?.last_updated) : (p?.last_updated || '');
        const parada = p?.stop ? t('stop') : '';
        const vel = speedInConfiguredUnits(Number(p?.attributes?.speed));
        const bat = Number.isFinite(p?.battery) ? p.battery : '';

        const row = [
            fechaLocal,
            parada,
            toFixed6(lat),
            toFixed6(lon),
            vel,
            bat,
            (p?.zone || ''),
            (p?.address || ''),
        ].map(sanitizeField).join(delimiter);

        rows.push(row);
    }

    return rows.join('\n');
}

export function downloadCsv(filename, csvString) {
    // Add a BOM so Excel detects UTF-8
    const blob = new Blob(['\uFEFF' + csvString], {
        type: 'text/csv;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

export async function saveCsvWithPicker(filename, csvString) {
    const blob = new Blob(['\uFEFF' + csvString], {
        type: 'text/csv;charset=utf-8'
    });
    if ('showSaveFilePicker' in window) {
        const handle = await window.showSaveFilePicker({
            suggestedName: filename.endsWith('.csv') ? filename : `${filename}.csv`,
            types: [{
                    description: 'CSV',
                    accept: {
                        'text/csv': ['.csv']
                    }
                }
            ],
        });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
    } else {
        downloadCsv(filename, csvString);
    }
}

/**
 * Helper: construye y guarda el CSV.
 * @param {Array} positions
 * @param {Object} options  { filename, formatLocal, delimiter=';', usePicker=false }
 */
export async function exportPositionsToCsv(positions, {
    filename,
    formatLocal,
    delimiter = ';',
    usePicker = false,
} = {}) {
    const csv = buildCsv(positions, {
        formatLocal,
        delimiter
    });
    if (usePicker) {
        await saveCsvWithPicker(filename, csv);
    } else {
        downloadCsv(filename, csv);
    }
}
