// Export link verified ke file batch 20 baris (format batch submit panitia), urut confidence tertinggi.
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from './config.ts';
import { db } from './db.ts';

export function exportBatches() {
  const rows = db
    .prepare("SELECT key, url FROM links WHERE status = 'verified' ORDER BY confidence DESC, checked_at")
    .all() as { key: string; url: string }[];
  if (!rows.length) return console.log('Tidak ada link verified yang belum diexport.');

  const dir = `${config.dataDir}/batches`;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const mark = db.prepare("UPDATE links SET status = 'exported', exported_at = datetime('now'), batch = ? WHERE key = ?");

  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    const name = `batch-${stamp}-${String(i / 20 + 1).padStart(3, '0')}.txt`;
    writeFileSync(`${dir}/${name}`, chunk.map((r) => r.url).join('\n') + '\n');
    for (const r of chunk) mark.run(name, r.key);
    console.log(`${dir}/${name}  (${chunk.length} link)`);
  }
}
