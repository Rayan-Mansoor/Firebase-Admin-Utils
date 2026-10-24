// test/firestore/alterFields.test.js
//
// How alterFields plans each document's update. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin").firestore;
const { planDoc, validateConfig, coerceValue } = require("../../scripts/firestore/alterFields");

const cfg = (ALTERS, ARRAY_ALTERS = []) => ({ COLLECTION: "users", WHERE: [], DOC_IDS: [], ALTERS, ARRAY_ALTERS, DRY_RUN: true });

test("set writes only when the value would change", () => {
  const c = cfg([{ op: "set", path: "status", value: "active" }]);
  assert.deepEqual(planDoc({ status: "old" }, c).update, { status: "active" });
  assert.deepEqual(planDoc({ status: "active" }, c).update, {});
});

test("onlyIf: missing, exists and equals (Firestore values compared by value)", () => {
  const at = new Timestamp(10, 0);
  assert.deepEqual(planDoc({ a: 1 }, cfg([{ op: "set", path: "a", value: 2, onlyIf: "missing" }])).update, {});
  assert.deepEqual(planDoc({}, cfg([{ op: "set", path: "a", value: 2, onlyIf: "exists" }])).update, {});
  const eq = cfg([{ op: "set", path: "flag", value: true, onlyIf: "equals", equalsValue: new Timestamp(10, 0) }]);
  assert.deepEqual(planDoc({ flag: at }, eq).update, { flag: true });
});

test("copy, replace and coerce", () => {
  const c = cfg([
    { op: "copy", from: "profile.name", to: "displayName" },
    { op: "replace", path: "displayName", pattern: "\\s+", replace: " " },
    { op: "coerce", path: "age", type: "int" },
  ]);
  assert.deepEqual(planDoc({ profile: { name: "Ada   L" }, age: "36.9" }, c).update, { displayName: "Ada L", age: 36 });
});

test("later rules see earlier rules' results", () => {
  const c = cfg([{ op: "set", path: "a", value: "x" }, { op: "copy", from: "a", to: "b" }]);
  assert.deepEqual(planDoc({}, c).update, { a: "x", b: "x" });
});

test("increment uses a sentinel, or a plain value from defaultIfMissing", () => {
  assert.equal(planDoc({ n: 1 }, cfg([{ op: "increment", path: "n", by: 2 }])).changes[0], "increment n by 2");
  assert.deepEqual(planDoc({}, cfg([{ op: "increment", path: "n", by: 2, defaultIfMissing: 0 }])).update, { n: 2 });
});

test("an outer and inner path in one update collapse into the outer one", () => {
  const c = cfg([{ op: "set", path: "a", value: { x: 1 } }, { op: "set", path: "a.y", value: 2 }]);
  assert.deepEqual(planDoc({}, c).update, { a: { x: 1, y: 2 } });
});

test("array alters change matching items only", () => {
  const c = cfg([], [{ arrayPath: "slots", itemFilter: { path: "on", op: "equals", value: true }, alters: [{ op: "set", path: "seen", value: 1 }] }]);
  const { update, changes } = planDoc({ slots: [{ on: true }, { on: false }, "x"] }, c);
  assert.deepEqual(update, { slots: [{ on: true, seen: 1 }, { on: false }, "x"] });
  assert.deepEqual(changes, ["slots[0]: set seen → 1"]);
  assert.deepEqual(planDoc({ slots: [{ on: true, seen: 1 }] }, c).update, {});
});

test("config mistakes are refused before anything runs", () => {
  assert.throws(() => validateConfig(cfg([])), /Nothing to do/);
  assert.throws(() => validateConfig(cfg([{ op: "rename", path: "a" }])), /unsupported op/);
  assert.throws(() => validateConfig(cfg([{ op: "set", path: "a" }])), /cannot be undefined/);
  assert.throws(() => validateConfig(cfg([], [{ arrayPath: "s", alters: [{ op: "increment", path: "n", by: 1 }] }])), /inside arrays/);
  assert.throws(() => validateConfig({ ...cfg([{ op: "set", path: "a", value: 1 }]), COLLECTION: "users/abc" }), /document path/);
});

test("coerceValue", () => {
  assert.equal(coerceValue("yes", "boolean"), true);
  assert.equal(coerceValue("nope", "boolean", null), null);
  assert.equal(coerceValue(-3.7, "int"), -3);
  assert.equal(coerceValue(undefined, "string", "d"), "d");
});

test("move renames a field in one update: the new path set, the old deleted", () => {
  const c = cfg([{ op: "move", from: "first_name", to: "name.first" }]);
  const { update, changes } = planDoc({ first_name: "Ada" }, c);
  assert.deepEqual(Object.keys(update), ["name.first", "first_name"]);
  assert.equal(update["name.first"], "Ada");
  assert.equal(update.first_name.methodName, "FieldValue.delete");
  assert.deepEqual(changes, ["move first_name → name.first"]);
  assert.deepEqual(planDoc({ name: { first: "Ada" } }, c).update, {}); // already moved
});

test("move inside array items renames the key in each item", () => {
  const c = cfg([], [{ arrayPath: "slots", alters: [{ op: "move", from: "t", to: "teacher" }] }]);
  assert.deepEqual(planDoc({ slots: [{ t: "A" }, { x: 1 }] }, c).update, { slots: [{ teacher: "A" }, { x: 1 }] });
});

test("move refuses paths nested in each other", () => {
  assert.throws(() => validateConfig(cfg([{ op: "move", from: "a", to: "a.b" }])), /nest/);
});
