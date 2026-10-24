// test/firestore/schemaTools.test.js
//
// The value typing and YAML output of inferSchema. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp, GeoPoint } = require("firebase-admin").firestore;
const infer = require("../../scripts/firestore/inferSchema");

test("inferSchema names Firestore value kinds", () => {
  assert.equal(infer.detectKind(new Timestamp(0, 0)), "timestamp");
  assert.equal(infer.detectKind(new GeoPoint(0, 0)), "geopoint");
  assert.equal(infer.detectKind("x"), "string");
  assert.equal(infer.detectKind(null), "null");
});

test("inferSchema spots maps keyed by ids rather than field names", () => {
  assert.equal(infer.looksLikeDynamicKeys(["2026-01-01", "2026-01-02"]), true);
  assert.equal(infer.looksLikeDynamicKeys(["firstName", "lastName"]), false);
});

test("YAML output is plain text", () => {
  assert.match(infer.toYAML({ a: 1, b: ["x"] }), /a: 1/);
});
