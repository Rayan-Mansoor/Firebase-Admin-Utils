// test/firestore/deleteCollection.test.js
//
// What deleteCollection accepts, and its backup check. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, missingFromBackup } = require("../../scripts/firestore/deleteCollection");

const cfg = (over) => ({ PATHS: [], COLLECTION: "", WHERE: [], DOC_IDS: [], INCLUDE_SUBCOLLECTIONS: true, DRY_RUN: true, ...over });

test("paths or a target, but something", () => {
  assert.doesNotThrow(() => validateConfig(cfg({ PATHS: ["app_users", "users/a"] })));
  assert.doesNotThrow(() => validateConfig(cfg({ COLLECTION: "logs", WHERE: [["at", "<", 5]] })));
  assert.throws(() => validateConfig(cfg({})), /Set PATHS/);
  assert.throws(() => validateConfig(cfg({ PATHS: ["users", "users/a"] })), /inside another/);
  assert.throws(() => validateConfig(cfg({ PATHS: ["a//b"] })), /empty segment/);
});

test("the backup check lists live docs the backup lacks", () => {
  const backedUp = new Set(["users/a", "users/a/posts/1"]);
  assert.deepEqual(missingFromBackup(["users/a", "users/a/posts/1"], backedUp), []);
  assert.deepEqual(missingFromBackup(["users/a", "users/b"], backedUp), ["users/b"]);
});
