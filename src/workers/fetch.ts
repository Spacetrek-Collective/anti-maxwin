// Worker FETCH: new → fetched | skip | dead.
// Buka halaman (profil HP Android + Referer Google), kumpulkan bukti, cek cloaking, prefilter,
// dan masukkan domain turunan (redirect, link tersembunyi, popup, link keluar mencurigakan) sebagai kandidat.
//
// ⚠️ Membuka situs berbahaya. Hanya di container di VPS sekali pakai (lihat CLAUDE.md).
import type { Browser } from 'playwright';
import { mkdirSync } from 'node:fs';
import { config, shotsDir } from '../config.ts';
import { addCandidate, claim, updateLink, type LinkRow } from '../db.ts';
import { launchBrowser, shotName, visit, UA, type PageData, type Profile } from '../browser.ts';
import { prefilter, worthTriage, type PrefilterResult } from '../prefilter.ts';
import { hostOf } from '../normalize.ts';

/** Ambil halaman via HTTP biasa (tanpa JS) dengan UA tertentu, kembalikan teks kasar. Untuk cek cloaking. */
async function plainText(url: string, profile: Profile, referer: boolean): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA[profile],
        'accept-language': 'id-ID,id;q=0.9,en;q=0.5',
        ...(referer ? { referer: 'https://www.google.com/' } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.body || !/text\/html|xhtml|text\/plain/i.test(type)) {
      await res.body?.cancel();
      return null;
    }
    // Baca maksimal ~1.5 MB.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      chunks.push(r.value);
      size += r.value.length;
      if (size > 1_500_000) {
        await reader.cancel();
        break;
      }
    }
    return htmlToText(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(title|a|h\d|p|div|li|br|td)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

type CloakResult = {
  scores: Record<string, number>;
  cloaked: boolean;
  dirtyProfile: Profile | null;
  extraText: string;
};

/** Bandingkan versi browser (HP + Referer) dengan versi Googlebot dan desktop tanpa Referer. */
async function cloakCheck(url: string, browserScore: number): Promise<CloakResult> {
  const scores: Record<string, number> = { mobile_browser: browserScore };
  if (!config.cloakCheck) return { scores, cloaked: false, dirtyProfile: null, extraText: '' };

  const [bot, desk] = await Promise.all([plainText(url, 'googlebot', false), plainText(url, 'desktop', false)]);
  const botP = bot ? prefilter(bot) : null;
  const deskP = desk ? prefilter(desk) : null;
  if (botP) scores.googlebot = botP.score;
  if (deskP) scores.desktop = deskP.score;

  const vals = Object.values(scores);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const cloaked = vals.length > 1 && max >= 3 && min === 0;

  let dirtyProfile: Profile | null = null;
  let extraText = '';
  if (cloaked && botP && botP.score === max && browserScore === 0) {
    dirtyProfile = 'googlebot';
    extraText = bot!;
  } else if (cloaked && deskP && deskP.score === max && browserScore === 0) {
    dirtyProfile = 'desktop';
    extraText = desk!;
  }
  return { scores, cloaked, dirtyProfile, extraText };
}

function deriveCandidates(row: LinkRow, data: PageData) {
  const origin = hostOf(row.url);
  const added: Record<string, number> = {};
  const add = (u: string, source: string) => {
    const h = hostOf(u);
    if (!h || h === origin) return;
    if (addCandidate(u, source, row.key)) added[source] = (added[source] ?? 0) + 1;
  };

  // Rantai redirect: setiap domain di tengah dan domain akhir.
  for (const u of data.redirectChain) add(u, 'redirect');
  add(data.finalUrl, 'redirect');

  // Link tersembunyi CSS yang mengarah keluar dan berbau judol/pinjol/scam.
  for (const l of data.hiddenLinks) {
    if (prefilter(`${l.text} ${l.href}`).score > 0) add(l.href, 'hidden_link');
  }

  // Popup/popunder.
  for (const u of data.popups) add(u, 'ad');

  // Link keluar yang teks/host-nya kuat mengarah ke judol (mis. tombol "DAFTAR" ke gacor88.xyz).
  for (const l of data.links) {
    const h = hostOf(l.href);
    if (h && h !== origin && worthTriage(prefilter(`${l.text} ${h}`))) add(l.href, 'outlink');
  }
  return added;
}

async function processRow(browser: Browser, row: LinkRow) {
  const shot = `${shotsDir()}/${shotName(row.key)}`;
  const data = await visit(browser, row.url, 'mobile', { screenshot: shot, referer: true });

  if (!data) {
    const dead = row.attempts >= config.maxAttempts;
    updateLink(row.key, {
      status: dead ? 'dead' : 'new',
      priority: row.priority - 1,
      error: 'tidak bisa dibuka',
      fetched_at: new Date().toISOString(),
    });
    console.log(`${(dead ? 'dead' : 'retry').padEnd(8)} ${row.key}`);
    return;
  }

  const hiddenText = data.hiddenLinks.map((l) => `${l.text} ${l.href}`).join('\n');
  const browserP = prefilter(`${data.title}\n${data.text}\n${hiddenText}`);
  const cloak = await cloakCheck(row.url, browserP.score);

  let screenshotAlt: string | null = null;
  if (cloak.dirtyProfile) {
    screenshotAlt = `${shotsDir()}/${shotName(row.key, `.${cloak.dirtyProfile}`)}`;
    await visit(browser, row.url, cloak.dirtyProfile, { screenshot: screenshotAlt, referer: false });
  }

  const content = cloak.extraText ? `${data.text}\n\n[VERSI ${cloak.dirtyProfile?.toUpperCase()}]\n${cloak.extraText}` : data.text;
  const contentP: PrefilterResult = cloak.extraText ? prefilter(`${data.title}\n${content}\n${hiddenText}`) : browserP;
  const hostP = prefilter(`${hostOf(row.url) ?? ''} ${hostOf(data.finalUrl) ?? ''}`.replace(/[.-]/g, ' '));

  // Lolos kalau isi halaman punya sinyal cukup, atau ada sedikit sinyal di isi + nama domain.
  const pass = worthTriage(contentP) || (contentP.score > 0 && hostP.score > 0) || cloak.cloaked;
  const derived = deriveCandidates(row, data);

  updateLink(row.key, {
    status: pass ? 'fetched' : 'skip',
    title: data.title.slice(0, 300),
    page_text: content.slice(0, 12_000),
    final_url: data.finalUrl,
    final_domain: hostOf(data.finalUrl),
    redirect_chain: JSON.stringify(data.redirectChain),
    outlinks: JSON.stringify(data.links.slice(0, 300).map((l) => ({ host: hostOf(l.href), text: l.text.slice(0, 60) }))),
    hidden_links: JSON.stringify(data.hiddenLinks.slice(0, 100)),
    prefilter: JSON.stringify(contentP.hits),
    prefilter_score: contentP.score,
    cloak: JSON.stringify(cloak.scores),
    cloaked: cloak.cloaked ? 1 : 0,
    screenshot: shot,
    screenshot_alt: screenshotAlt,
    favicon_hash: data.faviconHash,
    analytics_ids: JSON.stringify(data.analyticsIds),
    error: null,
    fetched_at: new Date().toISOString(),
  });
  const extra = Object.entries(derived).map(([k, v]) => `+${v} ${k}`).join(' ');
  console.log(`${(pass ? 'fetched' : 'skip').padEnd(8)} skor=${String(contentP.score).padEnd(3)} ${cloak.cloaked ? 'CLOAK ' : ''}${row.key} ${extra}`);
}

/**
 * Jalankan worker fetch. `once`: proses sampai antrean kosong lalu berhenti (dipakai `verify`);
 * kalau tidak, terus menunggu kandidat baru.
 */
export async function runFetch(opts: { once?: boolean; limit?: number; signal?: AbortSignal } = {}) {
  mkdirSync(shotsDir(), { recursive: true });
  const browser = await launchBrowser();
  let budget = opts.limit ?? Infinity;
  let restartAfter = 300; // restart Chromium berkala supaya memori/sesi tidak menumpuk

  const worker = async () => {
    while (!opts.signal?.aborted && budget > 0) {
      const [row] = claim('new', 'fetching', 1, true);
      if (!row) {
        if (opts.once) return;
        await new Promise((r) => setTimeout(r, config.idleSleepSec * 1000));
        continue;
      }
      budget--;
      restartAfter--;
      try {
        await processRow(browser, row);
      } catch (e) {
        console.warn(`[fetch] error ${row.key}: ${(e as Error).message}`);
        updateLink(row.key, { status: row.attempts >= config.maxAttempts ? 'dead' : 'new', error: (e as Error).message.slice(0, 300) });
      }
      if (restartAfter <= 0 && !opts.once) return; // keluar; supervisor (docker restart) menyalakan ulang
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, worker));
  } finally {
    await browser.close().catch(() => undefined);
  }
}
