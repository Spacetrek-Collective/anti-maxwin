// Worker DISCOVER: loop berjadwal. Tidak membuka situs kandidat; hanya SearXNG, crt.sh, dan DNS.
//   - tiap DISCOVER_INTERVAL_MIN: dork (dorks/judol.txt) + crt.sh keyword default
//   - tiap 2 menit: pivot brand baru hasil AI (crt.sh + variants + dork brand)
//   - tiap 24 jam: cari seed situs bajakan untuk worker ads (dorks/seeds.txt)
import { config } from '../config.ts';
import { discoverCrtsh, DEFAULT_KEYWORDS } from '../discover/crtsh.ts';
import { discoverSearch, readDorks } from '../discover/search.ts';
import { pivotBrands } from '../discover/pivot.ts';
import { discoverSeeds } from './ads.ts';

export async function runDiscover(opts: { signal?: AbortSignal } = {}) {
  const last = { main: 0, seeds: 0 };
  while (!opts.signal?.aborted) {
    const now = Date.now();
    try {
      if (now - last.main >= config.discoverIntervalMin * 60_000) {
        last.main = now;
        await discoverSearch(readDorks('dorks/judol.txt'));
        await discoverCrtsh(DEFAULT_KEYWORDS, config.crtshDays);
      }
      if (now - last.seeds >= 24 * 3_600_000) {
        last.seeds = now;
        await discoverSeeds();
      }
      await pivotBrands(10);
    } catch (e) {
      console.warn(`[discover] ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 120_000));
  }
}
