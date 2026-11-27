// Discovery pasif via Certificate Transparency (crt.sh).
// Situs judol sering rotasi domain ("link alternatif"); domain baru langsung tercatat di CT log.
import { addCandidate } from '../db.ts';

export const DEFAULT_KEYWORDS = [
  'gacor', 'slot', 'maxwin', 'toto', 'togel', 'rtp', 'zeus', 'mahjong', 'scatter',
  'judi', 'casino', 'jackpot', 'pinjol', 'danacepat', 'pinjaman',
];

type CrtEntry = { name_value: string; not_before: string };

export async function discoverCrtsh(keywords: string[], days: number, source = 'crtsh', parent: string | null = null) {
  const since = Date.now() - days * 86_400_000;
  let total = 0;
  for (const kw of keywords) {
    const url = `https://crt.sh/?q=${encodeURIComponent(`%${kw}%`)}&output=json&exclude=expired`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as CrtEntry[];
      let added = 0;
      for (const r of rows) {
        if (Date.parse(r.not_before + 'Z') < since) continue;
        for (const name of r.name_value.split('\n')) {
          const host = name.trim().replace(/^\*\./, '');
          if (addCandidate(host, source, parent)) added++;
        }
      }
      console.log(`[crt.sh] ${kw}: ${rows.length} sertifikat, ${added} kandidat baru`);
      total += added;
    } catch (e) {
      console.warn(`[crt.sh] ${kw}: gagal (${(e as Error).message}); crt.sh sering lambat, coba lagi nanti`);
    }
    await new Promise((r) => setTimeout(r, 3000)); // jeda supaya sopan ke crt.sh
  }
  return total;
}
