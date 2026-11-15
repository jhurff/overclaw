'use strict';
// CodeQL js/incomplete-multi-character-sanitization: views/brain-browse.ejs safeSnippet
// must keep only <mark> highlights and neutralize every other tag, including ones
// that a strip-once filter would reassemble.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSafeSnippet() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'brain-browse.ejs'), 'utf8');
  const start = src.indexOf('function safeSnippet(html)');
  assert.ok(start > 0, 'safeSnippet not found');
  const end = src.indexOf('\n    }\n', start);
  const ctx = {};
  vm.runInNewContext(src.slice(start, end + 6) + '\nthis.safeSnippet = safeSnippet;', ctx);
  return ctx.safeSnippet;
}

test('safeSnippet keeps mark highlights and escapes everything else', () => {
  const safe = loadSafeSnippet();
  assert.equal(safe('set <mark>env</mark> vars'), 'set <mark>env</mark> vars');
  assert.equal(safe('a <MARK>b</MARK> c'), 'a <mark>b</mark> c');
  assert.equal(safe('&lt;script&gt; <mark>x</mark> &amp; &#39; &#x27;'), '&lt;script&gt; <mark>x</mark> &amp; &#39; &#x27;');
  assert.equal(safe(''), '');
  assert.equal(safe(null), '');
  const hostile = [
    '<script>alert(1)</script>',
    '<scr<script>ipt>alert(1)</script>',
    '<<img src=x onerror=alert(1)>img src=x onerror=alert(1)>',
    '<mark onclick=alert(1)>x</mark>',
    '<marker>x</marker>',
    '<svg/onload=alert(1)>',
    '<img src=x onerror=alert(1)',
    '"><img src=x onerror=alert(1)>',
    '& <mark>ok</mark> &bogus',
  ];
  for (const h of hostile) {
    const out = safe(h);
    const tags = out.match(/<[^>]*>?/g) || [];
    assert.ok(tags.every(t => t === '<mark>' || t === '</mark>'), h + ' => ' + out);
    assert.equal(/["']/.test(out), false, h + ' => ' + out);
  }
  assert.equal(safe('& <mark>ok</mark> &bogus'), '&amp; <mark>ok</mark> &amp;bogus');
});
