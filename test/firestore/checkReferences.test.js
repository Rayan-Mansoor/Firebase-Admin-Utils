// test/firestore/checkReferences.test.js
//
// What checkReferences reads as a reference. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { targetsOfValue, referencesOf, validateConfig } = require("../../scripts/firestore/checkReferences");

const rule = { field: "userId", collection: "users" };

test("ids, paths, references and lists all name documents", () => {
  assert.deepEqual(targetsOfValue("u1", rule), [{ target: "users/u1", raw: "u1" }]);
  assert.deepEqual(targetsOfValue("teams/t/members/m", rule), [{ target: "teams/t/members/m", raw: "teams/t/members/m" }]);
  assert.deepEqual(targetsOfValue(["a", "b"], rule).map((t) => t.target), ["users/a", "users/b"]);
  assert.deepEqual(targetsOfValue(null, rule), []);
});

test("values that can't name a document are reported as invalid", () => {
  assert.equal(targetsOfValue(5, rule)[0].invalid, "a number, not an id");
  assert.equal(targetsOfValue("users/u1/posts", rule)[0].invalid, "not a document path");
});

test("arrayPath reads the field from each item", () => {
  const refs = referencesOf({ lines: [{ userId: "a" }, { other: 1 }, { userId: ["b"] }] }, { ...rule, arrayPath: "lines" });
  assert.deepEqual(refs.map((r) => [r.where, r.target]), [["lines[0].userId", "users/a"], ["lines[2].userId", "users/b"]]);
});

test("rules are checked", () => {
  const cfg = (REFERENCES) => ({ COLLECTION: "orders", WHERE: [], DOC_IDS: [], REFERENCES });
  assert.throws(() => validateConfig(cfg([])), /at least one/);
  assert.throws(() => validateConfig(cfg([{ field: "x", collection: "users/u" }])), /collection path/);
});

test("DocumentReferences name their own path", () => {
  const { DocumentReference } = require("firebase-admin").firestore;
  const fake = Object.create(DocumentReference.prototype, { path: { value: "users/z" } });
  assert.deepEqual(targetsOfValue(fake, rule), [{ target: "users/z", raw: "ref(users/z)" }]);
});
