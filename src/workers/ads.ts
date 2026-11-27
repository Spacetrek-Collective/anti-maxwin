// Worker ADS: buka situs anime/manga bajakan (seed) dengan profil HP Indonesia, reload beberapa kali
// (iklan berotasi), kumpulkan banner/iframe/popup, ikuti rantai redirect tiap iklan sampai domain akhir,
// lalu domain akhir masuk sebagai kandidat (source=ad). Klasifikasi tetap lewat fetch → triage.
//
// ⚠️ Situs bajakan = sumber malvertising. Hanya di container di VPS sekali pakai (lihat CLAUDE.md).
import type { Browser, Page } from 'playwright';
import { config } from '../config.ts';
import { addCandidate, db } from '../db.ts';
import { launchBrowser, newContext } from '../browser.ts';
import { hostOf, isIgnoredHost, normalize } from '../normalize.ts';
import { readDorks, searchAll } from '../discover/search.ts';

const AD_HINT = /\b(ad|ads|adv|advert|banner|iklan|sponsor|promo|float|sticky|popup|overlay|bottom-?bar|gacor|slot)\b/i;

/** Ambil href iklan dari halaman + semua frame (iframe iklan). Hanya membaca DOM. */
async function collectAdLinks(page: Page, seedHost: string): Promise<string[]> {
  const out = new Set<string>();
  for (const frame of page.frames()) {
    const hrefs = await frame
      .evaluate((hintSrc) => {
        const hint = new RegExp(hintSrc, 'i');
        const res: string[] = [];
        for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 2000) as HTMLAnchorElement[]) {
          if (!/^https?:/.test(a.href)) continue;
          let adLike = !!a.querySelector('img, video, picture') || window.top !== window.self;
          for (let el: Element | null = a; el && !adLike && el !== document.body; el = el.parentElement) {
            if (hint.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`)) adLike = true;
          }
          if (adLike) res.push(a.href);
        }
        return res;
      }, AD_HINT.source)
      .catch(() => [] as string[]);
    for (const h of hrefs) {
      const host = hostOf(h);
      if (host && host !== seedHost && !host.endsWith(`.${seedHost}`) && !isIgnoredHost(host)) out.add(h);
    }
  }
  return [...out];
}

/** Ikuti link iklan (shortlink/tracker) sampai halaman akhir; kembalikan URL akhir. */
async function resolveFinal(browser: Browser, href: string): Promise<string | null> {
  const ctx = await newContext(browser, 'mobile', true);
  try {
    const page = await ctx.newPage();
    ctx.on('page', (p) => (p === page ? undefined : void p.close().catch(() => undefined)));
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
    await page.waitForTimeout(config.settleMs + 1500); // tracker sering redirect berlapis via JS
    return page.url();
  } catch {
    return null;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function crawlSeed(browser: Browser, seed: string): Promise<number> {
  const seedHost = hostOf(seed)!;
  const ctx = await newContext(browser, 'mobile', true);
  const popups = new Set<string>();
  ctx.on('page', async (p) => {
    // Popup/popunder: tunggu rantai redirect-nya selesai, catat URL akhir, tutup.
    await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    await p.waitForTimeout(config.settleMs + 1500).catch(() => undefined);
    if (/^https?:/.test(p.url())) popups.add(p.url());
    await p.close().catch(() => undefined);
  });
  const adLinks = new Set<string>();
  try {
    const page = await ctx.newPage();
    for (let i = 0; i < config.adReloads; i++) {
      try {
        if (i === 0) await page.goto(seed, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
        else await page.reload({ waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
        await page.waitForTimeout(config.settleMs + 1000);
        // Satu klik netral di pojok halaman (seperti pengunjung biasa) memicu popunder. Bukan klik tombol/form.
        if (i % 2 === 0) await page.mouse.click(3, 3).catch(() => undefined);
        await page.waitForTimeout(1000);
        if (hostOf(page.url()) !== seedHost) {
          // Halaman seed sendiri redirect ke situs lain (mis. klik memicu navigasi) → catat & kembali.
          popups.add(page.url());
          continue;
        }
        for (const l of await collectAdLinks(page, seedHost)) adLinks.add(l);
      } catch {
        // reload gagal; lanjut
      }
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }

  let added = 0;
  const finals = new Set<string>(popups);
  for (const href of [...adLinks].slice(0, config.adMaxLinksPerSeed)) {
    const fin = await resolveFinal(browser, href);
    if (fin) finals.add(fin);
  }
  for (const f of finals) {
    const h = hostOf(f);
    if (!h || h === seedHost || isIgnoredHost(h)) continue;
    // Kandidat = root domain akhir (path landing page biasanya cuma kode referral).
    if (addCandidate(`https://${h}/`, 'ad', seed)) added++;
  }
  console.log(`[ads] ${seed}: ${adLinks.size} link iklan, ${popups.size} popup, ${added} kandidat baru`);
  return added;
}

export function addSeeds(urls: string[], kind = 'piracy'): number {
  const ins = db.prepare('INSERT OR IGNORE INTO seeds (url, kind) VALUES (?, ?)');
  let n = 0;
  for (const u of urls) {
    const r = normalize(u);
    if (r.ok && Number(ins.run(r.url, kind).changes) > 0) n++;
  }
  return n;
}

/** Cari situs bajakan lewat SearXNG (dorks/seeds.txt) → tabel seeds (hanya root domain). */
export async function discoverSeeds(dorkFile = 'dorks/seeds.txt'): Promise<number> {
  let n = 0;
  for (const q of readDorks(dorkFile)) {
    try {
      const hosts = new Set((await searchAll(q, 2)).map(hostOf).filter((h): h is string => !!h && !isIgnoredHost(h)));
      n += addSeeds([...hosts].map((h) => `https://${h}/`));
    } catch (e) {
      console.warn(`[seeds] ${q}: ${(e as Error).message}`);
    }
  }
  console.log(`[seeds] ${n} seed baru`);
  return n;
}

export async function runAds(opts: { once?: boolean; signal?: AbortSignal } = {}) {
  const due = db.prepare(
    `SELECT url FROM seeds WHERE crawled_at IS NULL OR crawled_at < datetime('now', ?) ORDER BY crawled_at IS NOT NULL, crawled_at LIMIT 1`,
  );
  const mark = db.prepare("UPDATE seeds SET crawled_at = datetime('now'), ads_found = ads_found + ?, error = ? WHERE url = ?");
  let browser = await launchBrowser();
  let sinceRestart = 0;
  try {
    while (!opts.signal?.aborted) {
      const seed = due.get(`-${config.adRecrawlHours} hours`) as { url: string } | undefined;
      if (!seed) {
        if (opts.once) return;
        await new Promise((r) => setTimeout(r, config.idleSleepSec * 1000 * 3));
        continue;
      }
      // Tandai dulu supaya replika lain tidak mengambil seed yang sama.
      mark.run(0, null, seed.url);
      try {
        mark.run(await crawlSeed(browser, seed.url), null, seed.url);
      } catch (e) {
        mark.run(0, (e as Error).message.slice(0, 300), seed.url);
      }
      if (++sinceRestart >= 20) {
        await browser.close().catch(() => undefined);
        browser = await launchBrowser();
        sinceRestart = 0;
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}
