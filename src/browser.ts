// Browser yang di-hardening + pengumpul data halaman. HANYA melihat: tidak login, tidak isi form,
// tidak klik tombol daftar/deposit, tidak mengunduh file.
//
// ⚠️ Modul ini membuka situs berbahaya. Hanya dijalankan di container di VPS sekali pakai (lihat CLAUDE.md).
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { config } from './config.ts';

export const UA = {
  mobile:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  desktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  googlebot:
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
} as const;
export type Profile = keyof typeof UA;

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    chromiumSandbox: config.chromiumSandbox,
    proxy: config.proxy ? { server: config.proxy } : undefined,
    args: [
      '--disable-extensions',
      '--disable-notifications',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
      '--deny-permission-prompts',
    ],
  });
}

/** Context baru per kunjungan: tanpa cookie/storage sisa, tanpa izin apa pun, tanpa download. */
export async function newContext(browser: Browser, profile: Profile, referer = true): Promise<BrowserContext> {
  const mobile = profile !== 'desktop';
  const ctx = await browser.newContext({
    userAgent: UA[profile],
    viewport: mobile ? { width: 412, height: 915 } : { width: 1366, height: 800 },
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    acceptDownloads: false,
    permissions: [],
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
    bypassCSP: false,
    // Banyak situs hanya redirect ke judol kalau pengunjung datang dari Google.
    extraHTTPHeaders: referer ? { referer: 'https://www.google.com/' } : {},
  });
  await ctx.clearPermissions();
  // Hemat bandwidth & kurangi permukaan serangan: video/audio/font tidak perlu untuk bukti.
  await ctx.route('**/*', (route) => {
    const t = route.request().resourceType();
    return t === 'media' || t === 'font' || t === 'websocket' || t === 'eventsource' ? route.abort() : route.continue();
  });
  ctx.setDefaultTimeout(config.navTimeoutMs);
  return ctx;
}

export type HiddenLink = { href: string; text: string; why: string };
export type PageData = {
  finalUrl: string;
  title: string;
  text: string;
  redirectChain: string[];
  links: { href: string; text: string }[];
  hiddenLinks: HiddenLink[];
  iframes: string[];
  analyticsIds: string[];
  faviconHash: string | null;
  popups: string[];
};

/** Catat semua navigasi main frame (HTTP redirect, meta refresh, JS redirect). */
export function trackNavigation(page: Page): string[] {
  const chain: string[] = [];
  const push = (u: string) => {
    if (/^https?:/.test(u) && chain[chain.length - 1] !== u) chain.push(u);
  };
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) push(req.url());
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) push(f.url());
  });
  return chain;
}

/** Catat URL popup/popunder lalu tutup (tidak diikuti lebih jauh di sini). */
export function trackPopups(ctx: BrowserContext, opener: Page): string[] {
  const popups: string[] = [];
  ctx.on('page', async (p) => {
    if (p === opener) return;
    try {
      await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
      if (/^https?:/.test(p.url())) popups.push(p.url());
    } finally {
      await p.close().catch(() => undefined);
    }
  });
  return popups;
}

const ANALYTICS_RE = [
  /\b(UA-\d{4,10}-\d{1,4})\b/g,
  /\b(G-[A-Z0-9]{6,12})\b/g,
  /\b(GTM-[A-Z0-9]{4,9})\b/g,
  /\b(AW-\d{6,12})\b/g,
  /fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/g, // Facebook pixel
  /__lc\.license\s*=\s*(\d{5,12})/g, // LiveChat (sangat umum di situs judol)
  /tawk\.to\/chat\/([a-f0-9]{24})/g, // Tawk.to
  /histats\.com.*?(\d{6,8})/g,
];

export function extractAnalyticsIds(html: string): string[] {
  const ids = new Set<string>();
  for (const re of ANALYTICS_RE) for (const m of html.matchAll(re)) ids.add(m[1]!);
  return [...ids].slice(0, 20);
}

