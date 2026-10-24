// test/firestore/findDuplicates.test.js
//
// How findDuplicates compares values and groups documents. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { keyOf, groupDuplicates, validateConfig } = require("../../scripts/firestore/findDuplicates");

const cfg = (over) => ({ COLLECTION: "users", WHERE: [], DOC_IDS: [], FIELDS: ["email"], IGNORE_CASE: true, IGNORE_SPACES: true, IGNORE_ACCENTS: false, INCLUDE_EMPTY: false, ...over });
const docs = [
  { path: "u/1", data: { email: "Ann@x.com", first: "José", last: "Pérez" } },
  { path: "u/2", data: { email: " ann@x.com ", first: "jose", last: "perez" } },
  { path: "u/3", data: { email: "bob@x.com", first: "Jose", last: "Perez" } },
  { path: "u/4", data: { email: "" } },
  { path: "u/5", data: {} },
];

test("strings compare after the chosen normalising", () => {
  assert.equal(keyOf(docs[0].data, cfg()), keyOf(docs[1].data, cfg()));
  assert.notEqual(keyOf(docs[0].data, cfg({ IGNORE_CASE: false })), keyOf(docs[1].data, cfg({ IGNORE_CASE: false })));
  assert.equal(keyOf({ n: 1 }, cfg({ FIELDS: ["n"] })), keyOf({ n: 1 }, cfg({ FIELDS: ["n"] })));
  assert.notEqual(keyOf({ n: 1 }, cfg({ FIELDS: ["n"] })), keyOf({ n: "1" }, cfg({ FIELDS: ["n"] })));
});

test("groups of two or more, empty values left out unless asked", () => {
  assert.deepEqual(groupDuplicates(docs, cfg()).map((g) => g.docs.map((d) => d.path)), [["u/1", "u/2"]]);
  const withBlank = [...docs, { path: "u/6", data: { email: "  " } }];
  assert.deepEqual(groupDuplicates(withBlank, cfg()).length, 1);
  assert.deepEqual(groupDuplicates(withBlank, cfg({ INCLUDE_EMPTY: true })).map((g) => g.docs.map((d) => d.path)), [["u/4", "u/6"], ["u/1", "u/2"]]);
});

test("several fields together, with accents ignored", () => {
  const c = cfg({ FIELDS: ["first", "last"], IGNORE_ACCENTS: true });
  assert.deepEqual(groupDuplicates(docs, c)[0].docs.map((d) => d.path), ["u/1", "u/2", "u/3"]);
});

test("FIELDS can't be empty", () => {
  assert.throws(() => validateConfig(cfg({ FIELDS: [] })), /at least one/);
});
