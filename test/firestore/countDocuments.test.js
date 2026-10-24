// test/firestore/countDocuments.test.js
//
// countDocuments' targets and table. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, formatTable } = require("../../scripts/firestore/countDocuments");

test("targets are queries; ids are refused", () => {
  assert.doesNotThrow(() => validateConfig({ TARGETS: [] }));
  assert.doesNotThrow(() => validateConfig({ TARGETS: [{ COLLECTION: "posts", USE_COLLECTION_GROUP: true }] }));
  assert.throws(() => validateConfig({ TARGETS: [{ COLLECTION: "users", DOC_IDS: ["a"] }] }), /DOC_IDS/);
  assert.throws(() => validateConfig({ TARGETS: [{ COLLECTION: "users/a" }] }), /document path/);
});

test("counts line up on the right", () => {
  assert.equal(formatTable([["'users'", 1200], ["'logs'", 5]]), "   'users'  1,200\n   'logs'       5");
});
