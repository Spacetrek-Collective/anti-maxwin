# Anti Maxwin

Pipeline TypeScript untuk Hackathon Berantas Web Ilegal (IMPHNEN): **temukan → verifikasi (AI) → dedup → export batch**.

Butuh Node ≥ 23.6 (file `.ts` dijalankan langsung, SQLite bawaan `node:sqlite`).

## Setup

```bash
npm install
npm run setup            # download Chromium untuk Playwright
cp .env.example .env     # isi LLM_API_KEY (DeepSeek dari panitia)
```

Tanpa `LLM_API_KEY`, klasifikasi memakai heuristik kata kunci dan confidence-nya dibatasi < 0.8,
jadi semua hasilnya masuk `review`, tidak ada yang otomatis `verified`.

## Alur kerja

```bash
npm run jh -- crtsh --days 60              # domain baru dari Certificate Transparency
npm run jh -- import dork-results.txt      # URL dari hasil dork / Telegram / X (teks bebas)
npm run jh -- variants brandx brandy       # tebak domain "link alternatif" (cek DNS)
npm run jh -- add https://contoh.xyz/slot  # manual

npm run jh -- verify --limit 100           # buka halaman + screenshot + klasifikasi AI
npm run jh -- review                       # yang confidence-nya tanggung
npm run jh -- approve contoh.xyz           # / reject
npm run jh -- export                       # data/batches/batch-*.txt, 20 link per file
npm run jh -- stats
```

Isi `data/batches/*.txt` di-paste ke form batch panitia (maks. 20 link, jeda 3 detik).
Screenshot bukti ada di `data/shots/` dan berguna untuk write-up kalau masuk top 3.

## Aturan dedup (src/normalize.ts)

Sama persis dengan panitia: hapus `http(s)`, `www.`, query, fragment, dan trailing slash; domain lowercase;
path case-sensitive; subdomain beda dihitung link beda. Port, kredensial, IP, dan localhost ditolak.

## Batasan etis/hukum (wajib)

- Hanya GET halaman publik. Jangan login, daftar, deposit, isi form, atau mengeksploitasi celah.
- Situs instansi/kampus yang disusupi konten judol: laporkan URL-nya saja, jangan menyelidiki celahnya.
- Jalankan di VM/sandbox. Situs phishing bisa membawa malware.
