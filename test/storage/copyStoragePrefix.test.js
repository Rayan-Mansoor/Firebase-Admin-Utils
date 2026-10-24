// test/storage/copyStoragePrefix.test.js
//
// How copyStoragePrefix plans its copies, against a fake bucket. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { destNameOf, planCopies, validateConfig } = require("../../scripts/storage/copyStoragePrefix");
const { normalizePrefix } = require("../../lib/storage");

const fakeBucket = (names) => ({
  name: "b",
  async getFiles({ prefix }) { return [names.filter((n) => n.startsWith(prefix)).map((name) => ({ name }))]; },
});
const cfg = (over) => ({ FROM_PREFIX: "a", TO_PREFIX: "b/", OVERWRITE_EXISTING: false, DRY_RUN: true, ...over });

test("objects keep their path below the folder; the placeholder is skipped", () => {
  assert.equal(normalizePrefix("a"), "a/");
  assert.equal(destNameOf("a/x/1.png", "a/", "b/"), "b/x/1.png");
  assert.equal(destNameOf("a/", "a/", "b/"), null);
});

test("existing destination objects are skipped unless overwriting", async () => {
  const bucket = fakeBucket(["a/1", "a/sub/2", "b/1", "ab/3"]);
  const plan = await planCopies(bucket, cfg());
  assert.deepEqual(plan.copies, [{ from: "a/sub/2", to: "b/sub/2" }]);
  assert.deepEqual(plan.existing, ["b/1"]);
  assert.equal((await planCopies(bucket, cfg({ OVERWRITE_EXISTING: true }))).copies.length, 2);
});

test("same, nested or slash-led prefixes are refused", () => {
  assert.throws(() => validateConfig(cfg({ TO_PREFIX: "a/" })), /must differ/);
  assert.throws(() => validateConfig(cfg({ TO_PREFIX: "a/inner" })), /nested/);
  assert.throws(() => validateConfig(cfg({ FROM_PREFIX: "/a" })), /leading slash/);
});

test("DELETE_SOURCE is a boolean like the other switches", () => {
  assert.doesNotThrow(() => validateConfig(cfg({ DELETE_SOURCE: true })));
  assert.throws(() => validateConfig(cfg({ DELETE_SOURCE: "yes" })), /DELETE_SOURCE must be boolean/);
});
