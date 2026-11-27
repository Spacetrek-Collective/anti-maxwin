// Verifikasi: buka halaman (GET biasa, tanpa login/isi form), ambil teks + screenshot, lalu klasifikasi.
import { chromium, type Browser } from 'playwright';
import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { addCandidate, pending, saveVerdict, type LinkRow } from './db.ts';
import { classify, ILLEGAL_LABELS } from './classify.ts';
import { normalize } from './normalize.ts';

const SHOTS = `${config.dataDir}/shots`;

async function inspect(browser: Browser, row: LinkRow) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    acceptDownloads: false,
    locale: 'id-ID',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  try {
    const candidates = [row.url, row.url.replace(/^https:/, 'http:')];
    for (const url of candidates) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForTimeout(2500); // beri waktu JS redirect / render
        const title = await page.title();
        const text = await page.evaluate(() => document.body?.innerText ?? '');
        const shot = `${SHOTS}/${row.key.replace(/[^a-z0-9.-]+/gi, '_').slice(0, 150)}.png`;
        await page.screenshot({ path: shot }).catch(() => undefined);
        return { ok: true as const, finalUrl: page.url(), title, text, shot };
      } catch {
        // coba kandidat berikutnya
      }
    }
    return { ok: false as const };
  } finally {
    await ctx.close();
  }
}

export async function verify(limit: number) {
  mkdirSync(SHOTS, { recursive: true });
  const rows = pending(limit);
  if (!rows.length) return console.log('Tidak ada kandidat baru.');
  console.log(`Verifikasi ${rows.length} kandidat (concurrency ${config.concurrency})…`);

  const browser = await chromium.launch();
  const queue = [...rows];
  const counts: Record<string, number> = {};

  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const r = await inspect(browser, row);
      if (!r.ok) {
        saveVerdict(row.key, { status: 'rejected', label: 'mati', confidence: 1, reason: 'tidak bisa dibuka' });
        counts.mati = (counts.mati ?? 0) + 1;
        continue;
      }
      // Redirect ke domain lain? Domain tujuan jadi kandidat baru.
      const fin = normalize(r.finalUrl);
      if (fin.ok && fin.key.split('/')[0] !== row.key.split('/')[0]) addCandidate(r.finalUrl, 'redirect');

      const v = await classify({ url: row.url, finalUrl: r.finalUrl, title: r.title, text: r.text });
      const illegal = (ILLEGAL_LABELS as readonly string[]).includes(v.label);
      const status = illegal ? (v.confidence >= config.minConfidence ? 'verified' : 'review') : 'rejected';
      saveVerdict(row.key, { status, ...v, finalUrl: r.finalUrl, screenshot: r.shot });
      counts[status] = (counts[status] ?? 0) + 1;
      console.log(`${status.padEnd(8)} ${v.label.padEnd(13)} ${v.confidence.toFixed(2)}  ${row.key}`);
    }
  };

  try {
    await Promise.all(Array.from({ length: config.concurrency }, worker));
  } finally {
    await browser.close();
  }
  console.log('Selesai:', counts);
}
