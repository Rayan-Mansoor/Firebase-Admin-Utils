// test/firestore/scrubFields.test.js
//
// How scrubFields plans each document's update. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { planDoc, validateConfig } = require("../../scripts/firestore/scrubFields");

const cfg = (over) => ({
  COLLECTION: "users", WHERE: [], DOC_IDS: [], FIELD_PATHS: [], ARRAY_CLEANERS: [], SUBCOLLECTIONS_TO_DELETE: [],
  HARD_DELETE: true, DRY_RUN: true, ...over,
});

test("hard delete scrubs present fields only", () => {
  const { update, changes } = planDoc({ a: 1, b: { c: 2 } }, cfg({ FIELD_PATHS: ["a", "b.c", "gone"] }));
  assert.deepEqual(Object.keys(update), ["a", "b.c"]);
  assert.equal(update.a.methodName, "FieldValue.delete");
  assert.deepEqual(changes, ["delete a", "delete b.c"]);
});

test("null mode skips fields already null, so reruns write nothing", () => {
  const c = cfg({ FIELD_PATHS: ["a", "b"], HARD_DELETE: false });
  assert.deepEqual(planDoc({ a: 1, b: null }, c).update, { a: null });
  assert.deepEqual(planDoc({ a: null, b: null }, c).update, {});
});

test("array cleaners strip keys from each object item", () => {
  const c = cfg({ ARRAY_CLEANERS: [{ arrayPath: "slots", deleteKeys: ["t", "x.y"] }] });
  assert.deepEqual(planDoc({ slots: [{ t: 1, k: 2 }, { x: { y: 1, z: 2 } }, 5] }, c).update, { slots: [{ k: 2 }, { x: { z: 2 } }, 5] });
  assert.deepEqual(planDoc({ slots: [{ k: 2 }] }, c).update, {});
});

test("config mistakes are refused", () => {
  assert.throws(() => validateConfig(cfg({})), /Nothing to do/);
  assert.throws(() => validateConfig(cfg({ SUBCOLLECTIONS_TO_DELETE: ["a/b"] })), /Invalid subcollection/);
  assert.throws(() => validateConfig(cfg({ ARRAY_CLEANERS: [{ arrayPath: "s", deleteKeys: [] }] })), /deleteKeys/);
});
