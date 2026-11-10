/** RFC 4180-style CSV parser with delimiter detection (comma, semicolon, tab) and size limits. */
export function parseCsv(text: string, limits: { rows?: number; columns?: number } = {}): string[][] {
  const maxRows = limits.rows ?? 100_000, maxColumns = limits.columns ?? 300;
  const input = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(input);
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false, touched = false;
  const endField = () => { row.push(field); field = ''; touched = true; closed = false; };
  const endRow = () => {
    if (touched || field) { endField(); rows.push(row); } else rows.push([]);
    row = []; touched = false; closed = false;
    if (rows.length > maxRows + 1) throw new Error('This file has more than ' + maxRows.toLocaleString('en-US') + ' rows.');
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += c;
      continue;
    }
    if (closed && c !== delimiter && c !== '\r' && c !== '\n') throw new Error('This file has characters after a closing quote. Check the quoting.');
    if (c === '"' && field === '') { quoted = true; touched = true; }
    else if (c === delimiter) endField();
    else if (c === '\r' || c === '\n') { if (c === '\r' && input[i + 1] === '\n') i++; endRow(); }
    else field += c;
  }
  if (quoted) throw new Error('This file has an unclosed quote.');
  if (touched || field) endRow();
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  if (rows.some(r => r.length > maxColumns)) throw new Error('This file has more than ' + maxColumns + ' columns.');
  return rows;
}
function detectDelimiter(input: string): string {
  const candidates = [',', ';', '\t'];
  const linesWith: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false, seen = new Set<string>(), inspected = 0, content = false;
  const endLine = () => { if (content) { inspected++; for (const d of seen) linesWith[d]++; } seen = new Set(); content = false; };
  for (let i = 0; i < input.length && inspected < 10; i++) {
    const c = input[i];
    if (c === '"') { quoted = !quoted; content = true; }
    else if (!quoted && (c === '\n' || c === '\r')) endLine();
    else { if (c.trim() !== '' || c === '\t') content = true; if (!quoted && candidates.includes(c)) seen.add(c); }
  }
  endLine();
  return candidates.reduce((best, d) => linesWith[d] > linesWith[best] ? d : best, ',');
}
