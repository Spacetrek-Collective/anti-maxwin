import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from './normalize.ts';

const key = (s: string) => {
  const r = normalize(s);
  return r.ok ? r.key : `ERR:${r.reason}`;
};

test('aturan dedup panitia', () => {
  assert.equal(key('https://www.Contoh.COM/'), 'contoh.com');
  assert.equal(key('http://contoh.com?ref=1#top'), 'contoh.com');
  assert.equal(key('contoh.com/Slot/Gacor/'), 'contoh.com/Slot/Gacor');
  assert.notEqual(key('contoh.com/A'), key('contoh.com/a'));
  assert.equal(key('blog.contoh.id'), 'blog.contoh.id');
  assert.notEqual(key('blog.contoh.id'), key('contoh.id'));
});

test('input yang ditolak', () => {
  assert.match(key('ftp://contoh.com'), /^ERR/);
  assert.match(key('https://contoh.com:8080'), /^ERR/);
  assert.match(key('https://u:p@contoh.com'), /^ERR/);
  assert.match(key('http://1.2.3.4'), /^ERR/);
  assert.match(key('http://localhost/x'), /^ERR/);
  assert.match(key('https://contoh.com/' + 'a'.repeat(300)), /^ERR/);
});
