// test/firestore/copyCollection.test.js
//
// Where copies land, and which configs are refused. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { destPathOf, validateConfig } = require("../../scripts/firestore/copyCollection");

const cfg = (over) => ({ SOURCE_COLLECTION: "users", DESTINATION_COLLECTION: "people", INCLUDE_SUBCOLLECTIONS: true, IS_DESTRUCTIVE: false, DRY_RUN: true, ...over });

test("a copy keeps its path below the collection", () => {
  assert.equal(destPathOf("users/a", "users", "people"), "people/a");
  assert.equal(destPathOf("users/a/posts/p", "users", "archive/2026/people"), "archive/2026/people/a/posts/p");
  assert.throws(() => destPathOf("usersx/a", "users", "people"), /not under/);
});

test("same, nested or document paths are refused", () => {
  assert.doesNotThrow(() => validateConfig(cfg({})));
  assert.throws(() => validateConfig(cfg({ DESTINATION_COLLECTION: "users" })), /must differ/);
  assert.throws(() => validateConfig(cfg({ DESTINATION_COLLECTION: "users/a/copies" })), /nested/);
  assert.throws(() => validateConfig(cfg({ SOURCE_COLLECTION: "users/a" })), /document path/);
});

test("TRANSFORM reshapes, drops undefined fields, or skips with null", () => {
  const { transformCopy } = require("../../scripts/firestore/copyCollection");
  const copy = { from: "users/a", to: "people/a", data: { x: 1, old: 2 } };
  const t = (data, { id, destPath }) => (data.x === 0 ? null : { ...data, id, destPath, old: undefined });
  assert.deepEqual(transformCopy(copy, t).data, { x: 1, id: "a", destPath: "people/a" });
  assert.equal(transformCopy({ ...copy, data: { x: 0 } }, t), null);
  assert.equal(transformCopy(copy, null), copy);
  assert.throws(() => transformCopy(copy, () => 5), /return an object or null/);
});
