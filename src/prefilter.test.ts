import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefilter, worthTriage } from './prefilter.ts';

test('teks samaran tetap terdeteksi', () => {
  for (const s of ['SLOT GACOR', 's1ot g4c0r', 's l o t  g a c o r', 'Ｓｌｏｔ Ｇａｃｏｒ', 'sl​ot gacor', 'm4xw1n', 't0gel']) {
    const r = prefilter(s);
    assert.equal(r.top, 'judol', s);
    assert.ok(worthTriage(r), s);
  }
});

test('pinjol dan scam', () => {
  assert.equal(prefilter('Pinjaman tanpa jaminan, cukup KTP, langsung cair!').top, 'pinjol');
  assert.equal(prefilter('Akun anda diblokir. Masukkan OTP untuk verifikasi akun anda').top, 'scam');
});

test('halaman biasa tidak lolos', () => {
  const r = prefilter('Selamat datang di website resmi Dinas Pendidikan. Jadwal penerimaan siswa baru.');
  assert.equal(r.score, 0);
  assert.equal(worthTriage(r), false);
  // satu kata lemah saja belum cukup
  assert.equal(worthTriage(prefilter('Promo deposit tabungan berjangka')), false);
});

test('tidak cocok di tengah kata', () => {
  assert.equal(prefilter('pemilotan zebrabet').hits.judol!.score, 0);
});
