// test/lib/shared.test.js
//
// Field paths, value equality, target checks and value previews. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp, GeoPoint, FieldValue } = require("firebase-admin").firestore;
const { getByPath, setByPath, unsetByPath, pathsOverlap, sameValue } = require("../../lib/fieldPaths");
const { validateTarget, describeTarget } = require("../../lib/targets");
const { preview } = require("../../lib/run");

test("dotted paths read, write and remove through maps", () => {
  const o = { a: { b: 1 }, s: "x" };
  assert.equal(getByPath(o, "a.b"), 1);
  assert.equal(getByPath(o, "s.length.x"), undefined);
  setByPath(o, "s.t", 2); // a non-map in the way becomes a map
  assert.deepEqual(o.s, { t: 2 });
  unsetByPath(o, "a.b");
  assert.deepEqual(o.a, {});
  assert.equal(pathsOverlap("a", "a.b"), true);
  assert.equal(pathsOverlap("a", "ab"), false);
});

test("sameValue compares Firestore values by value", () => {
  assert.ok(sameValue(new Timestamp(1, 2), new Timestamp(1, 2)));
  assert.ok(!sameValue(new Timestamp(1, 2), new Timestamp(1, 3)));
  assert.ok(sameValue({ g: new GeoPoint(1, 2), l: [1, NaN] }, { g: new GeoPoint(1, 2), l: [1, NaN] }));
  assert.ok(!sameValue({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(sameValue(Buffer.from("a"), Buffer.from("a")));
  assert.ok(!sameValue([1], { 0: 1 }));
});

test("targets: collection paths, groups, ids and filters are checked", () => {
  assert.doesNotThrow(() => validateTarget({ COLLECTION: "users/a/posts", WHERE: [["x", "==", 1]] }));
  assert.throws(() => validateTarget({ COLLECTION: "users/a" }), /document path/);
  assert.throws(() => validateTarget({ COLLECTION: "a/b/c", USE_COLLECTION_GROUP: true }), /collection id/);
  assert.throws(() => validateTarget({ COLLECTION: "posts", USE_COLLECTION_GROUP: true, DOC_IDS: ["x"] }), /not supported/);
  assert.throws(() => validateTarget({ COLLECTION: "users", WHERE: [["x", "=="]] }), /Invalid WHERE/);
  assert.equal(describeTarget({ COLLECTION: "users", WHERE: [["age", ">", 3]] }), "'users' where age > 3");
});

test("preview shows Firestore values and sentinels readably", () => {
  assert.equal(preview({ at: new Timestamp(0, 0) }), '{"at":"Timestamp(1970-01-01T00:00:00.000Z)"}');
  assert.equal(preview(FieldValue.serverTimestamp()), '"serverTimestamp"');
  assert.equal(preview(FieldValue.delete()), '"delete"');
  assert.equal(preview("x".repeat(200), 10).length, 10);
});
