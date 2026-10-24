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
