import ExcelJS from 'exceljs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRelevantJobs, DEFAULT_CLIENT_ID } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function log(msg) {
  console.log(`[${new Date().toISOString()}] [exporter] ${msg}`);
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('de-DE');
}

// Per-client export path. The default client keeps the original filename for
// backward compatibility; other clients get a suffixed file.
export function exportPath(clientId = DEFAULT_CLIENT_ID) {
  return clientId === DEFAULT_CLIENT_ID
    ? path.join(DATA_DIR, 'relevant_jobs.xlsx')
    : path.join(DATA_DIR, `relevant_jobs_${clientId}.xlsx`);
}

export async function exportToExcel(clientId = DEFAULT_CLIENT_ID) {
  const OUT_PATH = exportPath(clientId);
  const jobs = getRelevantJobs(clientId);
  if (jobs.length === 0) {
    log('No relevant jobs to export.');
    return;
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Relevante Jobs');

  const STATUS_LABELS = { applied: 'Beworben', interview: 'Interview', offer: 'Angebot', rejected: 'Abgelehnt' };

  ws.columns = [
    { header: 'Firma',           key: 'company',    width: 28 },
    { header: 'Ort',             key: 'location',   width: 20 },
    { header: 'Jobbezeichnung',  key: 'title',      width: 40 },
    { header: 'Score',           key: 'score',      width: 8  },
    { header: 'Zusammenfassung', key: 'summary',    width: 55 },
    { header: 'Quelle',          key: 'source',     width: 22 },
    { header: 'Gefunden am',     key: 'scraped_at', width: 14 },
    { header: 'URL',             key: 'url',        width: 55 },
    { header: 'ID',              key: 'id',         width: 18 },
    { header: 'Beworben am',     key: 'applied_at', width: 14 },
    { header: 'Status',          key: 'status',     width: 14 },
  ];

  // Header styling
  const headerRow = ws.getRow(1);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D6A4F' } };
    cell.alignment = { vertical: 'middle' };
  });
  headerRow.height = 20;
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const job of jobs) {
    const row = ws.addRow({
      company:    job.company    || '',
      location:   job.location   || '',
      title:      job.title      || '',
      score:      job.score      ?? '',
      summary:    job.summary    || '',
      source:     job.source     || '',
      scraped_at: formatDate(job.scraped_at),
      url:        job.url        || '',
      id:         job.id         || '',
      applied_at: formatDate(job.applied_at),
      status:     STATUS_LABELS[job.status] || '',
    });

    // Make URL a hyperlink
    if (job.url) {
      const urlCell = row.getCell('url');
      urlCell.value = { text: job.url, hyperlink: job.url };
      urlCell.font = { color: { argb: 'FF0563C1' }, underline: true };
    }

    // Applied rows: blue background. Non-applied: color by score.
    const score = job.score ?? 0;
    const bgColor = job.applied
      ? 'FFD0E4FF'
      : score >= 8 ? 'FFD8F3DC' : score >= 6 ? 'FFFFFDE7' : 'FFFFFFFF';
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
      cell.alignment = { wrapText: false, vertical: 'top' };
    });
  }

  // Auto-filter
  ws.autoFilter = { from: 'A1', to: 'K1' };

  await wb.xlsx.writeFile(OUT_PATH);
  log(`Exported ${jobs.length} relevant job(s) → ${OUT_PATH}`);
  return OUT_PATH;
}
