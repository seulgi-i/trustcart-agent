import { readFileSync } from 'node:fs';
import { scanUntrusted } from '../src/domain/scanner';
const items = JSON.parse(readFileSync('tests/fixtures/redteam-1.json', 'utf8'));
let miss = 0;
for (const p of items) { const r = scanUntrusted(p.description); if (!r.flagged) miss++; console.log(p.id, r.flagged ? 'CAUGHT ' + r.hits.join(',') : 'BYPASS'); }
console.log(`bypass ${miss}/${items.length}`);
