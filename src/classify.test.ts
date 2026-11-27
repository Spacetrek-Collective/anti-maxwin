import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, type ClassifyInput } from './classify.ts';
import { prefilter } from './prefilter.ts';

const input: ClassifyInput = {
  url: 'https://contoh.xyz',
  finalUrl: 'https://www.tujuan.xyz/daftar',
  title: '',
  text: '',
  redirectChain: [],
  outlinkHosts: [],
  hiddenLinks: [],
  prefilter: prefilter(''),
  cloaked: false,
  similarTo: [],
};

test('parse JSON LLM + sanitasi', () => {
  const v = parseVerdict(
    '```json\n{"kategori":"JUDOL","confidence":1.7,"alasan":"slot","bukti":["DEPO 10K",3],"brands":["Gacor 88!","ab"],"mentioned_domains":["gacor88b.com"]}\n```',
    input,
  );
  assert.equal(v.label, 'judol');
  assert.equal(v.confidence, 1);
  assert.deepEqual(v.evidence, ['DEPO 10K']);
  assert.deepEqual(v.brands, ['gacor88']);
  assert.deepEqual(v.mentionedDomains, ['gacor88b.com']);
  assert.equal(v.finalDomain, 'tujuan.xyz');
});

test('kategori asing jadi tidak_jelas', () => {
  assert.equal(parseVerdict('{"kategori":"porn","confidence":0.9}', input).label, 'tidak_jelas');
});
