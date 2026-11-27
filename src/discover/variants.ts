// Dari nama brand yang sudah diketahui, tebak domain "link alternatif" lalu cek DNS-nya.
// Hanya resolusi DNS (pasif), tidak membuka situs. Hasilnya tetap harus lewat `verify`.
import { resolve4 } from 'node:dns/promises';
import { addCandidate } from '../db.ts';

const SUFFIXES = ['', '88', '77', '99', '4d', 'gacor', 'slot', 'login', 'alternatif', 'resmi', 'vip', 'link'];
const TLDS = ['com', 'net', 'org', 'xyz', 'site', 'online', 'store', 'top', 'vip', 'pro', 'id', 'cc', 'io', 'me'];

export async function discoverVariants(brands: string[], parent: string | null = null) {
  const hosts = brands.flatMap((b) => SUFFIXES.flatMap((s) => TLDS.map((t) => `${b}${s}.${t}`)));
  let added = 0;
  for (let i = 0; i < hosts.length; i += 20) {
    const chunk = hosts.slice(i, i + 20);
    const res = await Promise.allSettled(chunk.map((h) => resolve4(h)));
    res.forEach((r, j) => {
      if (r.status === 'fulfilled' && addCandidate(chunk[j]!, 'variant', parent)) added++;
    });
  }
  console.log(`[variants] ${hosts.length} domain dicek, ${added} resolve & baru`);
  return added;
}
