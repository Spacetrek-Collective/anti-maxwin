import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { normalize } from './normalize.ts';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(`${config.dataDir}/anti-maxwin.db`);

db.exec(`
CREATE TABLE IF NOT EXISTS links (
  key           TEXT PRIMARY KEY,            -- hasil normalisasi (kunci dedup panitia)
  url           TEXT NOT NULL,
  source        TEXT NOT NULL,               -- crtsh | file | variant | redirect | manual
  status        TEXT NOT NULL DEFAULT 'new', -- new | verified | review | rejected | exported
  label         TEXT,
  confidence    REAL,
  reason        TEXT,
  final_url     TEXT,
  screenshot    TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  checked_at    TEXT,
  exported_at   TEXT,
  batch         TEXT
);
CREATE INDEX IF NOT EXISTS idx_status ON links(status);
`);

export type LinkRow = {
  key: string;
  url: string;
  source: string;
  status: string;
  label: string | null;
  confidence: number | null;
  reason: string | null;
};

const insertStmt = db.prepare('INSERT OR IGNORE INTO links (key, url, source) VALUES (?, ?, ?)');

/** Tambah kandidat. Return true kalau baru (belum ada di DB). */
export function addCandidate(input: string, source: string): boolean {
  const n = normalize(input);
  if (!n.ok) return false;
  return Number(insertStmt.run(n.key, n.url, source).changes) > 0;
}

export function pending(limit: number): LinkRow[] {
  return db
    .prepare("SELECT * FROM links WHERE status = 'new' ORDER BY discovered_at LIMIT ?")
    .all(limit) as unknown as LinkRow[];
}

export function saveVerdict(
  key: string,
  v: { status: string; label: string; confidence: number; reason: string; finalUrl?: string; screenshot?: string },
) {
  db.prepare(
    `UPDATE links SET status = ?, label = ?, confidence = ?, reason = ?, final_url = ?, screenshot = ?,
     checked_at = datetime('now') WHERE key = ?`,
  ).run(v.status, v.label, v.confidence, v.reason, v.finalUrl ?? null, v.screenshot ?? null, key);
}
