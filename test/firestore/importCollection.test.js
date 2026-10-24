// test/firestore/importCollection.test.js
//
// Reading CSV and JSON into documents, and planning the import. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv } = require("../../lib/csv");
const { convertCell, rowFromCsv, recordsOf, planRecords, flatten } = require("../../scripts/firestore/importCollection");

const cfg = (over) => ({ COLLECTION: "products", ID_FIELD: "id", KEEP_ID_FIELD: false, MODE: "create", TYPES: {}, EMPTY_CELLS: "omit", DRY_RUN: true, ...over });

test("CSV: quotes, commas and line breaks inside fields, CRLF and a BOM", () => {
  const rows = parseCsv('﻿id,name,note\r\n1,"Smith, Ann","said ""hi""\nthen left"\r\n2,Bob,\n');
  assert.deepEqual(rows, [
    { id: "1", name: "Smith, Ann", note: 'said "hi"\nthen left' },
    { id: "2", name: "Bob", note: "" },
  ]);
  assert.throws(() => parseCsv("a,b\n1\n"), /row 2 has 1 fields/);
  assert.throws(() => parseCsv('a\n"open\n'), /inside a quoted field/);
  assert.throws(() => parseCsv("a,a\n1,2\n"), /names "a" twice/);
  assert.deepEqual(parseCsv(""), []);
});

test("cells convert as TYPES says, and refuse what isn't that type", () => {
  assert.equal(convertCell(" 4.5 ", "number", "c"), 4.5);
  assert.equal(convertCell("Yes", "boolean", "c"), true);
  assert.equal(convertCell("2026-01-01T00:00:00Z", "timestamp", "c").toDate().toISOString(), "2026-01-01T00:00:00.000Z");
  assert.deepEqual(convertCell('{"a":[1]}', "json", "c"), { a: [1] });
  assert.equal(convertCell(" keep ", undefined, "c"), " keep ");
  assert.throws(() => convertCell("4.5", "int", "row 2, qty"), /row 2, qty: "4.5" is not a whole number/);
  assert.throws(() => convertCell("maybe", "boolean", "c"), /true\/false/);
});

test("a CSV row nests dotted headers and handles empty cells", () => {
  const row = { id: "p1", "price.amount": "9", "price.currency": "EUR", tag: "" };
  assert.deepEqual(rowFromCsv(row, cfg({ TYPES: { "price.amount": "int" } }), 2), { id: "p1", price: { amount: 9, currency: "EUR" } });
  assert.deepEqual(rowFromCsv(row, cfg({ EMPTY_CELLS: "null" }), 2).tag, null);
});

test("JSON: arrays or { id: object }, with backup-format type tags", () => {
  const fakeDb = { doc: (p) => ({ path: p }) };
  const recs = recordsOf(JSON.stringify({ a: { at: { $fst: "timestamp", seconds: 1, nanoseconds: 0 }, owner: { $fst: "reference", path: "users/u" } } }), ".json", cfg(), fakeDb);
  assert.equal(recs[0].idKey, "a");
  assert.equal(recs[0].data.at.seconds, 1);
  assert.equal(recs[0].data.owner.path, "users/u");
  assert.equal(recordsOf("[{\"x\":1}]", ".json", cfg(), fakeDb)[0].data.x, 1);
  assert.throws(() => recordsOf("5", ".json", cfg(), fakeDb), /array of objects/);
  assert.throws(() => recordsOf("", ".xml", cfg(), fakeDb), /\.json or \.csv/);
});

test("planning takes ids from ID_FIELD and stops on bad records", () => {
  const { docs, problems } = planRecords([
    { data: { id: " p1 ", name: "A" } },
    { data: { name: "no id" } },
    { data: { id: "p1" } },
    { data: { id: "a/b" } },
    { data: "x" },
  ], cfg());
  assert.deepEqual(docs, [{ id: "p1", data: { name: "A" } }]);
  assert.deepEqual(problems, ["record 2: no id", 'record 3: id "p1" appears twice', 'record 4: "a/b" can\'t be a document id', "record 5: not an object"]);
  assert.deepEqual(planRecords([{ data: { id: "p", n: 1 } }], cfg({ KEEP_ID_FIELD: true })).docs[0].data, { id: "p", n: 1 });
  assert.deepEqual(planRecords([{ data: { n: 1 } }], cfg({ ID_FIELD: null })).docs, [{ id: null, data: { n: 1 } }]);
});

test("merge updates only the fields given", () => {
  assert.deepEqual(flatten({ a: { b: 1, c: { d: 2 } }, e: [1], f: {} }), { "a.b": 1, "a.c.d": 2, e: [1], f: {} });
});
