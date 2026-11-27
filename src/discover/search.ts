// Discovery via dork lewat SearXNG (self-hosted, service `searxng` di compose; tanpa API key).
// Hanya membaca daftar URL hasil pencarian; tidak membuka situs hasilnya.
//
// SearXNG mengambil hasil dari Google/Bing/DDG/Brave/Mojeek dari IP mesin tempat ia berjalan.
// Kalau sebuah engine kena captcha/rate limit, SearXNG menonaktifkannya sementara (kita tidak
// mencoba menembus captcha); engine yang bermasalah dilaporkan di log.
import { readFileSync, existsSync } from 'node:fs';
import { config } from '../config.ts';
import { addCandidate, db } from '../db.ts';

type SearxResponse = {
  results?: { url: string }[];
  unresponsive_engines?: [string, string][];
};

async function searxPage(q: string, pageno: number): Promise<{ urls: string[]; failed: string[] }> {
  const params = new URLSearchParams({ q, format: 'json', pageno: String(pageno), language: config.searxngLanguage, safesearch: '0' });
  if (config.searxngEngines) params.set('engines', config.searxngEngines);
  const res = await fetch(`${config.searxngUrl.replace(/\/$/, '')}/search?${params}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`searxng HTTP ${res.status}${res.status === 403 ? ' (format json belum diaktifkan di settings.yml?)' : ''}`);
  const data = (await res.json()) as SearxResponse;
  return {
    urls: (data.results ?? []).map((r) => r.url).filter((u) => /^https?:/.test(u)),
    failed: (data.unresponsive_engines ?? []).map(([e, why]) => `${e}: ${why}`),
  };
}

/** Baca file dork: satu query per baris, '#' = komentar. */
export function readDorks(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** Semua URL hasil pencarian untuk satu query (beberapa halaman), dengan jeda antar request. */
export async function searchAll(q: string, pages = config.searchPages): Promise<string[]> {
  const out: string[] = [];
  for (let p = 1; p <= pages; p++) {
    const { urls, failed } = await searxPage(q, p);
    if (failed.length) console.warn(`[search] engine bermasalah untuk "${q}": ${failed.join('; ')}`);
    out.push(...urls);
    await new Promise((r) => setTimeout(r, config.searchDelayMs));
    if (urls.length < 5) break;
  }
  return out;
}

/**
 * Jalankan dork → kandidat. Query yang sudah dijalankan dalam `minIntervalMin` menit terakhir dilewati,
 * supaya engine di belakang SearXNG tidak dibanjiri query yang sama.
 */
export async function discoverSearch(dorks: string[], minIntervalMin = config.discoverIntervalMin): Promise<number> {
  const recent = db.prepare(`SELECT 1 FROM search_runs WHERE engine = 'searxng' AND query = ? AND at > datetime('now', ?)`);
  const record = db.prepare("INSERT OR REPLACE INTO search_runs (engine, query, added, at) VALUES ('searxng', ?, ?, datetime('now'))");
  let total = 0;
  for (const q of dorks) {
    if (recent.get(q, `-${minIntervalMin} minutes`)) continue;
    try {
      const urls = await searchAll(q);
      const added = urls.filter((u) => addCandidate(u, 'search')).length;
      record.run(q, added);
      total += added;
      console.log(`[search] ${q} → ${urls.length} hasil, ${added} baru`);
    } catch (e) {
      console.warn(`[search] ${q}: ${(e as Error).message}`);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND/.test((e as Error).message)) {
        console.warn(`[search] SearXNG tidak bisa dihubungi di ${config.searxngUrl}; dork dilewati`);
        break;
      }
    }
  }
  return total;
}
