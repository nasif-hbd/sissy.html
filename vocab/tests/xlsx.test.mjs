import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readWorkbook } from '../scripts/xlsx.mjs';

/*
 * The reader parses the .xlsx container itself rather than depending on a
 * spreadsheet library, so these build real workbooks — a zip with the parts
 * Excel writes — and read them back.
 */

/** Minimal zip writer: `store` for the raw path, deflate for the other. */
function zip(files, { deflate = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(zlib.crc32 ? zlib.crc32(raw) : 0, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    local.push(head, nameBytes, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);

    offset += head.length + nameBytes.length + body.length;
  }

  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBytes, end]);
}

const sheetXml = (rows) =>
  `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

function workbook(sheets, extra = {}, opts) {
  const files = {
    'xl/workbook.xml': `<workbook><sheets>${sheets
      .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}</Relationships>`,
    ...Object.fromEntries(sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml])),
    ...extra,
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-')), 'book.xlsx');
  fs.writeFileSync(file, zip(files, opts));
  return file;
}

test('reads inline strings, in sheet order', () => {
  const file = workbook([{
    name: 'SAT',
    xml: sheetXml(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>word</t></is></c>'
      + '<c r="B1" t="inlineStr"><is><t>part_of_speech</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>abate</t></is></c>'
      + '<c r="B2" t="inlineStr"><is><t>verb</t></is></c></row>'),
  }, { name: 'IELTS', xml: sheetXml('') }]);

  const wb = readWorkbook(file);
  assert.deepEqual(wb.sheets, ['SAT', 'IELTS']);
  assert.deepEqual([...wb.records('SAT')], [{ word: 'abate', part_of_speech: 'verb' }]);
});

test('a gap in the row leaves an empty cell, not a shifted one', () => {
  // The third column is simply absent — a value must not slide left into it.
  const file = workbook([{
    name: 'S',
    xml: sheetXml(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c>'
      + '<c r="B1" t="inlineStr"><is><t>b</t></is></c>'
      + '<c r="C1" t="inlineStr"><is><t>c</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>one</t></is></c>'
      + '<c r="C2" t="inlineStr"><is><t>three</t></is></c></row>'),
  }]);
  assert.deepEqual([...readWorkbook(file).records('S')], [{ a: 'one', b: '', c: 'three' }]);
});

test('reads the shared-string table and decodes entities', () => {
  const file = workbook([{
    name: 'S',
    xml: sheetXml(
      '<row r="1"><c r="A1" t="s"><v>0</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>1</v></c></row>'
      + '<row r="3"><c r="A3" t="s"><v>2</v></c></row>'),
  }], {
    'xl/sharedStrings.xml':
      '<sst><si><t>word</t></si>'
      + '<si><t>rock &amp; roll</t></si>'
      + '<si><r><t>run</t></r><r><t>-on</t></r></si></sst>',
  });
  assert.deepEqual([...readWorkbook(file).records('S')], [{ word: 'rock & roll' }, { word: 'run-on' }]);
});

test('non-Latin text survives numeric character references', () => {
  const file = workbook([{
    name: 'S',
    xml: sheetXml(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>bangla_meaning</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>&#2453;&#2469;&#2472;</t></is></c></row>'),
  }]);
  assert.deepEqual([...readWorkbook(file).records('S')], [{ bangla_meaning: 'কথন' }]);
});

test('columns past Z land in the right place', () => {
  const file = workbook([{
    name: 'S',
    xml: sheetXml(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c>'
      + '<c r="AB1" t="inlineStr"><is><t>far</t></is></c></row>'),
  }]);
  const [row] = [...readWorkbook(file).rows('S')];
  assert.equal(row.length, 28);        // A … AB
  assert.equal(row[0], 'first');
  assert.equal(row[27], 'far');
});

test('reads deflated entries as well as stored ones', () => {
  const xml = sheetXml(
    '<row r="1"><c r="A1" t="inlineStr"><is><t>word</t></is></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>abate</t></is></c></row>');
  const file = workbook([{ name: 'S', xml }], {}, { deflate: true });
  assert.deepEqual([...readWorkbook(file).records('S')], [{ word: 'abate' }]);
});

test('a missing sheet is an error, not silence', () => {
  const wb = readWorkbook(workbook([{ name: 'S', xml: sheetXml('') }]));
  assert.throws(() => [...wb.rows('NOPE')], /no sheet named NOPE/);
});
