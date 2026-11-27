// Export antrean submit (status queued) ke file batch 20 baris (format batch submit panitia),
// urut confidence tertinggi. Link yang diexport ditandai submitted atas nama MEMBER.
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from './config.ts';
import { takeBatch } from './db.ts';

export function exportBatches(max = Infinity) {
  const dir = `${config.dataDir}/batches`;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() + 7 * 3_600_000).toISOString().replace(/[-:]/g, '').slice(0, 13);
  let total = 0;
  for (let i = 1; total < max; i++) {
    const name = `batch-${stamp}-${String(i).padStart(3, '0')}.txt`;
    const rows = takeBatch(Math.min(20, max - total), name);
    if (!rows.length) break;
    writeFileSync(`${dir}/${name}`, rows.map((r) => r.url).join('\n') + '\n');
    console.log(`${dir}/${name}  (${rows.length} link)`);
    total += rows.length;
  }
  if (!total) console.log('Antrean submit kosong (approve dulu link verified/review).');
}
