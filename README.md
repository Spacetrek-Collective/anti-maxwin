# Anti Maxwin (Judol Radar)

Pipeline TypeScript untuk Hackathon Berantas Web Ilegal (IMPHNEN): cari, verifikasi, dan antrekan
domain/link judol, pinjol ilegal, phishing, dan penipuan untuk disubmit.

> ⚠️ **Jangan jalankan di laptop.** Worker `fetch` dan `ads` membuka situs judol dan situs bajakan yang
> sering membawa malware. Jalankan hanya dengan Docker di **VPS sekali pakai**. Laptop cukup membuka
> review UI lewat SSH tunnel. Agent AI juga dilarang menjalankan proyek ini (lihat `CLAUDE.md`).

## Arsitektur

Tiap tahap adalah worker yang berdiri sendiri. Penghubungnya SQLite (`data/anti-maxwin.db`) yang
dipakai sebagai antrean. Worker mengklaim baris secara atomik dengan lease, jadi bisa dijalankan
beberapa replika, dan kalau crash ia lanjut dari baris terakhir.

```
                    ┌──────── kandidat turunan: redirect, link CSS tersembunyi, popup, mirror dari AI ────────┐
                    ▼                                                                                          │
[discover] ──► new ──► [fetch] ──► fetched ──► [triage] ──► verified ─┐                                        │
 dork SearXNG,          HP Android +  │         AI "hakim":  review ───┤──► [ui] approve ──► queued ──► submitted
 crt.sh, pivot          Referer Google│         kategori,    rejected   │         reject      (batch 20, log siapa)
 brand                  cloaking,     └─► skip  bukti,                  │
                        prefilter regex  (hemat  brand/domain ──────────┘──► pivot (crt.sh + DNS + dork)
[ads] seed situs bajakan → iklan/popup → domain akhir ──► new
```

| Worker | Ambil | Hasil | Akses jaringan |
|---|---|---|---|
| `searxng` | - | hasil dork (JSON) | Google/Bing/DDG/Brave/Mojeek |
| `discover` | jadwal | `new` | SearXNG, crt.sh, DNS |
| `fetch` | `new` | `fetched` / `skip` / `dead` + kandidat turunan | **situs kandidat (berbahaya)** |
| `ads` | tabel `seeds` | `new` (source `ad`) | **situs bajakan (berbahaya)** |
| `triage` | `fetched` | `verified` / `review` / `rejected` (+ brand, mirror) | API LLM saja |
| `ui` | `verified`, `review` | `queued` → `submitted` | tidak ada |

### Peran AI (DeepSeek)

Kode biasa yang mencari, membuka, dan dedup. AI hanya menilai **ringkasan** halaman (URL, judul,
±3.000 karakter teks, rantai redirect, link tersembunyi, hasil cek cloaking). Dalam satu panggilan AI
menjawab:

1. **kategori + confidence**: judol / pinjol / scam / phishing / bersih / parkir / tidak_jelas. AI bisa
   membedakan berita tentang judol dengan situs judol, mengenali teks samaran (`s1ot g4c0r`), dan
   halaman .go.id yang disusupi.
2. **bukti**: kutipan pendek, supaya reviewer bisa approve dalam hitungan detik.
3. **brands + mentioned_domains**: brand dan domain mirror yang disebut di halaman. Hasilnya otomatis
   dipivot lewat crt.sh, DNS variants, dan dork.

Cara menghemat token: prefilter regex membuang halaman tanpa sinyal, teks dipotong, dan putusan AI
di-cache per domain akhir (mirror yang redirect ke domain yang sama cukup dinilai sekali). Tanpa
`LLM_API_KEY` atau saat API error, sistem memakai heuristik regex. Confidence heuristik maksimal 0.79,
jadi hasilnya tidak pernah auto-verified.

### Deteksi judol tersembunyi (semua pasif)

- **Cloaking**: halaman dibuka dengan browser profil HP + Referer Google, lalu dibandingkan dengan HTTP
  biasa memakai UA Googlebot dan UA desktop. Kalau satu versi berisi judol dan versi lain bersih,
  barisnya ditandai `CLOAKING` dan versi "kotor" ikut di-screenshot.
- **Link CSS tersembunyi**: `display:none`, `visibility:hidden`, `opacity:0`, `font-size:0`, di luar
  layar, warna sama dengan background, clip. Tujuan link yang berbau judol jadi kandidat baru.
- **Redirect JS / meta refresh / HTTP**: seluruh rantai dicatat, dan tiap domain di rantai jadi kandidat.
- **Teks disamarkan**: regex toleran leetspeak, spasi, fullwidth, dan zero-width (`src/prefilter.ts`).
- **Mirror**: kesamaan favicon hash dan analytics ID (GA, GTM, FB pixel, LiveChat, Tawk) dengan domain
  yang sudah terbukti diberikan ke AI sebagai `similar_to`.

## Menjalankan di VPS

