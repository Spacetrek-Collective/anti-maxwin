try {
  process.loadEnvFile('.env');
} catch {
  // .env opsional (di container, env datang dari compose)
}

const env = (k: string, d = '') => process.env[k] ?? d;
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== '' ? v : d;
};
const bool = (k: string, d: boolean) => (process.env[k] === undefined ? d : !/^(0|false|no|off)$/i.test(process.env[k]!));

export const config = {
  dataDir: env('DATA_DIR', 'data'),
  /** Nama anggota tim yang menjalankan perintah (untuk log approve/submit). */
  member: env('MEMBER', 'anon'),

  // LLM (OpenAI-compatible, DeepSeek dari panitia)
  llmBaseUrl: env('LLM_BASE_URL', 'https://api.deepseek.com'),
  llmApiKey: env('LLM_API_KEY'),
  llmModel: env('LLM_MODEL', 'deepseek-chat'),
  llmMaxChars: num('LLM_MAX_CHARS', 3000),
  minConfidence: num('MIN_CONFIDENCE', 0.8),
  triageConcurrency: num('TRIAGE_CONCURRENCY', 4),
  /** Kalau true, verified dengan confidence >= AUTO_QUEUE_CONFIDENCE langsung masuk antrean submit tanpa approve manual. */
  autoQueue: bool('AUTO_QUEUE', false),
  autoQueueConfidence: num('AUTO_QUEUE_CONFIDENCE', 0.95),

  // Browser
  concurrency: num('CONCURRENCY', 4),
  navTimeoutMs: num('NAV_TIMEOUT_MS', 25_000),
  settleMs: num('SETTLE_MS', 2500),
  chromiumSandbox: bool('CHROMIUM_SANDBOX', true),
  /** Cek cloaking: ambil ulang halaman dengan UA Googlebot & desktop (HTTP biasa, tanpa browser). */
  cloakCheck: bool('CLOAK_CHECK', true),
  /** Proxy keluar untuk browser (mis. proxy Indonesia): http://host:port atau socks5://host:port */
  proxy: env('PROXY'),

  // Antrean
  leaseSec: num('LEASE_SEC', 300),
  maxAttempts: num('MAX_ATTEMPTS', 2),
  idleSleepSec: num('IDLE_SLEEP_SEC', 20),

  // Discovery (SearXNG self-hosted, tanpa API key)
  searxngUrl: env('SEARXNG_URL', 'http://searxng:8080'),
  /** Kosong = engine default dari settings.yml. Contoh: google,bing,duckduckgo,brave,mojeek */
  searxngEngines: env('SEARXNG_ENGINES'),
  searxngLanguage: env('SEARXNG_LANGUAGE', 'id-ID'),
  searchPages: num('SEARCH_PAGES', 2),
  /** Jeda antar request ke SearXNG; makin pelan makin jarang engine kena captcha. */
  searchDelayMs: num('SEARCH_DELAY_MS', 8000),
  discoverIntervalMin: num('DISCOVER_INTERVAL_MIN', 120),
  crtshDays: num('CRTSH_DAYS', 30),

  // Crawler iklan
  adReloads: num('AD_RELOADS', 6),
  adMaxLinksPerSeed: num('AD_MAX_LINKS_PER_SEED', 25),
  adRecrawlHours: num('AD_RECRAWL_HOURS', 6),

  // Review UI
  uiHost: env('UI_HOST', '127.0.0.1'),
  uiPort: num('UI_PORT', 8787),
  /** Basic auth untuk UI (user bebas, password ini). Kosong = tanpa auth. */
  uiPassword: env('UI_PASSWORD'),
};

export const shotsDir = () => `${config.dataDir}/shots`;
