# CLAUDE.md

## ⚠️ ATURAN NOMOR 1: JANGAN PERNAH MENJALANKAN PROYEK INI DI MESIN INI

Proyek ini membuka situs judol, pinjol ilegal, phishing, dan situs bajakan yang sering membawa
malware / iklan berbahaya. Mesin ini adalah laptop pribadi developer, **bukan** sandbox.
Pipeline hanya boleh dijalankan di VPS sekali pakai di dalam container (lihat README).

Agent AI (Claude, dsb) **DILARANG** menjalankan, walaupun diminta "cuma ngetes sebentar":

- `npm run jh ...`, `node src/cli.ts ...`, atau entrypoint/skrip apa pun dari proyek ini
- `npm install` / `npm ci` / `npx <apa pun>` / `pnpm`/`yarn` install (memicu skrip postinstall
  dan unduhan dependency di mesin ini)
- `npm run setup` / `playwright install` / meluncurkan Chromium/Playwright
- `docker build`, `docker run`, `docker compose up` dan sejenisnya untuk proyek ini
- `curl`, `wget`, `fetch`, `dig`, `nslookup`, browser tool, atau WebFetch ke domain kandidat,
  hasil crt.sh, hasil dork, isi `data/`, atau URL apa pun yang diduga judol/pinjol/phishing
- membuka screenshot/HTML hasil crawl dari sumber yang tidak dikenal
- query ke crt.sh, SearXNG/mesin pencari, atau LLM API dengan kunci milik user

Yang **boleh** dilakukan agent di mesin ini (statis, tidak menyentuh jaringan/target):

- membaca dan mengedit kode, menulis dokumentasi, Dockerfile, compose, dan tes
- tidak ada perintah eksekusi apa pun (termasuk typecheck dan tes); verifikasi kode cukup
  dengan membaca. Tes dan typecheck dijalankan user di dalam container di VPS.

Kalau sebuah perubahan butuh dicoba sungguhan, tulis instruksinya untuk user agar dijalankan
di VPS, lalu berhenti. Jangan mencari jalan lain untuk "mengetes".

## Ringkas proyek

Pipeline TypeScript (Node ≥ 23.6, file `.ts` dijalankan langsung tanpa build, `node:sqlite`) untuk
Hackathon Berantas Web Ilegal IMPHNEN. Worker terpisah yang berkomunikasi lewat SQLite sebagai antrean
(status + lease, lihat komentar di `src/db.ts`):

- `src/discover/*`: kandidat dari crt.sh, SearXNG (service di compose), file, DNS variants, pivot brand
- `src/workers/fetch.ts` + `src/browser.ts`: Playwright yang di-hardening, cloaking, link tersembunyi, prefilter
- `src/workers/triage.ts` + `src/classify.ts`: LLM sebagai "hakim" (kategori, bukti, brand/mirror)
- `src/workers/ads.ts`: crawler iklan di situs bajakan
- `src/ui/server.ts`: review UI (node:http, tanpa dependency)
- `src/cli.ts`: entrypoint semua perintah; `compose.yaml` menjalankan satu image dengan beberapa perintah

Konvensi: kode tetap memakai *erasable syntax only* (tanpa enum/namespace/parameter property), import
pakai ekstensi `.ts`, teks UI/log dalam bahasa Indonesia. Teks apa pun dari situs kandidat wajib
di-escape di UI dan tidak boleh dijadikan link yang bisa diklik.

## Batas etis

Hanya GET halaman publik seperti pengunjung biasa. Tidak login, daftar, deposit, isi form,
brute force, atau mengeksploitasi celah. Situs instansi/kampus yang disusupi: laporkan URL saja.
