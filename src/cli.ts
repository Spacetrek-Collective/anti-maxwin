import { parseArgs } from 'node:util';
import { db, addCandidate } from './db.ts';
import { discoverCrtsh, DEFAULT_KEYWORDS } from './discover/crtsh.ts';
import { importFile } from './discover/file.ts';
import { discoverVariants } from './discover/variants.ts';
import { verify } from './verify.ts';
import { exportBatches } from './export.ts';
import { normalize } from './normalize.ts';

const HELP = `Anti Maxwin — pipeline discovery & verifikasi situs ilegal

  crtsh [--days 60] [--kw gacor,slot]   cari domain baru di Certificate Transparency
  import <file.txt>                    ambil URL dari file teks (hasil dork, Telegram, dll)
  variants <brand> [brand...]          tebak domain alternatif dari nama brand (cek DNS)
  add <url> [url...]                   tambah kandidat manual
  verify [--limit 50]                  buka halaman + klasifikasi AI
  review                               daftar link yang butuh dicek manusia
  approve <url...> | reject <url...>   putuskan hasil review
  export                               tulis link verified ke data/batches/*.txt (20/batch)
  stats                                ringkasan status`;

const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: { days: { type: 'string', default: '60' }, kw: { type: 'string' }, limit: { type: 'string', default: '50' } },
});

const setStatus = (status: string) => {
  for (const u of positionals) {
    const n = normalize(u);
    const changed = n.ok ? Number(db.prepare('UPDATE links SET status = ? WHERE key = ?').run(status, n.key).changes) : 0;
    console.log(changed ? `${status}: ${u}` : `tidak ditemukan: ${u}`);
  }
};

switch (cmd) {
  case 'crtsh':
    await discoverCrtsh(values.kw ? values.kw.split(',') : DEFAULT_KEYWORDS, Number(values.days));
    break;
  case 'import':
    console.log(`${importFile(positionals[0]!)} kandidat baru`);
    break;
  case 'variants':
    await discoverVariants(positionals.map((b) => b.toLowerCase()));
    break;
  case 'add':
    console.log(`${positionals.filter((u) => addCandidate(u, 'manual')).length} kandidat baru`);
    break;
  case 'verify':
    await verify(Number(values.limit));
    break;
  case 'review':
    console.table(
      db.prepare("SELECT key, label, confidence, reason, screenshot FROM links WHERE status = 'review' ORDER BY confidence DESC").all(),
    );
    break;
  case 'approve':
    setStatus('verified');
    break;
  case 'reject':
    setStatus('rejected');
    break;
  case 'export':
    exportBatches();
    break;
  case 'stats':
    console.table(db.prepare('SELECT status, source, COUNT(*) AS n FROM links GROUP BY status, source ORDER BY status').all());
    break;
  default:
    console.log(HELP);
}
