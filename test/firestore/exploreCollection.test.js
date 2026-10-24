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
