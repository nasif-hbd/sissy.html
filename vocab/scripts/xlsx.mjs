/**
 * A small read-only .xlsx reader.
 *
 * The build has no dependencies and is meant to stay that way, so rather than
 * pulling in a spreadsheet library this reads the parts of the format the
 * source workbook actually uses: the zip container, the sheet list, and cell
 * text held either inline or in the shared-string table.
 *
 * Not a general XLSX implementation — no formulas, styles, dates or formats.
 * Every cell comes back as the string it displays.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

/* ── the zip container ─────────────────────────────────────────────────────
   Only the central directory is trusted for offsets; the local header is read
   just far enough to know where the compressed bytes start, because its name
   and extra-field lengths can differ from the central copy. */
function openZip(file) {
  const buf = fs.readFileSync(file);

  // End of central directory: fixed 22 bytes plus a comment of up to 64 KB.
  let end = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file: no end-of-central-directory record');

  let count = buf.readUInt16LE(end + 10);
  let dir = buf.readUInt32LE(end + 16);

  // Zip64: a >4 GB or >65535-entry archive parks the real values elsewhere.
  if (dir === 0xffffffff || count === 0xffff) {
    const loc = end - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip64 locator missing');
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    count = Number(buf.readBigUInt64LE(z64 + 32));
    dir = Number(buf.readBigUInt64LE(z64 + 48));
  }

  const files = new Map();
  let p = dir;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('central directory entry corrupt');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, compressed, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const read = (name) => {
    const e = files.get(name) || files.get(name.replace(/^\//, ''));
    if (!e) return null;
    const nameLen = buf.readUInt16LE(e.offset + 26);
    const extraLen = buf.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nameLen + extraLen;
    const bytes = buf.subarray(start, start + e.compressed);
    if (e.method === 0) return bytes;
    if (e.method === 8) return zlib.inflateRawSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
    throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
  };

  return { names: [...files.keys()], read };
}

// ── XML text ──────────────────────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e] ?? m;
  const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return Number.isFinite(code) ? String.fromCodePoint(code) : m;
});

/** All <t> text inside a fragment, joined — a run-formatted cell has several. */
const textOf = (xml) => {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) out += m[1] || '';
  return decode(out);
};

/** "BC" → 54. Column letters are the only reliable cell position. */
function columnOf(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * Open a workbook. `sheets` lists the sheet names in workbook order;
 * `rows(name)` yields each row as an array of cell strings.
 */
export function readWorkbook(file) {
  const zip = openZip(file);
  const wb = zip.read('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new Error('not an xlsx file: xl/workbook.xml missing');

  const rels = new Map();
  for (const m of (zip.read('xl/_rels/workbook.xml.rels')?.toString('utf8') || '')
    .matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    if (name) sheets.push({ name: decode(name), path: rels.get(rid) });
  }

  // Loaded once, and only if some sheet actually references it.
  let shared = null;
  const sharedStrings = () => {
    if (shared) return shared;
    shared = [];
    const xml = zip.read('xl/sharedStrings.xml')?.toString('utf8');
    if (xml) for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
    return shared;
  };

  function* rows(sheetName) {
    const sheet = sheets.find((s) => s.name === sheetName);
    if (!sheet) throw new Error(`no sheet named ${sheetName}`);
    const xml = zip.read(sheet.path)?.toString('utf8');
    if (!xml) throw new Error(`sheet part missing: ${sheet.path}`);

    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      const body = rowMatch[1] || '';
      const cells = [];
      let next = 0;
      for (const cell of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const inner = cell[2] || '';
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const at = ref ? columnOf(ref) : next;
        next = at + 1;
        while (cells.length < at) cells.push('');

        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        let value = '';
        if (type === 's') {
          const i = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]);
          value = sharedStrings()[i] ?? '';
        } else if (type === 'inlineStr' || type === 'str') {
          value = textOf(inner) || decode(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || '');
        } else {
          value = decode(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || '');
        }
        cells.push(value);
      }
      yield cells;
    }
  }

  /** Rows as objects keyed by the header row, which every sheet here has. */
  function* records(sheetName) {
    let header = null;
    for (const row of rows(sheetName)) {
      if (!header) { header = row.map((h) => h.trim()); continue; }
      const out = {};
      for (let i = 0; i < header.length; i++) if (header[i]) out[header[i]] = row[i] || '';
      yield out;
    }
  }

  return { sheets: sheets.map((s) => s.name), rows, records };
}
