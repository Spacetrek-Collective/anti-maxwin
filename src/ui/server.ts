// Review UI: daftar kandidat + screenshot + bukti AI, approve/reject (juga massal), ambil batch 20 untuk
// di-submit ke form panitia, dan statistik funnel untuk write-up. Tanpa dependency (node:http).
//
// Keamanan:
//  - URL kandidat TIDAK pernah jadi link yang bisa diklik (jangan buka situs kandidat di browser pribadi).
//  - Semua teks dari situs (title, bukti, teks) di-escape; CSP ketat dengan nonce untuk script kecil.
//  - Bind ke 127.0.0.1 di VPS; akses dari laptop lewat SSH tunnel. Opsional basic auth (UI_PASSWORD).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config, shotsDir } from '../config.ts';
import { db, decide, json, takeBatch, audit, type LinkRow } from '../db.ts';

const TABS = ['review', 'verified', 'queued', 'submitted', 'fetched', 'skip', 'rejected', 'dead'] as const;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function memberOf(req: IncomingMessage): string {
  const m = /(?:^|;\s*)member=([^;]+)/.exec(req.headers.cookie ?? '');
  return m ? decodeURIComponent(m[1]!).replace(/[^\w .-]/g, '').slice(0, 30) || 'anon' : 'anon';
}

async function body(req: IncomingMessage): Promise<URLSearchParams> {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > 200_000) break;
  }
  return new URLSearchParams(s);
}

