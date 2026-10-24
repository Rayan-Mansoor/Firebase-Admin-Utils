// test/storage/storageUsage.test.js
//
// How storageUsage groups files into folders and totals them. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { folderOf, tally, validateConfig } = require("../../scripts/storage/storageUsage");

test("files group by folder, DEPTH levels below the prefix", () => {
  assert.equal(folderOf("avatars/u1/a.png", "", 1), "avatars/");
  assert.equal(folderOf("avatars/u1/a.png", "", 2), "avatars/u1/");
  assert.equal(folderOf("avatars/u1/a.png", "", 5), "avatars/u1/");
  assert.equal(folderOf("avatars/u1/a.png", "avatars/", 1), "avatars/u1/");
  assert.equal(folderOf("readme.txt", "", 1), "(files here)");
});

test("totals come largest first", () => {
  const rows = tally([{ k: "a", size: 1 }, { k: "b", size: 5 }, { k: "a", size: 2 }].map((f) => ({ ...f })), (f) => f.k);
  assert.deepEqual(rows, [{ key: "b", count: 1, bytes: 5 }, { key: "a", count: 2, bytes: 3 }]);
});

test("depth and top are whole numbers", () => {
  assert.throws(() => validateConfig({ PREFIX: "", DEPTH: 0, TOP: 5 }), /DEPTH/);
  assert.doesNotThrow(() => validateConfig({ PREFIX: "a", DEPTH: 2, TOP: 5 }));
});
