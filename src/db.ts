// SQLite = database + antrean antar worker.
//
// Alur status:
//   new ──fetch──► fetching ──► fetched | skip | dead | new (retry)
//   fetched ──triage──► triaging ──► verified | review | rejected
//   verified | review ──approve──► queued ──submit/export──► submitted
//   verified | review ──reject──► rejected
//
// Banyak proses (container) membuka DB yang sama: WAL + busy_timeout, dan klaim baris memakai
// satu UPDATE … RETURNING (atomik) dengan lease, supaya baris tidak diproses dua kali dan
// baris milik worker yang mati otomatis diambil ulang setelah lease habis.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { normalize, isIgnoredHost } from './normalize.ts';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(`${config.dataDir}/anti-maxwin.db`);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA synchronous = NORMAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS links (
  key           TEXT PRIMARY KEY,            -- hasil normalisasi (kunci dedup panitia)
  url           TEXT NOT NULL,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new',
  label         TEXT,                        -- kategori dari triage
  confidence    REAL,
  reason        TEXT,
  final_url     TEXT,
  screenshot    TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  checked_at    TEXT,
  exported_at   TEXT,
  batch         TEXT
);
CREATE TABLE IF NOT EXISTS llm_cache (
  final_domain TEXT PRIMARY KEY,
  verdict      TEXT NOT NULL,                -- JSON Verdict
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS brands (
  name       TEXT PRIMARY KEY,
  source_key TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  pivoted_at TEXT
);
CREATE TABLE IF NOT EXISTS seeds (
  url        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'piracy',
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  crawled_at TEXT,
  ads_found  INTEGER NOT NULL DEFAULT 0,
  error      TEXT
);
CREATE TABLE IF NOT EXISTS search_runs (
  engine TEXT NOT NULL,
  query  TEXT NOT NULL,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  added  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (engine, query)
);
CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  member TEXT NOT NULL,
  action TEXT NOT NULL,
  key    TEXT,
  detail TEXT
);
`);

// Migrasi kolom baru untuk DB lama (CREATE TABLE di atas sengaja tetap versi lama).
const NEW_COLUMNS: Record<string, string> = {
  parent: 'TEXT',                       // kandidat asal (pivot/redirect/iklan)
  priority: 'INTEGER NOT NULL DEFAULT 0',
  attempts: 'INTEGER NOT NULL DEFAULT 0',
  lease_until: 'TEXT',
  error: 'TEXT',
  title: 'TEXT',
  page_text: 'TEXT',                    // teks halaman (dipotong) untuk triage
  final_domain: 'TEXT',
  redirect_chain: 'TEXT',               // JSON string[]
  outlinks: 'TEXT',                     // JSON {host, text}[]
  hidden_links: 'TEXT',                 // JSON {href, text, why}[]
  prefilter: 'TEXT',                    // JSON hits per kategori
  prefilter_score: 'INTEGER',
  cloak: 'TEXT',                        // JSON skor per profil
  cloaked: 'INTEGER NOT NULL DEFAULT 0',
  screenshot_alt: 'TEXT',               // screenshot versi profil "kotor" kalau cloaking
  favicon_hash: 'TEXT',
  analytics_ids: 'TEXT',                // JSON string[]
  evidence: 'TEXT',                     // JSON string[] bukti dari LLM
  brands: 'TEXT',                       // JSON string[]
  verdict_source: 'TEXT',               // llm | cache | heuristic
  fetched_at: 'TEXT',
  reviewed_by: 'TEXT',
  queued_at: 'TEXT',
  submitted_at: 'TEXT',
  submitted_by: 'TEXT',
};
const existing = new Set((db.prepare('PRAGMA table_info(links)').all() as { name: string }[]).map((c) => c.name));
for (const [col, type] of Object.entries(NEW_COLUMNS)) {
  if (!existing.has(col)) db.exec(`ALTER TABLE links ADD COLUMN ${col} ${type}`);
}
db.exec(`
UPDATE links SET status = 'submitted', submitted_at = COALESCE(submitted_at, exported_at) WHERE status = 'exported';
CREATE INDEX IF NOT EXISTS idx_status ON links(status, priority DESC, discovered_at);
CREATE INDEX IF NOT EXISTS idx_final_domain ON links(final_domain);
CREATE INDEX IF NOT EXISTS idx_favicon ON links(favicon_hash);
`);

export type LinkRow = {
  key: string;
  url: string;
  source: string;
  parent: string | null;
  status: string;
  priority: number;
  attempts: number;
  label: string | null;
  confidence: number | null;
  reason: string | null;
  title: string | null;
  page_text: string | null;
  final_url: string | null;
  final_domain: string | null;
  redirect_chain: string | null;
  outlinks: string | null;
  hidden_links: string | null;
  prefilter: string | null;
  prefilter_score: number | null;
  cloak: string | null;
  cloaked: number;
  screenshot: string | null;
  screenshot_alt: string | null;
  favicon_hash: string | null;
  analytics_ids: string | null;
  evidence: string | null;
  brands: string | null;
  verdict_source: string | null;
  discovered_at: string;
  checked_at: string | null;
  queued_at: string | null;
  reviewed_by: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  batch: string | null;
};

/** Sumber yang lebih mungkin valid diproses lebih dulu (poin = cepat & banyak). */
const SOURCE_PRIORITY: Record<string, number> = {
  manual: 5,
  redirect: 4,
  ai_mention: 4,
  ad: 4,
  hidden_link: 3,
  search: 2,
  file: 2,
  outlink: 2,
  variant: 1,
  pivot: 1,
  crtsh: 0,
};

const insertStmt = db.prepare('INSERT OR IGNORE INTO links (key, url, source, parent, priority) VALUES (?, ?, ?, ?, ?)');

/** Tambah kandidat. Return true kalau baru (belum ada di DB). */
export function addCandidate(input: string, source: string, parent: string | null = null): boolean {
  const n = normalize(input);
  if (!n.ok || isIgnoredHost(n.key.split('/')[0]!)) return false;
  return Number(insertStmt.run(n.key, n.url, source, parent, SOURCE_PRIORITY[source] ?? 0).changes) > 0;
}

/**
 * Klaim maksimal `limit` baris berstatus `from` (atau `working` yang lease-nya habis) secara atomik.
 * `countAttempt` menaikkan kolom attempts (dipakai fetch untuk batas retry).
 */
export function claim(from: string, working: string, limit: number, countAttempt = false): LinkRow[] {
  return db
    .prepare(
      `UPDATE links SET status = ?, lease_until = datetime('now', ?), attempts = attempts + ?
       WHERE key IN (
         SELECT key FROM links
         WHERE status = ? OR (status = ? AND lease_until < datetime('now'))
         ORDER BY priority DESC, discovered_at
         LIMIT ?
       )
       RETURNING *`,
    )
    .all(working, `+${config.leaseSec} seconds`, countAttempt ? 1 : 0, from, working, limit) as unknown as LinkRow[];
}

/** Update kolom bebas pada satu baris (nama kolom dari kode sendiri, bukan input user). */
export function updateLink(key: string, fields: Record<string, string | number | null | undefined>) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as [string, string | number | null][];
  if (!entries.length) return;
  for (const [k] of entries) if (!/^[a-z_]+$/.test(k)) throw new Error(`kolom tidak valid: ${k}`);
  db.prepare(`UPDATE links SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, lease_until = NULL WHERE key = ?`).run(
    ...entries.map(([, v]) => v),
    key,
  );
}

export function getLink(key: string): LinkRow | undefined {
  return db.prepare('SELECT * FROM links WHERE key = ?').get(key) as unknown as LinkRow | undefined;
}

export function audit(action: string, key: string | null, detail = '', member = config.member) {
  db.prepare('INSERT INTO audit (member, action, key, detail) VALUES (?, ?, ?, ?)').run(member, action, key, detail);
}

/** Approve / reject / queue dari CLI atau UI. Return true kalau baris berubah. */
export function decide(key: string, action: 'approve' | 'reject', member = config.member): boolean {
  const res =
    action === 'approve'
      ? db
          .prepare(
            `UPDATE links SET status = 'queued', queued_at = datetime('now'), reviewed_by = ?
             WHERE key = ? AND status IN ('verified','review','fetched','rejected','skip')`,
          )
          .run(member, key)
      : db
          .prepare(`UPDATE links SET status = 'rejected', reviewed_by = ? WHERE key = ? AND status NOT IN ('submitted')`)
          .run(member, key);
  const changed = Number(res.changes) > 0;
  if (changed) audit(action, key, '', member);
  return changed;
}

/** Ambil sampai `n` link dari antrean dan tandai submitted oleh `member` (dipakai export & UI). */
export function takeBatch(n: number, batch: string, member = config.member): { key: string; url: string }[] {
  const rows = db
    .prepare(
      `UPDATE links SET status = 'submitted', submitted_at = datetime('now'), submitted_by = ?, batch = ?
       WHERE key IN (SELECT key FROM links WHERE status = 'queued' ORDER BY confidence DESC, queued_at LIMIT ?)
       RETURNING key, url`,
    )
    .all(member, batch, n) as { key: string; url: string }[];
  for (const r of rows) audit('submit', r.key, batch, member);
  return rows;
}

export const json = <T>(s: string | null | undefined, d: T): T => {
  if (!s) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};
