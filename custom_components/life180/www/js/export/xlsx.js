// export/excel_xlsx.js
// Generates an .xlsx with ExcelJS:
// - Dark blue headers, white text (Verdana 9)
// - First row frozen
// - Column widths fitted to content
// - Verdana 9 font throughout the workbook
// - Every cell aligned middle vertically and left horizontally
// - Only "Address" wraps

import { t } from '../utils/i18n.js';

const EXCELJS_CDN = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";

async function ensureExcelJS() {
  if (window.ExcelJS) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = EXCELJS_CDN;
    s.async = true;
    s.onload = () => res();
    s.onerror = (e) => rej(e);
    document.head.appendChild(s);
  });
}

function toFixed6(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Number(v.toFixed(6)) : null; // as a number
}

function speedInConfiguredUnits(mps) {
  if (!Number.isFinite(mps)) return null;
  return Math.round(mps * 3.6 * 0.621371192); // m/s -> mph
}

// Maximum length per line (for auto width)
function maxLineLen(s) {
  return String(s || '').split('\n').reduce((m, line) => Math.max(m, line.length), 0);
}

// Compute widths (in "char width") from the content
function computeColWidths(rows, headers) {
  // indices: 0 date, 1 stop, 2 lat, 3 lon, 4 speed, 5 batt, 6 zone, 7 addr
  const mins = [19, 6, 11, 11, 12, 8, 18, 30];  // reasonable minimums
  const maxs = [40,10, 16, 16, 16,10, 50, 80];  // limits so it does not overflow
  const lens = headers.map(h => maxLineLen(h));

  for (const r of rows) {
    lens[0] = Math.max(lens[0], maxLineLen(r.date));
    lens[1] = Math.max(lens[1], maxLineLen(r.stop));
    lens[2] = Math.max(lens[2], maxLineLen(r.latStr));
    lens[3] = Math.max(lens[3], maxLineLen(r.lonStr));
    lens[4] = Math.max(lens[4], maxLineLen(r.speedStr));
    lens[5] = Math.max(lens[5], maxLineLen(r.battStr));
    lens[6] = Math.max(lens[6], maxLineLen(r.zone));
    lens[7] = Math.max(lens[7], maxLineLen(r.address));
  }

  // margen extra (+2)
  return lens.map((L, i) => Math.min(maxs[i], Math.max(mins[i], L + 2)));
}

export async function exportPositionsToXlsx(positions, {
  filename = 'life180.xlsx',
  formatLocal = (d) => new Date(d).toLocaleString(),
  sheetName = t('positions'),
} = {}) {
  await ensureExcelJS();
  const ExcelJS = window.ExcelJS;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  // —— Estilo base (Verdana 9) ——
  const BASE_FONT  = { name: 'Verdana', size: 9 };
  const BASE_ALIGN = { vertical: 'middle', horizontal: 'left' };

  const speedHeader = t('mi_per_hour');

  const headers = [
    t('date'),
    t('stops'),
    t('latitude'),
    t('longitude'),
    speedHeader,
    t('battery'),
    t('zone'),
    t('address'),
  ];

  // Normaliza filas
  const rows = (positions || []).map(p => {
    const date  = formatLocal ? formatLocal(p?.last_updated) : (p?.last_updated || '');
    const stop  = p?.stop ? t('stop') : '';
    const lat   = toFixed6(p?.attributes?.latitude);
    const lon   = toFixed6(p?.attributes?.longitude);
    const speed = speedInConfiguredUnits(Number(p?.attributes?.speed));
    const batt  = Number.isFinite(p?.battery) ? p.battery : null;
    const zone  = p?.zone || '';
    const address = (p?.address || '').replace(/\u00A0/g, ' ');

    return {
      date,
      stop,
      lat,
      lon,
      speed,
      batt,
      latStr:   lat   == null ? '' : String(lat),
      lonStr:   lon   == null ? '' : String(lon),
      speedStr: speed == null ? '' : String(speed),
      battStr:  batt  == null ? '' : String(batt),
      zone,
      address
    };
  });

  // Cabeceras: azul oscuro + blanco, Verdana 9, vertical middle + left
  const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003E78' } };
  const headFont = { ...BASE_FONT, bold: true, color: { argb: 'FFFFFFFF' } };
  const headAlignment = { ...BASE_ALIGN, wrapText: true };

  ws.addRow(headers);
  const headerRow = ws.getRow(1);
  headerRow.height = 18;
  headerRow.font = headFont;
  headerRow.alignment = headAlignment;
  headerRow.eachCell(c => {
    c.fill = headFill;
    c.font = headFont;
    c.alignment = headAlignment;
  });

  // Data (numbers as numbers; wrap only in Address)
  for (const r of rows) {
    const row = ws.addRow([
      r.date,
      r.stop,
      r.lat,
      r.lon,
      r.speed,
      r.batt,
      r.zone,
      r.address
    ]);
    row.font = BASE_FONT;
    row.alignment = BASE_ALIGN; // all cells: middle + left
  }

  // Freeze the first row
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Width fitting + per-column style/ALIGNMENT (with wrap in Address)
  const widths = computeColWidths(rows, headers);
  ws.columns = widths.map((w, i) => ({
    width: w,
    style: {
      font: BASE_FONT,
      alignment: { ...BASE_ALIGN, wrapText: i === 7 } // i===7 -> "Address"
    }
  }));

  // Reassert the header after defining the columns
  ws.getRow(1).eachCell(c => {
    c.font = headFont;
    c.alignment = headAlignment;
    c.fill = headFill;
  });

  // Descargar
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}