function layout(nonce: string, member: string, title: string, content: string): string {
  const counts = Object.fromEntries(
    (db.prepare('SELECT status, COUNT(*) n FROM links GROUP BY status').all() as { status: string; n: number }[]).map((r) => [r.status, r.n]),
  );
  const tabs = TABS.map((t) => `<a href="/list?status=${t}">${t} <b>${counts[t] ?? 0}</b></a>`).join('');
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${esc(title)} · Anti Maxwin</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin">
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:0;background:#f5f5f4;color:#1c1917}
header{position:sticky;top:0;background:#1c1917;color:#fafaf9;padding:8px 16px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;z-index:2}
header a{color:#d6d3d1;text-decoration:none}header a b{color:#fbbf24}
main{padding:16px;max-width:1400px;margin:auto}
.card{background:#fff;border:1px solid #e7e5e4;border-radius:8px;padding:12px;margin-bottom:12px;display:grid;grid-template-columns:auto 1fr;gap:14px}
.shots img{width:230px;max-height:420px;object-fit:cover;object-position:top;border:1px solid #d6d3d1;border-radius:4px;display:block;margin-bottom:6px}
.key{font:600 15px ui-monospace,monospace;word-break:break-all}
.lbl{display:inline-block;padding:1px 8px;border-radius:99px;background:#fee2e2;color:#991b1b;font-weight:600}
.lbl.bersih,.lbl.parkir,.lbl.tidak_jelas{background:#e7e5e4;color:#44403c}
.muted{color:#78716c;font-size:12px}ul{margin:4px 0;padding-left:18px}
button{font:inherit;padding:5px 12px;border-radius:6px;border:1px solid #a8a29e;background:#fff;cursor:pointer}
button.ok{background:#16a34a;color:#fff;border-color:#15803d}button.no{background:#dc2626;color:#fff;border-color:#b91c1c}
textarea{width:100%;font:13px ui-monospace,monospace}table{border-collapse:collapse;background:#fff}td,th{border:1px solid #e7e5e4;padding:4px 10px;text-align:left}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
</style></head><body>
<header><b>Anti Maxwin</b>${tabs}<a href="/batch">ambil batch</a><a href="/stats">stats</a>
<form method="post" action="/member" style="margin-left:auto">anggota: <input name="member" value="${esc(member)}" size="10"><button>set</button></form></header>
<main>${content}</main>
<script nonce="${nonce}">
document.addEventListener('click', e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const t = b.dataset.copy || document.getElementById(b.dataset.copyFrom).value;
  navigator.clipboard.writeText(t).then(() => { b.textContent = 'tersalin ✓'; });
});
const all = document.getElementById('checkall');
if (all) all.addEventListener('change', () => document.querySelectorAll('input[name=key]').forEach(c => c.checked = all.checked));
</script></body></html>`;
}

function card(r: LinkRow): string {
  const ev = json<string[]>(r.evidence, []);
  const chain = json<string[]>(r.redirect_chain, []);
  const hidden = json<{ href: string; text: string; why: string }[]>(r.hidden_links, []);
  const cloak = json<Record<string, number>>(r.cloak, {});
  const brands = json<string[]>(r.brands, []);
  const shot = (p: string | null, cap: string) =>
    p && existsSync(p) ? `<img src="/shot?f=${encodeURIComponent(basename(p))}" alt="${esc(cap)}" loading="lazy"><div class="muted">${esc(cap)}</div>` : '';
  return `<div class="card">
  <div class="shots">${shot(r.screenshot, 'mobile + referer google')}${shot(r.screenshot_alt, 'versi cloaking')}</div>
  <div>
    <label><input type="checkbox" name="key" value="${esc(r.key)}" form="bulk"> <span class="key">${esc(r.key)}</span></label>
    <button type="button" data-copy="${esc(r.url)}">copy URL</button>
    <div style="margin:6px 0">
      ${r.label ? `<span class="lbl ${esc(r.label)}">${esc(r.label)}</span> ${r.confidence?.toFixed(2) ?? ''}` : ''}
      <span class="muted">· ${esc(r.verdict_source ?? '')} · sumber ${esc(r.source)}${r.parent ? ` dari ${esc(r.parent)}` : ''} · prefilter ${r.prefilter_score ?? '-'}${r.cloaked ? ' · <b style="color:#b91c1c">CLOAKING</b>' : ''}</span>
    </div>
    ${r.reason ? `<div>${esc(r.reason)}</div>` : ''}
    ${ev.length ? `<ul>${ev.map((e) => `<li>“${esc(e)}”</li>`).join('')}</ul>` : ''}
    <div class="muted">title: ${esc(r.title)}</div>
    ${r.final_url && r.final_url.replace(/\/$/, '') !== r.url.replace(/\/$/, '') ? `<div class="muted">akhir: ${esc(r.final_url)}</div>` : ''}
    ${chain.length > 1 ? `<div class="muted">redirect: ${chain.map(esc).join(' → ')}</div>` : ''}
    ${Object.keys(cloak).length > 1 ? `<div class="muted">skor per profil: ${esc(JSON.stringify(cloak))}</div>` : ''}
    ${brands.length ? `<div class="muted">brand: ${esc(brands.join(', '))}</div>` : ''}
    ${hidden.length ? `<details><summary class="muted">${hidden.length} link tersembunyi</summary><ul>${hidden.slice(0, 30).map((h) => `<li class="muted">${esc(h.why)}: ${esc(h.text)} → ${esc(h.href)}</li>`).join('')}</ul></details>` : ''}
    ${r.page_text ? `<details><summary class="muted">teks halaman</summary><pre style="white-space:pre-wrap;max-height:300px;overflow:auto">${esc(r.page_text.slice(0, 3000))}</pre></details>` : ''}
    ${r.submitted_by ? `<div class="muted">submit: ${esc(r.submitted_by)} ${esc(r.submitted_at)} (${esc(r.batch)})</div>` : r.reviewed_by ? `<div class="muted">review: ${esc(r.reviewed_by)}</div>` : ''}
    <form method="post" action="/act" style="margin-top:8px"><input type="hidden" name="key" value="${esc(r.key)}">
      <button name="action" value="approve" class="ok">approve</button> <button name="action" value="reject" class="no">reject</button></form>
  </div></div>`;
}

function listPage(url: URL): [string, string] {
  const status = (TABS as readonly string[]).includes(url.searchParams.get('status') ?? '') ? url.searchParams.get('status')! : 'review';
  const page = Math.max(0, Number(url.searchParams.get('p') ?? 0) || 0);
  const label = url.searchParams.get('label');
  const rows = db
    .prepare(
      `SELECT * FROM links WHERE status = ? ${label ? 'AND label = ?' : ''}
       ORDER BY cloaked DESC, confidence DESC, prefilter_score DESC, checked_at DESC LIMIT 50 OFFSET ?`,
    )
    .all(...(label ? [status, label, page * 50] : [status, page * 50])) as unknown as LinkRow[];
  const bar = `<div class="bar"><form id="bulk" method="post" action="/act"><label><input type="checkbox" id="checkall"> pilih semua</label>
    <button name="action" value="approve" class="ok">approve terpilih</button> <button name="action" value="reject" class="no">reject terpilih</button></form>
    <span class="muted">${status} · halaman ${page + 1}</span>
    ${page > 0 ? `<a href="/list?status=${status}&p=${page - 1}">← sebelumnya</a>` : ''}
    ${rows.length === 50 ? `<a href="/list?status=${status}&p=${page + 1}">berikutnya →</a>` : ''}</div>`;
  return [status, bar + (rows.length ? rows.map(card).join('') : '<p>Kosong.</p>')];
}

function batchPage(): string {
  const queued = (db.prepare("SELECT COUNT(*) n FROM links WHERE status = 'queued'").get() as { n: number }).n;
  const recent = db
    .prepare(
      `SELECT batch, submitted_by, MIN(submitted_at) at, COUNT(*) n FROM links WHERE status = 'submitted' AND batch IS NOT NULL
       GROUP BY batch ORDER BY at DESC LIMIT 15`,
    )
    .all() as { batch: string; submitted_by: string; at: string; n: number }[];
  return `<h2>Antrean submit: ${queued} link</h2>
  <p class="muted">Ambil batch → link ditandai <b>submitted</b> atas namamu → paste ke form batch panitia (maks 20, jeda 3 detik).
  Kalau gagal submit, tekan "kembalikan".</p>
  <form method="post" action="/batch"><button class="ok">ambil 20 link</button></form>
  <h3>Batch terakhir</h3><table><tr><th>batch</th><th>oleh</th><th>waktu</th><th>link</th><th></th></tr>
  ${recent.map((b) => `<tr><td><a href="/batch/view?b=${encodeURIComponent(b.batch)}">${esc(b.batch)}</a></td><td>${esc(b.submitted_by)}</td><td>${esc(b.at)}</td><td>${b.n}</td>
    <td><form method="post" action="/batch/undo"><input type="hidden" name="b" value="${esc(b.batch)}"><button>kembalikan</button></form></td></tr>`).join('')}</table>`;
}

function batchView(name: string): string {
  const urls = (db.prepare('SELECT url FROM links WHERE batch = ? ORDER BY confidence DESC').all(name) as { url: string }[]).map((r) => r.url);
  return `<h2>${esc(name)} (${urls.length} link)</h2><textarea id="b" rows="22" readonly>${esc(urls.join('\n'))}</textarea>
  <p><button type="button" data-copy-from="b" class="ok">copy semua</button> <a href="/batch">kembali</a></p>`;
}

function statsPage(): string {
  const table = (rows: Record<string, unknown>[]) =>
    rows.length
      ? `<table><tr>${Object.keys(rows[0]!).map((k) => `<th>${esc(k)}</th>`).join('')}</tr>${rows
          .map((r) => `<tr>${Object.values(r).map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`)
          .join('')}</table>`
      : '<p>-</p>';
  const q = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  return `<h2>Funnel</h2>${table(q(`SELECT
      COUNT(*) kandidat,
      SUM(status NOT IN ('new','fetching')) dibuka,
      SUM(status NOT IN ('new','fetching','skip','dead')) lolos_prefilter,
      SUM(label IN ('judol','pinjol','scam','phishing')) ilegal_menurut_ai,
      SUM(status IN ('queued','submitted')) diapprove,
      SUM(status = 'submitted') disubmit
    FROM links`))}
  <h2>Sumber paling produktif</h2>${table(q(`SELECT source,
      COUNT(*) kandidat, SUM(status IN ('verified','review','queued','submitted')) ilegal, SUM(status = 'submitted') submit
    FROM links GROUP BY source ORDER BY submit DESC, ilegal DESC`))}
  <h2>Kategori</h2>${table(q(`SELECT label, COUNT(*) n, ROUND(AVG(confidence),2) conf FROM links WHERE label IS NOT NULL GROUP BY label ORDER BY n DESC`))}
  <h2>Teknik tersembunyi</h2>${table(q(`SELECT
      SUM(cloaked) cloaking, SUM(source='hidden_link') dari_link_css, SUM(source='redirect') dari_redirect,
      SUM(source='ad') dari_iklan, SUM(source='ai_mention') dari_mirror_ai,
      SUM(key LIKE '%.go.id%' OR key LIKE '%.ac.id%' OR key LIKE '%.sch.id%') situs_instansi
    FROM links WHERE status IN ('verified','review','queued','submitted')`))}
  <h2>Per anggota</h2>${table(q(`SELECT member, action, COUNT(*) n, MAX(at) terakhir FROM audit GROUP BY member, action ORDER BY member`))}
  <h2>Submit per jam (WIB)</h2>${table(q(`SELECT strftime('%Y-%m-%d %H:00', submitted_at, '+7 hours') jam, COUNT(*) n FROM links
      WHERE submitted_at IS NOT NULL GROUP BY jam ORDER BY jam DESC LIMIT 48`))}`;
}

function send(res: ServerResponse, code: number, html: string, nonce: string) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin', // referer hanya ke UI sendiri (untuk kembali ke tab setelah approve)
  });
  res.end(html);
}

const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(303, { location: to });
  res.end();
};

export function startUi() {
  const server = createServer(async (req, res) => {
    try {
      if (config.uiPassword) {
        const auth = req.headers.authorization ?? '';
        const pass = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
        if (pass !== config.uiPassword) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="anti-maxwin"' });
          return res.end('auth');
        }
      }
      const url = new URL(req.url ?? '/', 'http://ui.local');
      const member = memberOf(req);
      const nonce = randomBytes(16).toString('base64');

      if (req.method === 'POST') {
        // CSRF sederhana: tolak POST dari origin lain.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) {
          res.writeHead(403);
          return res.end('origin');
        }
        const f = await body(req);
        switch (url.pathname) {
          case '/member': {
            const m = (f.get('member') ?? '').replace(/[^\w .-]/g, '').slice(0, 30) || 'anon';
            res.setHeader('set-cookie', `member=${encodeURIComponent(m)}; Path=/; SameSite=Strict; Max-Age=2592000`);
            return redirect(res, req.headers.referer ? new URL(req.headers.referer).pathname + new URL(req.headers.referer).search : '/');
          }
          case '/act': {
            const action = f.get('action') === 'approve' ? 'approve' : 'reject';
            for (const k of f.getAll('key')) decide(k, action, member);
            const back = req.headers.referer ? new URL(req.headers.referer) : null;
            return redirect(res, back ? back.pathname + back.search : '/');
          }
          case '/batch': {
            const stamp = new Date(Date.now() + 7 * 3_600_000).toISOString().replace(/[-:]/g, '').slice(0, 15);
            const name = `ui-${stamp}-${member.replace(/\W/g, '')}`;
            const rows = takeBatch(20, name, member);
            return redirect(res, rows.length ? `/batch/view?b=${encodeURIComponent(name)}` : '/batch');
          }
          case '/batch/undo': {
            const b = f.get('b') ?? '';
            const n = db
              .prepare("UPDATE links SET status = 'queued', submitted_at = NULL, submitted_by = NULL, batch = NULL WHERE batch = ? AND status = 'submitted'")
              .run(b).changes;
            audit('unsubmit', null, `${b} (${n})`, member);
            return redirect(res, '/batch');
          }
        }
        res.writeHead(404);
        return res.end();
      }

      switch (url.pathname) {
        case '/':
          return redirect(res, '/list?status=review');
        case '/list': {
          const [status, html] = listPage(url);
          return send(res, 200, layout(nonce, member, status, html), nonce);
        }
        case '/batch':
          return send(res, 200, layout(nonce, member, 'batch', batchPage()), nonce);
        case '/batch/view':
          return send(res, 200, layout(nonce, member, 'batch', batchView(url.searchParams.get('b') ?? '')), nonce);
        case '/stats':
          return send(res, 200, layout(nonce, member, 'stats', statsPage()), nonce);
        case '/shot': {
          const f = basename(url.searchParams.get('f') ?? '');
          const p = resolve(shotsDir(), f);
          if (!f.endsWith('.png') || !p.startsWith(resolve(shotsDir())) || !existsSync(p)) {
            res.writeHead(404);
            return res.end();
          }
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' });
          return void createReadStream(p).pipe(res);
        }
      }
      res.writeHead(404);
      res.end('404');
    } catch (e) {
      console.error('[ui]', e);
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  });
  server.listen(config.uiPort, config.uiHost, () => console.log(`[ui] http://${config.uiHost}:${config.uiPort}`));
  return server;
}
