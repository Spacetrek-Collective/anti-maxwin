// Import kandidat dari file teks (hasil dork manual, copy dari Telegram/X, dsb).
// URL/domain diekstrak dari teks bebas.
import { readFileSync } from 'node:fs';
import { addCandidate } from '../db.ts';

const URL_RE = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>)]*)?/gi;

export function importFile(path: string, source = 'file') {
  const text = readFileSync(path, 'utf8');
  let added = 0;
  for (const m of text.matchAll(URL_RE)) if (addCandidate(m[0], source)) added++;
  return added;
}
