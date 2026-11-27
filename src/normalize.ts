// Normalisasi mengikuti aturan panitia:
// - hapus http(s)://, www., query, fragment, trailing slash
// - domain lowercase, path tetap case-sensitive
// - tolak: bukan http/https, ada port, ada user:pass, IP, localhost, > 300 karakter

export type NormalizeResult =
  | { ok: true; key: string; url: string }
  | { ok: false; reason: string };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function normalize(input: string): NormalizeResult {
  let raw = input.trim();
  if (!raw) return { ok: false, reason: 'kosong' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  if (raw.length > 300) return { ok: false, reason: 'lebih dari 300 karakter' };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL tidak valid' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'bukan http/https' };
  if (u.port) return { ok: false, reason: 'mengandung port' };
  if (u.username || u.password) return { ok: false, reason: 'mengandung kredensial' };

  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost' };
  if (IPV4.test(host) || host.startsWith('[')) return { ok: false, reason: 'alamat IP' };
  if (!host.includes('.')) return { ok: false, reason: 'bukan domain' };
  host = host.replace(/^www\./, '');

  // URL() sudah meng-encode path; path TIDAK di-lowercase (case-sensitive menurut aturan).
  const path = u.pathname.replace(/\/+$/, '');
  const key = host + path;
  return { ok: true, key, url: `${u.protocol}//${u.hostname}${u.pathname}` };
}

/** Hostname lowercase tanpa www., atau null kalau bukan URL valid. */
export function hostOf(u: string): string | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Domain besar/umum yang tidak pernah jadi kandidat (link keluar, popup, dsb). */
const IGNORED = [
  'google.com', 'google.co.id', 'googleapis.com', 'gstatic.com', 'googletagmanager.com', 'doubleclick.net',
  'youtube.com', 'youtu.be', 'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'whatsapp.com', 'wa.me', 't.me', 'telegram.org', 'telegram.me', 'line.me', 'apple.com', 'microsoft.com',
  'cloudflare.com', 'jsdelivr.net', 'wordpress.org', 'wordpress.com', 'gravatar.com', 'w3.org', 'schema.org',
  'livechatinc.com', 'tawk.to', 'histats.com', 'pinterest.com', 'linkedin.com', 'github.com', 'wikipedia.org',
];

export function isIgnoredHost(host: string): boolean {
  return IGNORED.some((d) => host === d || host.endsWith(`.${d}`));
}
