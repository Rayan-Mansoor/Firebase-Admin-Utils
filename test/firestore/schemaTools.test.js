// test/firestore/schemaTools.test.js
//
// The value typing and YAML output of inferSchema and lintCollectionSchema. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp, GeoPoint } = require("firebase-admin").firestore;
const infer = require("../../scripts/firestore/inferSchema");
const lint = require("../../scripts/firestore/lintCollectionSchema");

test("both tools name Firestore value kinds the same way", () => {
  for (const { detectKind } of [infer, lint]) {
    assert.equal(detectKind(new Timestamp(0, 0)), "timestamp");
    assert.equal(detectKind(new GeoPoint(0, 0)), "geopoint");
    assert.equal(detectKind("x"), "string");
    assert.equal(detectKind(null), "null");
  }
});

test("inferSchema spots maps keyed by ids rather than field names", () => {
  assert.equal(infer.looksLikeDynamicKeys(["2026-01-01", "2026-01-02"]), true);
  assert.equal(infer.looksLikeDynamicKeys(["firstName", "lastName"]), false);
});

test("lintCollectionSchema flattens nested fields and groups name variants", () => {
  assert.deepEqual(Object.keys(lint.flattenDoc({ a: { b: 1, at: new Timestamp(0, 0) }, c: [1] })), ["a.b", "a.at", "c"]);
  assert.equal(lint.normalizeFieldName("first_Name"), lint.normalizeFieldName("firstName"));
});

test("YAML output is plain text", () => {
  for (const { toYAML } of [infer, lint]) assert.match(toYAML({ a: 1, b: ["x"] }), /a: 1/);
});
