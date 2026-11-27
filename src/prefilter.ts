// Prefilter murah sebelum LLM: regex toleran terhadap teks yang disamarkan
// (s1ot, g4c0r, "s l o t", huruf fullwidth, zero-width char, dsb).
// Halaman tanpa sinyal sama sekali tidak dikirim ke LLM (hemat token).

/** Variasi karakter yang sering dipakai untuk menyamarkan kata. */
const LEET: Record<string, string> = {
  a: 'a4@ãáàâ',
  e: 'e3éèê',
  i: 'i1!|l',
  l: 'l1|i',
  o: 'o0ºóòô',
  s: 's5$',
  g: 'g9',
  t: 't7+',
  b: 'b8',
  z: 'z2',
};
/** Pemisah yang boleh disisipkan di antara huruf: spasi, titik, strip, underscore, bintang. */
const SEP = '[\\s._*\\-]{0,2}';

const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');

/** Ubah kata ("slot gacor") jadi regex toleran. Spasi pada kata = boleh ada/tidak ada pemisah. */
export function fuzzy(word: string): string {
  return [...word]
    .map((ch) => (ch === ' ' ? '' : LEET[ch] ? `[${[...LEET[ch]].map(esc).join('')}]` : esc(ch)))
    .filter(Boolean)
    .join(SEP);
}

/** Bersihkan trik unicode: fullwidth/huruf gaya → ASCII (NFKD), hapus diakritik & zero-width, lowercase. */
export function clean(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[​-‍⁠﻿­]/g, '')
    .toLowerCase();
}

const TERMS: Record<string, { strong: string[]; weak: string[] }> = {
  judol: {
    strong: [
      'slot gacor', 'maxwin', 'situs slot', 'togel', 'toto macau', 'bandar togel', 'rtp live', 'rtp slot',
      'scatter hitam', 'mahjong ways', 'gates of olympus', 'pragmatic play', 'pg soft', 'bonus new member',
      'link alternatif', 'depo 10k', 'deposit pulsa', 'deposit qris', 'deposit dana', 'sbobet', 'judi online',
      'casino online', 'live casino', 'sabung ayam', 'zeus', 'starlight princess', 'gacor hari ini',
    ],
    weak: ['slot', 'gacor', 'jackpot', 'jp', 'scatter', 'spin', 'deposit', 'withdraw', 'wd', 'bet', 'toto', 'rtp', '4d'],
  },
  pinjol: {
    strong: [
      'pinjaman tanpa jaminan', 'pinjaman cepat cair', 'cair dalam', 'tanpa bi checking', 'tanpa slik',
      'cukup ktp', 'modal ktp', 'pinjaman online tanpa', 'langsung cair', 'pinjol',
    ],
    weak: ['pinjaman', 'limit', 'tenor', 'bunga rendah', 'cair'],
  },
  scam: {
    strong: [
      'verifikasi akun anda', 'akun anda diblokir', 'akun anda ditangguhkan', 'masukkan pin', 'masukkan otp',
      'hadiah undian', 'selamat anda terpilih', 'klaim hadiah', 'investasi profit harian', 'robot trading',
      'tarif transfer baru', 'kirim kode otp',
    ],
    weak: ['hadiah', 'undian', 'otp', 'profit', 'klaim'],
  },
};

const COMPILED = Object.fromEntries(
  Object.entries(TERMS).map(([cat, t]) => [
    cat,
    {
      strong: new RegExp(`(?<![a-z])(?:${t.strong.map(fuzzy).join('|')})(?![a-z])`, 'gi'),
      weak: new RegExp(`(?<![a-z])(?:${t.weak.map(fuzzy).join('|')})(?![a-z])`, 'gi'),
    },
  ]),
) as Record<string, { strong: RegExp; weak: RegExp }>;

export type PrefilterResult = {
  /** Skor gabungan: strong = 3 poin, weak = 1 poin. */
  score: number;
  /** Kategori dengan skor tertinggi (atau null kalau 0). */
  top: string | null;
  hits: Record<string, { score: number; samples: string[] }>;
};

export function prefilter(text: string): PrefilterResult {
  const t = clean(text);
  const hits: PrefilterResult['hits'] = {};
  let best: [string | null, number] = [null, 0];
  let total = 0;
  for (const [cat, re] of Object.entries(COMPILED)) {
    const strong = t.match(re.strong) ?? [];
    const weak = t.match(re.weak) ?? [];
    const score = strong.length * 3 + weak.length;
    hits[cat] = { score, samples: [...new Set(strong.length ? strong : weak)].slice(0, 5) };
    total += score;
    if (score > best[1]) best = [cat, score];
  }
  return { score: total, top: best[0], hits };
}

/**
 * Apakah halaman layak dikirim ke LLM. Satu kata lemah saja ("deposit", "spin") tidak cukup;
 * butuh minimal satu frasa kuat atau beberapa kata lemah.
 */
export function worthTriage(r: PrefilterResult, min = 3): boolean {
  return r.score >= min;
}
