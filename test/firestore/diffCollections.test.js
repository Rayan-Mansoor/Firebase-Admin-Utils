// test/firestore/diffCollections.test.js
//
// How diffCollections pairs documents and finds differing fields. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin").firestore;
const { relativePath, diffData, compare, validateConfig } = require("../../scripts/firestore/diffCollections");

test("documents pair by their path below the collection", () => {
  assert.equal(relativePath("users/a", "users", false), "a");
  assert.equal(relativePath("users/a/posts/1", "users", false), null);
  assert.equal(relativePath("users/a/posts/1", "users", true), "a/posts/1");
  assert.equal(relativePath("usersx/a", "users", true), null);
});

test("field differences go down into maps; lists and Firestore values compare whole", () => {
  const left = { a: 1, m: { x: 1, y: 2 }, l: [1, 2], at: new Timestamp(1, 0), gone: true, updatedAt: 1 };
  const right = { a: 1, m: { x: 1, y: 3 }, l: [1, 2, 3], at: new Timestamp(1, 0), added: "n", updatedAt: 2 };
  assert.deepEqual(diffData(left, right, ["updatedAt"]).map((d) => d.field), ["added", "gone", "l", "m.y"]);
  assert.deepEqual(diffData(left, right).find((d) => d.field === "gone"), { field: "gone", left: true, right: undefined });
});

test("compare splits same, changed and one-sided documents", () => {
  const r = compare(new Map([["a", { v: 1 }], ["b", { v: 1 }], ["c", {}]]), new Map([["a", { v: 1 }], ["b", { v: 2 }], ["d", {}]]));
  assert.equal(r.same, 1);
  assert.deepEqual(r.changed.map((c) => c.path), ["b"]);
  assert.deepEqual(r.onlyLeft, ["c"]);
  assert.deepEqual(r.onlyRight, ["d"]);
});

test("comparing a live collection with itself is refused", () => {
  assert.throws(() => validateConfig({ LEFT: { collection: "u" }, RIGHT: { collection: "u" }, IGNORE_FIELDS: [], INCLUDE_SUBCOLLECTIONS: false }), /same live/);
  assert.doesNotThrow(() => validateConfig({ LEFT: { collection: "u", backupFile: "b.ndjson" }, RIGHT: { collection: "u" }, IGNORE_FIELDS: [], INCLUDE_SUBCOLLECTIONS: false }));
});
