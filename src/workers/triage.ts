// Worker TRIAGE: fetched → verified | review | rejected (atau queued kalau AUTO_QUEUE).
// Satu panggilan LLM per halaman: kategori + bukti + brand/domain yang disebut (untuk pivot).
// Tidak membuka situs apa pun; hanya membaca DB dan memanggil API LLM.
import { config } from '../config.ts';
import { addCandidate, audit, claim, db, json, updateLink, type LinkRow } from '../db.ts';
import { classify, ILLEGAL_LABELS, type Verdict } from '../classify.ts';
import { prefilter } from '../prefilter.ts';
import { hostOf } from '../normalize.ts';

const PROVEN = "status IN ('verified','queued','submitted') AND label IN ('judol','pinjol','scam','phishing')";

/** Domain lain yang sudah terbukti ilegal dengan favicon atau analytics ID yang sama (indikasi mirror). */
function similarTo(row: LinkRow): string[] {
  const out = new Set<string>();
  if (row.favicon_hash) {
    for (const r of db
      .prepare(`SELECT key FROM links WHERE favicon_hash = ? AND key != ? AND ${PROVEN} LIMIT 5`)
      .all(row.favicon_hash, row.key) as { key: string }[])
      out.add(`${r.key} (favicon sama)`);
  }
  for (const id of json<string[]>(row.analytics_ids, []).slice(0, 5)) {
    for (const r of db
      .prepare(`SELECT key FROM links WHERE analytics_ids LIKE ? AND key != ? AND ${PROVEN} LIMIT 3`)
      .all(`%"${id}"%`, row.key) as { key: string }[])
      out.add(`${r.key} (${id})`);
  }
  return [...out].slice(0, 8);
}

function cached(row: LinkRow): Verdict | null {
  // Cache hanya untuk halaman yang redirect ke domain LAIN: banyak mirror menuju domain akhir yang sama.
  if (!row.final_domain || row.final_domain === hostOf(row.url)) return null;
  const c = db.prepare('SELECT verdict FROM llm_cache WHERE final_domain = ?').get(row.final_domain) as { verdict: string } | undefined;
  const v = c ? json<Verdict | null>(c.verdict, null) : null;
  return v ? { ...v, source: 'cache' } : null;
}

function decideStatus(v: Verdict, row: LinkRow): string {
  const illegal = ILLEGAL_LABELS.includes(v.label);
  if (illegal && v.confidence >= config.minConfidence) {
    return config.autoQueue && v.source !== 'heuristic' && v.confidence >= config.autoQueueConfidence ? 'queued' : 'verified';
  }
  if (illegal) return 'review';
  // LLM ragu padahal sinyal regex kuat / cloaking → manusia yang memutuskan.
  if (v.label === 'tidak_jelas' && ((row.prefilter_score ?? 0) >= 9 || row.cloaked)) return 'review';
  return 'rejected';
}

async function processRow(row: LinkRow) {
  let v = cached(row);
  if (!v) {
    const hidden = json<{ href: string; text: string }[]>(row.hidden_links, []);
    const outlinks = json<{ host: string | null }[]>(row.outlinks, []);
    v = await classify({
      url: row.url,
      finalUrl: row.final_url ?? row.url,
      title: row.title ?? '',
      text: row.page_text ?? '',
      redirectChain: json<string[]>(row.redirect_chain, []),
      outlinkHosts: [...new Set(outlinks.map((o) => o.host).filter((h): h is string => !!h))],
      hiddenLinks: hidden.map((h) => ({ href: h.href, text: h.text })),
      prefilter: prefilter(`${row.title ?? ''}\n${row.page_text ?? ''}`),
      cloaked: !!row.cloaked,
      similarTo: similarTo(row),
    });
    if (v.source === 'llm' && row.final_domain && row.final_domain !== hostOf(row.url)) {
      db.prepare('INSERT OR REPLACE INTO llm_cache (final_domain, verdict) VALUES (?, ?)').run(row.final_domain, JSON.stringify(v));
    }
  }

  const status = decideStatus(v, row);
  updateLink(row.key, {
    status,
    label: v.label,
    confidence: v.confidence,
    reason: v.reason,
    evidence: JSON.stringify(v.evidence),
    brands: JSON.stringify(v.brands),
    verdict_source: v.source,
    checked_at: new Date().toISOString(),
    ...(status === 'queued' ? { queued_at: new Date().toISOString(), reviewed_by: 'auto' } : {}),
  });
  if (status === 'queued') audit('auto_queue', row.key, `${v.label} ${v.confidence}`, 'auto');

  // Pivot: hanya dari halaman yang memang ilegal, supaya brand/domain dari berita tidak ikut.
  let pivots = 0;
  if (ILLEGAL_LABELS.includes(v.label)) {
    for (const d of v.mentionedDomains) if (addCandidate(d, 'ai_mention', row.key)) pivots++;
    for (const b of v.brands) db.prepare('INSERT OR IGNORE INTO brands (name, source_key) VALUES (?, ?)').run(b, row.key);
  }
  console.log(
    `${status.padEnd(8)} ${v.label.padEnd(11)} ${v.confidence.toFixed(2)} [${v.source}] ${row.key}${pivots ? ` +${pivots} mirror` : ''}${v.brands.length ? ` brand=${v.brands.join(',')}` : ''}`,
  );
}

export async function runTriage(opts: { once?: boolean; limit?: number; signal?: AbortSignal } = {}) {
  let budget = opts.limit ?? Infinity;
  const parallel = Math.max(1, Math.min(16, config.triageConcurrency));

  const worker = async () => {
    while (!opts.signal?.aborted && budget > 0) {
      const [row] = claim('fetched', 'triaging', 1);
      if (!row) {
        if (opts.once) return;
        await new Promise((r) => setTimeout(r, config.idleSleepSec * 1000));
        continue;
      }
      budget--;
      try {
        await processRow(row);
      } catch (e) {
        console.warn(`[triage] error ${row.key}: ${(e as Error).message}`);
        updateLink(row.key, { status: 'fetched', error: (e as Error).message.slice(0, 300) });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}
