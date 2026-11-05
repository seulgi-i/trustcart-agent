// Minimal PDF 1.4 writer for the evidence export, so no PDF dependency is needed: Letter pages of monospaced text
// (Courier / Courier-Bold, so wrapping is exact), optional red or gray lines, automatic wrapping and pagination.
// The standard fonts carry no Unicode mapping, so text is reduced to printable ASCII.

export type PdfLine = { text: string; color?: 'black' | 'red' | 'gray'; bold?: boolean; size?: number };

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const COLORS = { black: '0 0 0', red: '0.8 0 0', gray: '0.4 0.4 0.4' } as const;
const REPLACEMENTS: Record<string, string> = { '×': 'x', '—': '-', '–': '-', '…': '...', '·': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '→': '->' };

export const pdfSafe = (text: string) => text.replace(/[^\x20-\x7e]/g, ch => REPLACEMENTS[ch] ?? (ch === '\t' ? ' ' : '?'));
const escape = (text: string) => text.replace(/[\\()]/g, ch => `\\${ch}`);

// Word wrap at spaces; a word longer than a line (a signature, a hash) is hard-broken.
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let rest = word;
    while (rest.length > width) {
      if (line) { out.push(line); line = ''; }
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
    else { out.push(line); line = rest; }
  }
  out.push(line);
  return out;
}

export function renderPdf(lines: PdfLine[], title = 'Document'): Buffer {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = PAGE_HEIGHT - MARGIN;
  const newPage = () => { pages.push(ops.join('\n')); ops = []; y = PAGE_HEIGHT - MARGIN; };
  for (const line of lines) {
    const size = line.size ?? 9;
    const leading = size * 1.3;
    // Courier glyphs are 0.6 em wide.
    const width = Math.floor((PAGE_WIDTH - 2 * MARGIN) / (size * 0.6));
    for (const chunk of wrap(pdfSafe(line.text), width)) {
      if (y - leading < MARGIN) newPage();
      y -= leading;
      ops.push(`BT /${line.bold ? 'F2' : 'F1'} ${size} Tf ${COLORS[line.color ?? 'black']} rg ${MARGIN} ${y.toFixed(2)} Td (${escape(chunk)}) Tj ET`);
    }
  }
  if (ops.length || !pages.length) newPage();

  // Objects: 1 catalog, 2 page tree, 3-4 fonts, 5 info, then a page and its content stream per page.
  const pageIds = pages.map((_, i) => 6 + i * 2);
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${escape(pdfSafe(title))}) /Producer (TrustCart) >>`,
  ];
  for (const [i, content] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  }

  // Everything is ASCII, so string length equals byte offset.
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
