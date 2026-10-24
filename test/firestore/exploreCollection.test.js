// test/firestore/exploreCollection.test.js
//
// How exploreCollection prints Firestore values. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp, GeoPoint } = require("firebase-admin").firestore;
const { serialize } = require("../../scripts/firestore/exploreCollection");

test("Firestore values print as readable JSON", () => {
  assert.deepEqual(serialize({
    at: new Timestamp(0, 0),
    where: new GeoPoint(1, 2),
    bytes: Buffer.from("hi"),
    list: [1, null, undefined],
    nested: { ok: true },
  }), {
    at: "1970-01-01T00:00:00.000Z",
    where: { _type: "geopoint", latitude: 1, longitude: 2 },
    bytes: { _type: "bytes", base64: "aGk=" },
    list: [1, null, null],
    nested: { ok: true },
  });
});

test("CSV: maps become dotted columns, the rest JSON text, quoted when needed", () => {
  const { csvRowOf, csvOf } = require("../../scripts/firestore/exploreCollection");
  const doc = { _id: "a", _path: "p/a", price: { amount: 9 }, tags: ["x", "y"], at: { _type: "geopoint", latitude: 1, longitude: 2 }, _subcollections: { s: [] } };
  assert.deepEqual(csvRowOf(doc), { _id: "a", _path: "p/a", "price.amount": 9, tags: '["x","y"]', at: '{"_type":"geopoint","latitude":1,"longitude":2}' });
  assert.equal(csvOf([{ _id: "a", _path: "p/a", note: 'He said "hi", twice' }, { _id: "b", _path: "p/b", extra: 1 }]),
    '_id,_path,note,extra\na,p/a,"He said ""hi"", twice",\nb,p/b,,1\n');
});

test("CSV written by the explorer reads back with the importer's parser", () => {
  const { parseCsv } = require("../../lib/csv");
  const { csvOf } = require("../../scripts/firestore/exploreCollection");
  const rows = parseCsv(csvOf([{ _id: "a", _path: "p/a", note: "line1\nline2", name: " padded " }]));
  assert.deepEqual(rows, [{ _id: "a", _path: "p/a", note: "line1\nline2", name: " padded " }]);
});
