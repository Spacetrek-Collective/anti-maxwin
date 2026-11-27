// ⚠️ Beberapa perintah di sini membuka situs berbahaya (fetch, verify, ads, worker fetch/ads).
// Jalankan HANYA di container di VPS sekali pakai. Lihat CLAUDE.md dan README.
import { parseArgs } from 'node:util';
import { db, addCandidate, decide } from './db.ts';
import { discoverCrtsh, DEFAULT_KEYWORDS } from './discover/crtsh.ts';
import { importFile } from './discover/file.ts';
import { discoverVariants } from './discover/variants.ts';
import { discoverSearch, readDorks } from './discover/search.ts';
import { pivotBrands } from './discover/pivot.ts';
import { exportBatches } from './export.ts';
import { normalize } from './normalize.ts';
import { config } from './config.ts';

const HELP = `Anti Maxwin — pipeline discovery & verifikasi situs ilegal

Discovery (tidak membuka situs kandidat):
  crtsh [--days 30] [--kw gacor,slot]   domain baru dari Certificate Transparency
  search [--file dorks/judol.txt]       dork via SearXNG (service searxng di compose)
  import <file.txt>                     ambil URL dari file teks (hasil dork manual, Telegram, dll)
  variants <brand> [brand...]           tebak domain alternatif dari brand (cek DNS)
  pivot [--limit 10]                    pivot brand hasil AI (crt.sh + variants + dork)
  add <url> [url...]                    tambah kandidat manual
  seed add <url...> | seed import <f> | seed search   kelola seed situs bajakan untuk crawler iklan

Pemrosesan (⚠️ membuka situs, hanya di container VPS):
  fetch [--limit 50]                    buka halaman, bukti, cloaking, prefilter (sekali jalan)
  triage [--limit 50]                   klasifikasi AI untuk yang sudah di-fetch (sekali jalan)
  verify [--limit 50]                   fetch lalu triage (sekali jalan)
  ads                                   crawl iklan di semua seed yang jatuh tempo (sekali jalan)
  worker <discover|fetch|triage|ads>    jalan terus (dipakai docker compose)
  ui                                    review UI web (default 127.0.0.1:8787)

Review & submit:
  review                                daftar link yang butuh dicek manusia
  approve <url...> | reject <url...>    putuskan (MEMBER=nama untuk log)
  export [--limit N]                    antrean → data/batches/*.txt (20/batch), tandai submitted
  stats                                 ringkasan status`;

const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    days: { type: 'string', default: String(config.crtshDays) },
    kw: { type: 'string' },
    limit: { type: 'string' },
    file: { type: 'string', default: 'dorks/judol.txt' },
  },
});
const limit = Number(values.limit ?? 50);

// Worker berhenti rapi saat docker stop (lease baris yang sedang diproses akan kedaluwarsa sendiri).
const ac = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (ac.signal.aborted) process.exit(1);
    console.log(`[${sig}] berhenti…`);
    ac.abort();
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

const decideAll = (action: 'approve' | 'reject') => {
  for (const u of positionals) {
    const n = normalize(u);
    console.log(n.ok && decide(n.key, action) ? `${action}: ${u}` : `tidak ditemukan / status tidak cocok: ${u}`);
  }
};

switch (cmd) {
  case 'crtsh':
    await discoverCrtsh(values.kw ? values.kw.split(',') : DEFAULT_KEYWORDS, Number(values.days));
    break;
  case 'search':
    await discoverSearch(readDorks(values.file!), 0);
    break;
  case 'import':
    console.log(`${importFile(positionals[0]!)} kandidat baru`);
    break;
  case 'variants':
    await discoverVariants(positionals.map((b) => b.toLowerCase()));
    break;
  case 'pivot':
    await pivotBrands(values.limit ? limit : 10);
    break;
  case 'add':
    console.log(`${positionals.filter((u) => addCandidate(u, 'manual')).length} kandidat baru`);
    break;
  case 'seed': {
    const { addSeeds, discoverSeeds } = await import('./workers/ads.ts');
    const [sub, ...args] = positionals;
    if (sub === 'add') console.log(`${addSeeds(args)} seed baru`);
    else if (sub === 'import') {
      const { readFileSync } = await import('node:fs');
      console.log(`${addSeeds(readFileSync(args[0]!, 'utf8').split(/\s+/).filter(Boolean))} seed baru`);
    } else if (sub === 'search') await discoverSeeds();
    else console.table(db.prepare('SELECT url, crawled_at, ads_found, error FROM seeds ORDER BY ads_found DESC').all());
    break;
  }
  case 'fetch':
    await (await import('./workers/fetch.ts')).runFetch({ once: true, limit, signal: ac.signal });
    break;
  case 'triage':
    await (await import('./workers/triage.ts')).runTriage({ once: true, limit, signal: ac.signal });
    break;
  case 'verify':
    await (await import('./workers/fetch.ts')).runFetch({ once: true, limit, signal: ac.signal });
    await (await import('./workers/triage.ts')).runTriage({ once: true, signal: ac.signal });
    break;
  case 'ads':
    await (await import('./workers/ads.ts')).runAds({ once: true, signal: ac.signal });
    break;
  case 'worker': {
    const kind = positionals[0];
    console.log(`[worker] ${kind} mulai (member=${config.member})`);
    if (kind === 'discover') await (await import('./workers/discover.ts')).runDiscover({ signal: ac.signal });
    else if (kind === 'triage') await (await import('./workers/triage.ts')).runTriage({ signal: ac.signal });
    else if (kind === 'ads') await (await import('./workers/ads.ts')).runAds({ signal: ac.signal });
    else if (kind === 'fetch') {
      // runFetch keluar berkala untuk me-restart Chromium; ulangi sampai dihentikan.
      const { runFetch } = await import('./workers/fetch.ts');
      while (!ac.signal.aborted) await runFetch({ signal: ac.signal });
    } else {
      console.log('worker: discover | fetch | triage | ads');
      process.exitCode = 1;
    }
    break;
  }
  case 'ui':
    (await import('./ui/server.ts')).startUi();
    break;
  case 'review':
    console.table(
      db
        .prepare("SELECT key, label, confidence, reason, cloaked FROM links WHERE status IN ('review','verified') ORDER BY confidence DESC LIMIT 100")
        .all(),
    );
    break;
  case 'approve':
    decideAll('approve');
    break;
  case 'reject':
    decideAll('reject');
    break;
  case 'export':
    exportBatches(values.limit ? limit : Infinity);
    break;
  case 'stats':
    console.table(db.prepare('SELECT status, source, COUNT(*) AS n FROM links GROUP BY status, source ORDER BY status').all());
    break;
  default:
    console.log(HELP);
}
