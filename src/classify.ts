// Klasifikasi halaman: LLM (OpenAI-compatible, mis. DeepSeek) + fallback heuristik kata kunci.
import { config } from './config.ts';

export const ILLEGAL_LABELS = ['judol', 'pinjol_ilegal', 'phishing', 'penipuan', 'ilegal_lain'] as const;
export type Verdict = { label: string; confidence: number; reason: string };

const KEYWORDS: Record<string, RegExp> = {
  judol: /slot\s*gacor|maxwin|rtp\s*(live|slot)|scatter|togel|toto\s*\d*|deposit\s*(pulsa|dana|qris)|bandar|situs\s*slot|pragmatic|mahjong\s*ways|zeus|jackpot|depo\s*\d+|bonus\s*new\s*member|link\s*alternatif/gi,
  pinjol_ilegal: /pinjaman\s*(cepat|tanpa\s*jaminan|online)|cair\s*(cepat|dalam)|tanpa\s*bi\s*checking|ktp\s*saja/gi,
  phishing: /verifikasi\s*akun|akun\s*anda\s*(diblokir|ditangguhkan)|masukkan\s*(pin|otp|kata\s*sandi)|hadiah\s*undian/gi,
};

export function keywordHits(text: string) {
  const hits: Record<string, number> = {};
  for (const [label, re] of Object.entries(KEYWORDS)) hits[label] = text.match(re)?.length ?? 0;
  return hits;
}

function heuristic(text: string): Verdict {
  const hits = keywordHits(text);
  const [label, n] = Object.entries(hits).sort((a, b) => b[1] - a[1])[0]!;
  if (n === 0) return { label: 'tidak_jelas', confidence: 0.3, reason: 'tidak ada kata kunci' };
  return { label, confidence: Math.min(0.5 + n * 0.05, 0.79), reason: `heuristik: ${n} kata kunci ${label}` };
}

const SYSTEM = `Kamu analis keamanan yang membantu Komdigi mengidentifikasi situs ilegal di Indonesia.
Diberi URL dan teks halaman, klasifikasikan ke salah satu label:
- judol: perjudian daring (slot, togel, casino, sportsbook, dsb)
- pinjol_ilegal: pinjaman online yang tidak berizin / predator
- phishing: meniru bank/e-wallet/instansi untuk mencuri kredensial
- penipuan: investasi bodong, toko palsu, undian palsu
- ilegal_lain: aktivitas ilegal lain yang jelas
- bersih: situs legal/normal (termasuk berita ATAU edukasi tentang judol)
- parkir: domain parkir / dijual / halaman default hosting
- tidak_jelas: konten kurang untuk memutuskan
Catatan: situs pemerintah/kampus yang disusupi konten judol (SEO spam) dilabeli judol.
Jawab HANYA JSON: {"label": string, "confidence": number 0..1, "reason": string maks 120 karakter, bahasa Indonesia}`;

export async function classify(input: { url: string; finalUrl: string; title: string; text: string }): Promise<Verdict> {
  if (!config.llmApiKey) return heuristic(input.title + '\n' + input.text);

  const user = JSON.stringify({
    url: input.url,
    final_url: input.finalUrl,
    title: input.title,
    keyword_hits: keywordHits(input.text),
    text: input.text.slice(0, 4000),
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llmApiKey}` },
        body: JSON.stringify({
          model: config.llmModel,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      const raw = data.choices[0]!.message.content.replace(/^```(json)?|```$/g, '').trim();
      const v = JSON.parse(raw) as Verdict;
      return { label: String(v.label), confidence: Number(v.confidence) || 0, reason: String(v.reason ?? '').slice(0, 140) };
    } catch (e) {
      if (attempt === 3) {
        console.warn(`[llm] gagal untuk ${input.url}: ${(e as Error).message}; pakai heuristik`);
        return heuristic(input.title + '\n' + input.text);
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error('unreachable');
}
