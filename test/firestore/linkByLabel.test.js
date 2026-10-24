// test/firestore/linkByLabel.test.js
//
// How linkByLabel matches names and plans links. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalize, buildIndex, classify, planDoc, validateConfig } = require("../../scripts/firestore/linkByLabel");

const lookups = [
  { id: "t1", path: "teachers/t1", data: { name: "Anna Rossi", nick: "Annie" } },
  { id: "t2", path: "teachers/t2", data: { name: "Marco  Bianchi" } },
  { id: "t3", path: "teachers/t3", data: { name: "José Pérez" } },
  { id: "t4", path: "teachers/t4", data: { name: "Luca" } },
  { id: "t5", path: "teachers/t5", data: { name: "luca" } },
];
const index = buildIndex(lookups, ["name", "nick"]);
const cfg = (over) => ({ COLLECTION: "lessons", WHERE: [], DOC_IDS: [], ARRAY_PATH: null, LABEL_FIELD: "teacherName", ID_FIELD: "teacherId",
  LOOKUP_COLLECTION: "teachers", LOOKUP_LABEL_FIELDS: ["name"], WRITE: "id", OVERWRITE: false, DRY_RUN: true, ...over });
const byId = (d) => d.id;

test("names match ignoring accents, spacing and case, by any label field", () => {
  assert.equal(normalize("  José   PÉREZ "), "jose perez");
  assert.equal(classify("jose perez", index).doc.id, "t3");
  assert.equal(classify("marco bianchi", index).doc.id, "t2");
  assert.equal(classify("annie", index).doc.id, "t1");
});

test("several matches are ambiguous; none gives near misses; blank is blank", () => {
  assert.deepEqual(classify("LUCA", index).docs.map(byId), ["t4", "t5"]);
  const miss = classify("Anna", index);
  assert.equal(miss.status, "unmatched");
  assert.deepEqual(miss.suggestions, ["Anna Rossi"]);
  assert.equal(classify("  ", index).status, "blank");
});

test("a top-level name links once, and an existing link is kept", () => {
  assert.deepEqual(planDoc({ teacherName: "Anna Rossi" }, index, cfg(), byId).update, { teacherId: "t1" });
  assert.deepEqual(planDoc({ teacherName: "Anna Rossi", teacherId: "x" }, index, cfg(), byId).update, {});
  assert.deepEqual(planDoc({ teacherName: "Anna Rossi", teacherId: "x" }, index, cfg({ OVERWRITE: true }), byId).update, { teacherId: "t1" });
  assert.deepEqual(planDoc({ teacherName: "Luca" }, index, cfg(), byId).update, {});
});

test("array items link one by one, without changing the original", () => {
  const data = { slots: [{ teacherName: "Marco Bianchi" }, { teacherName: "Nobody" }, { room: 1 }] };
  const { update, results } = planDoc(data, index, cfg({ ARRAY_PATH: "slots", ID_FIELD: "teacher.id" }), byId);
  assert.deepEqual(update.slots, [{ teacherName: "Marco Bianchi", teacher: { id: "t2" } }, { teacherName: "Nobody" }, { room: 1 }]);
  assert.deepEqual(results.map((r) => r.status), ["exact", "unmatched"]);
  assert.equal(data.slots[0].teacher, undefined);
});

test("config mistakes are refused", () => {
  assert.throws(() => validateConfig(cfg({ ID_FIELD: "teacherName" })), /must differ/);
  assert.throws(() => validateConfig(cfg({ WRITE: "name" })), /WRITE/);
  assert.throws(() => validateConfig(cfg({ LOOKUP_LABEL_FIELDS: [] })), /at least one/);
});
