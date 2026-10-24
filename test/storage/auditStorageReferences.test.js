// test/storage/auditStorageReferences.test.js
//
// How Storage references are recognised in documents. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { storageRefOf } = require("../../lib/storage");
const { valuesAt, allStrings, referencesIn, validateConfig } = require("../../scripts/storage/auditStorageReferences");

test("paths, gs:// URLs and download URLs name objects", () => {
  assert.deepEqual(storageRefOf("avatars/u1.png"), { bucket: null, name: "avatars/u1.png" });
  assert.deepEqual(storageRefOf("gs://b/a/x.pdf"), { bucket: "b", name: "a/x.pdf" });
  assert.deepEqual(storageRefOf("https://firebasestorage.googleapis.com/v0/b/b.appspot.com/o/a%2Fu%201.png?alt=media&token=t"), { bucket: "b.appspot.com", name: "a/u 1.png" });
  assert.deepEqual(storageRefOf("http://127.0.0.1:9199/v0/b/demo/o/x.png?alt=media"), { bucket: "demo", name: "x.png" });
  assert.deepEqual(storageRefOf("https://storage.googleapis.com/b/pub/c.txt"), { bucket: "b", name: "pub/c.txt" });
  assert.equal(storageRefOf("https://example.com/a.png"), null);
  assert.equal(storageRefOf("mailto:x@y"), null);
  assert.equal(storageRefOf(""), null);
});

test("field specs read plain fields, lists and array items", () => {
  const data = { a: "x", list: ["p", "q"], items: [{ url: "u1" }, { other: 1 }, { url: "u2" }] };
  assert.deepEqual(valuesAt(data, "a").map((v) => v.value), ["x"]);
  assert.deepEqual(valuesAt(data, "list").map((v) => v.value), ["p", "q"]);
  assert.deepEqual(valuesAt(data, "items[].url").map((v) => [v.where, v.value]), [["items[0].url", "u1"], ["items[2].url", "u2"]]);
  assert.deepEqual(allStrings({ a: { b: "1" }, c: ["2", { d: "3" }], n: 4 }).map((v) => v.where), ["a.b", "c[0]", "c[1].d"]);
});

test("with no fields, bare strings count only when they are an object's name", () => {
  const names = new Set(["avatars/u1.png"]);
  const data = { name: "Ada", avatar: "avatars/u1.png", gone: "gs://b/missing.png", other: "gs://elsewhere/x.png" };
  assert.deepEqual(referencesIn(data, null, "b", names).map((r) => r.name), ["avatars/u1.png", "missing.png"]);
  assert.deepEqual(referencesIn(data, ["name"], "b", names).map((r) => r.name), ["Ada"]); // named fields are trusted
});

test("sources are checked", () => {
  assert.throws(() => validateConfig({ PREFIXES: [], SOURCES: [] }), /at least one/);
  assert.throws(() => validateConfig({ PREFIXES: ["/x"], SOURCES: [{ COLLECTION: "u" }] }), /leading slash/);
  assert.throws(() => validateConfig({ PREFIXES: [], SOURCES: [{ COLLECTION: "u", FIELDS: "a" }] }), /FIELDS/);
});
