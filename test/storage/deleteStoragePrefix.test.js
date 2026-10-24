// test/storage/deleteStoragePrefix.test.js
//
// What deleteStoragePrefix accepts as a list of files. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { namesFromJson, validateConfig } = require("../../scripts/storage/deleteStoragePrefix");

test("a names file is a list, or an audit's orphans", () => {
  assert.deepEqual(namesFromJson(["a/1.png", "a/1.png", "b/2"]), ["a/1.png", "b/2"]);
  assert.deepEqual(namesFromJson({ orphans: [{ name: "x.png", size: 3 }], broken: [] }), ["x.png"]);
  assert.throws(() => namesFromJson({ files: [] }), /orphans/);
  assert.throws(() => namesFromJson(["ok", "/bad"]), /entry 2/);
});

test("folders or a names file, not both, never the whole bucket", () => {
  const cfg = (over) => ({ PREFIXES: [], NAMES_FILE: "", DOWNLOAD_FIRST: false, DRY_RUN: true, ...over });
  assert.throws(() => validateConfig(cfg({})), /Set PREFIXES or NAMES_FILE/);
  assert.throws(() => validateConfig(cfg({ PREFIXES: ["a/"], NAMES_FILE: "x.json" })), /not both/);
  assert.throws(() => validateConfig(cfg({ PREFIXES: [""] })), /non-empty folder/);
  assert.doesNotThrow(() => validateConfig(cfg({ PREFIXES: ["tmp"] })));
});