/** Ambil data halaman yang sedang terbuka. Semua evaluasi di dalam halaman hanya MEMBACA DOM. */
export async function collectPage(page: Page, chain: string[], popups: string[]): Promise<PageData> {
  const title = await page.title().catch(() => '');
  const dom = await page.evaluate(() => {
    const parseRgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const bgOf = (el: Element | null): string => {
      for (let e = el; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor;
        const v = parseRgb(c);
        if (v.length >= 3 && (v.length < 4 || v[3]! > 0)) return c;
      }
      return 'rgb(255, 255, 255)';
    };
    const sameColor = (a: string, b: string) => {
      const x = parseRgb(a);
      const y = parseRgb(b);
      return x.length >= 3 && y.length >= 3 && Math.abs(x[0]! - y[0]!) + Math.abs(x[1]! - y[1]!) + Math.abs(x[2]! - y[2]!) < 12;
    };
    const hiddenReason = (a: HTMLElement): string | null => {
      for (let el: HTMLElement | null = a; el && el !== document.body; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none') return 'display:none';
        if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility:hidden';
        if (Number(cs.opacity) === 0) return 'opacity:0';
        if (cs.overflow === 'hidden' && (el.clientHeight <= 1 || el.clientWidth <= 1)) return 'size:0';
        if (cs.clipPath === 'inset(50%)' || cs.clip === 'rect(0px, 0px, 0px, 0px)') return 'clip';
      }
      const cs = getComputedStyle(a);
      if (parseFloat(cs.fontSize) < 2) return 'font-size:0';
      const r = a.getBoundingClientRect();
      if (r.right < 0 || r.bottom < -500 || r.left > 5000) return 'offscreen';
      if (sameColor(cs.color, bgOf(a))) return 'warna=background';
      return null;
    };

    const links: { href: string; text: string }[] = [];
    const hidden: { href: string; text: string; why: string }[] = [];
    const anchors = Array.from(document.querySelectorAll('a[href]')).slice(0, 3000) as HTMLAnchorElement[];
    for (const a of anchors) {
      if (!/^https?:/.test(a.href)) continue;
      const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
      links.push({ href: a.href, text });
      const why = hiddenReason(a);
      if (why) hidden.push({ href: a.href, text, why });
    }
    const icon = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]') as HTMLLinkElement | null;
    return {
      text: document.body?.innerText ?? '',
      links,
      hidden,
      iframes: Array.from(document.querySelectorAll('iframe[src]')).map((f) => (f as HTMLIFrameElement).src).filter((s) => /^https?:/.test(s)).slice(0, 30),
      favicon: icon?.href || new URL('/favicon.ico', location.href).href,
    };
  }).catch(() => ({ text: '', links: [], hidden: [], iframes: [], favicon: '' }));

  const html = await page.content().catch(() => '');
  let faviconHash: string | null = null;
  if (/^https?:/.test(dom.favicon)) {
    try {
      const res = await page.context().request.get(dom.favicon, { timeout: 8000, maxRedirects: 3 });
      const body = res.ok() ? await res.body() : null;
      if (body && body.length > 0 && body.length < 512_000) faviconHash = createHash('sha256').update(body).digest('hex').slice(0, 32);
    } catch {
      // favicon opsional
    }
  }

  return {
    finalUrl: page.url(),
    title,
    text: dom.text.slice(0, 20_000),
    redirectChain: [...chain],
    links: dom.links,
    hiddenLinks: dom.hidden.slice(0, 200),
    iframes: dom.iframes,
    analyticsIds: extractAnalyticsIds(html),
    faviconHash,
    popups: [...popups],
  };
}

/** Kunjungi URL dengan profil tertentu. https dulu, lalu http. null kalau tidak bisa dibuka. */
export async function visit(
  browser: Browser,
  url: string,
  profile: Profile,
  opts: { screenshot?: string; referer?: boolean } = {},
): Promise<PageData | null> {
  const ctx = await newContext(browser, profile, opts.referer ?? true);
  const page = await ctx.newPage();
  const chain = trackNavigation(page);
  const popups = trackPopups(ctx, page);
  try {
    for (const u of [...new Set([url, url.replace(/^https:/, 'http:')])]) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
        await page.waitForTimeout(config.settleMs); // beri waktu JS redirect / render
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        const data = await collectPage(page, chain, popups);
        if (opts.screenshot) await page.screenshot({ path: opts.screenshot, timeout: 10_000 }).catch(() => undefined);
        return data;
      } catch {
        chain.length = 0;
        if (u.startsWith('http:')) break;
      }
    }
    return null;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export const shotName = (key: string, suffix = '') => `${key.replace(/[^a-z0-9.-]+/gi, '_').slice(0, 150)}${suffix}.png`;
