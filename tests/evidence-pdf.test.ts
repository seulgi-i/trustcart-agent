import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfSafe, renderPdf } from '../src/server/pdf';

// Checks the structure a PDF reader relies on: header, every xref offset pointing at its object, startxref pointing
// at the xref table, page count, and escaped text.
function parse(pdf: Buffer) {
  const text = pdf.toString('latin1');
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
  const xref = text.slice(startxref);
  const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  return { text, startxref, offsets };
}

test('minimal PDF: valid header, xref offsets and pagination', () => {
  const lines = Array.from({ length: 150 }, (_, i) => ({ text: `Line ${i} (with parentheses) and a backslash \\`, color: i % 2 ? 'red' as const : undefined }));
  const pdf = renderPdf([{ text: 'Title', bold: true, size: 14 }, ...lines], 'Evidence');
  const { text, startxref, offsets } = parse(pdf);
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  offsets.forEach((offset, i) => assert.equal(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)?.[1]);
  assert.ok(pages >= 2, `expected pagination, got ${pages} page(s)`);
  assert.equal(offsets.length, 5 + pages * 2);
  assert.ok(text.includes('(Line 7 \\(with parentheses\\) and a backslash \\\\) Tj'));
  assert.ok(text.includes('0.8 0 0 rg'));
  // Stream lengths match their content.
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    assert.equal(text.slice(start + Number(m[1]), start + Number(m[1]) + '\nendstream'.length), '\nendstream');
  }
});

test('long words are hard-wrapped and non-ASCII is reduced to ASCII', () => {
  const sig = 'A'.repeat(300);
  const { text } = parse(renderPdf([{ text: `signature=${sig}` }]));
  const shown = [...text.matchAll(/\(([^()]*)\) Tj/g)].map(m => m[1]);
  assert.equal(shown.join('').replace('signature=', ''), sig);
  assert.ok(shown.every(s => s.length <= 94));
  assert.equal(pdfSafe('2 × Lantern — “ok” 한'), '2 x Lantern - "ok" ?');
  assert.ok(!/[^\x00-\x7f]/.test(renderPdf([{ text: 'Café ✓' }]).toString('latin1')));
});