```bash
# di VPS (Ubuntu/Debian + Docker), BUKAN di laptop
git clone <repo> anti-maxwin && cd anti-maxwin
cp .env.example .env && nano .env        # LLM_API_KEY, SEARXNG_SECRET (openssl rand -hex 32), MEMBER, UI_PASSWORD
./docker/fetch-seccomp.sh                # profil seccomp Playwright → Chromium jalan dengan sandbox
mkdir -p data && sudo chown 1000:1000 data

docker compose run --rm --build test     # tes + typecheck (tanpa jaringan)
docker compose up -d --build             # searxng, discover, fetch, ads, triage, ui
docker compose logs -f fetch triage
docker compose up -d --scale fetch=2     # kalau antrean `new` menumpuk
```

Dari laptop, buka UI lewat tunnel: `ssh -L 8787:127.0.0.1:8787 user@vps`, lalu akses
http://localhost:8787. Isi nama anggota di pojok kanan atas.

Kalau Chromium gagal start dengan sandbox (misalnya kernel host membatasi user namespace), set
`CHROMIUM_SANDBOX=0` dan hapus baris `seccomp=` di `compose.yaml`. Isolasinya jadi hanya container
+ VPS.

Perintah sekali jalan, di dalam container:

```bash
docker compose run --rm discover crtsh --days 30
docker compose run --rm discover search --file dorks/judol.txt
docker compose run --rm discover import /data/dork-manual.txt   # taruh file di ./data
docker compose run --rm discover add https://contoh.xyz/slot
docker compose run --rm discover seed add https://situs-anime.example
docker compose run --rm fetch verify --limit 20                 # fetch lalu triage
docker compose run --rm ui export                               # antrean → data/batches/*.txt
docker compose run --rm ui stats
```

### Search: SearXNG self-hosted (tanpa API key)

Dork dijalankan lewat service `searxng` di compose. Worker memanggil
`http://searxng:8080/search?format=json`, dan SearXNG meneruskannya ke Google, Bing, DuckDuckGo, Brave,
Mojeek, dan Startpage. Konfigurasinya ada di `docker/searxng/settings.yml`: JSON aktif, safe search
mati, limiter mati, dan tidak ada port yang dibuka ke luar.

SearXNG mengambil hasil **dari IP mesin tempat ia berjalan**. Di VPS (IP datacenter), Google sering
memblokir. Kalau itu terjadi, SearXNG menonaktifkan engine yang bermasalah untuk sementara dan
memakai engine lain, tanpa mencoba menembus captcha. Engine yang bermasalah tercatat di log
`discover`. Kalau Google terlalu sering ter-skip:

- pelankan query: `SEARCH_DELAY_MS`, `SEARCH_PAGES`, `DISCOVER_INTERVAL_MIN`;
- atau jalankan SearXNG saja di mesin dengan IP rumah (mis. VM teman) memakai
  `docker/searxng/compose.standalone.yaml`, sambungkan lewat Tailscale, lalu set
  `SEARXNG_URL=http://<ip-tailscale>:8080` di `.env` VPS. Mesin itu tidak menjalankan crawler apa pun.

Daftar dork ada di `dorks/judol.txt` (kandidat) dan `dorks/seeds.txt` (situs bajakan untuk crawler
iklan). File ini di-mount read-only, jadi bisa diedit tanpa rebuild.

## Alur submit (5–9 Des)

1. Tab **review** / **verified** di UI menampilkan screenshot, bukti AI, dan rantai redirect. Klik
   approve/reject, atau centang beberapa lalu approve sekaligus. URL kandidat sengaja tidak bisa
   diklik. **Jangan pernah buka situs kandidat dari browser pribadi.**
2. Klik **ambil batch** untuk mengambil 20 link. Link langsung ditandai `submitted` atas namamu supaya
   anggota lain tidak mengambil link yang sama. Copy semua lalu paste ke form batch panitia (jeda 3 detik).
3. Kalau submit gagal, klik **kembalikan** dan link-link itu masuk antrean lagi.
4. Sebelum 5 Des 00.00, approve sebanyak mungkin supaya antrean `queued` sudah penuh saat submit dibuka.

## Aturan dedup (src/normalize.ts)

Sama dengan aturan panitia: hapus `http(s)`, `www.`, query, fragment, dan trailing slash. Domain
di-lowercase, path tetap case-sensitive, dan subdomain beda dihitung link beda. Port, kredensial, IP,
dan localhost ditolak.

## Keamanan

- Container: non-root (uid 1000), root fs read-only, `cap_drop: ALL`, `no-new-privileges`, batas RAM dan
  PID, `/tmp` di tmpfs. Satu-satunya volume yang bisa ditulis adalah `./data`.
- Chromium: sandbox aktif (dengan seccomp Playwright), download ditolak, semua permission ditolak,
  service worker diblokir, ekstensi mati, context baru tiap kunjungan, dan restart berkala.
- Media, font, websocket, dan eventsource diblokir.
- UI: hanya listen di `127.0.0.1` VPS, CSP ketat, semua teks dari situs di-escape, dan ada basic auth
  opsional.
- VPS tidak menyimpan secret selain API key berkuota terbatas. Setelah lomba, salin `data/` lalu hapus VPS.

## Batasan etis/hukum (wajib)

- Hanya GET halaman publik. Jangan login, daftar, deposit, isi form, atau mengeksploitasi celah.
  Crawler iklan hanya melakukan satu klik netral di pojok halaman untuk memicu popunder.
- Situs instansi/kampus yang disusupi konten judol: laporkan URL-nya saja, jangan menyelidiki celahnya.
