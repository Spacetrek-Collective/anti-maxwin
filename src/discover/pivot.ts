// Mirror pivot dari brand yang diekstrak AI (tabel brands):
//  1. crt.sh: sertifikat dengan nama mengandung brand → domain saudara.
//  2. variants: tebak "brand + suffix + TLD" lalu cek DNS.
//  3. search: dork "brand link alternatif" lewat SearXNG.
// Tidak membuka situs; hanya crt.sh, DNS, dan SearXNG.
import { db } from '../db.ts';
import { discoverCrtsh } from './crtsh.ts';
import { discoverVariants } from './variants.ts';
import { discoverSearch } from './search.ts';

export async function pivotBrands(limit = 10): Promise<number> {
  const brands = db
    .prepare('SELECT name, source_key FROM brands WHERE pivoted_at IS NULL ORDER BY first_seen LIMIT ?')
    .all(limit) as { name: string; source_key: string | null }[];
  if (!brands.length) return 0;

  let total = 0;
  for (const b of brands) {
    console.log(`[pivot] brand ${b.name} (dari ${b.source_key ?? '-'})`);
    total += await discoverCrtsh([b.name], 365, 'pivot', b.source_key);
    total += await discoverVariants([b.name], b.source_key);
    total += await discoverSearch([`"${b.name}" link alternatif`, `"${b.name}" daftar`], 24 * 60);
    db.prepare("UPDATE brands SET pivoted_at = datetime('now') WHERE name = ?").run(b.name);
  }
  return total;
}
