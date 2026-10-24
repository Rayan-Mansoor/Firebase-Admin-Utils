// test/lib/backupFile.test.js
//
// The backup format's encoding and path rules. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp, GeoPoint } = require("firebase-admin").firestore;
const {
  TAG, encodeValue, decodeValue, assertValidPath, isCollectionPath, pathIsUnder, defaultBackupFilename, formatBytes,
} = require("../../lib/backupFile");
const { mapWithConcurrency } = require("../../lib/concurrency");

const fakeDb = { doc: (p) => ({ path: p, fake: true }) };

test("Firestore types survive JSON and come back as themselves", () => {
  const data = {
    at: new Timestamp(1700000000, 123456789),
    where: new GeoPoint(44.49, 11.34),
    bytes: Buffer.from("hi"),
    nums: [1, NaN, Infinity, -Infinity],
    nested: { s: "x", n: null, b: true },
  };
  const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(data, "d"))), "d", fakeDb);
  assert.ok(back.at.isEqual(data.at));
  assert.ok(back.where.isEqual(data.where));
  assert.deepEqual(back.bytes, data.bytes);
  assert.ok(Number.isNaN(back.nums[1]));
  assert.deepEqual(back.nums.slice(2), [Infinity, -Infinity]);
  assert.deepEqual(back.nested, data.nested);
});

test("a map that holds the tag key is escaped, not mistaken for a type", () => {
  const data = { [TAG]: "timestamp", other: 1 };
  const enc = encodeValue(data, "d");
  assert.equal(enc[TAG], "map");
  assert.deepEqual(decodeValue(enc, "d"), data);
});

test("references decode through the given db and refuse without one", () => {
  const enc = { [TAG]: "reference", path: "users/a" };
  assert.deepEqual(decodeValue(enc, "d", fakeDb), { path: "users/a", fake: true });
  assert.throws(() => decodeValue(enc, "d"), /needs a Firestore instance/);
});

test("unknown values and tags are refused", () => {
  assert.throws(() => encodeValue(new Map(), "d"), /Cannot encode/);
  assert.throws(() => decodeValue({ [TAG]: "future" }, "d"), /Unknown/);
});

test("paths: collection or document, and segment-aware nesting", () => {
  assert.equal(isCollectionPath("users"), true);
  assert.equal(isCollectionPath("users/a"), false);
  assert.equal(isCollectionPath("users/a/attempts"), true);
  assert.equal(pathIsUnder("users/a/x/1", "users/a"), true);
  assert.equal(pathIsUnder("users/ab", "users/a"), false);
  assert.throws(() => assertValidPath("users//a"), /empty segment/);
  assert.throws(() => assertValidPath(""), /non-empty/);
});

test("file names and sizes", () => {
  assert.match(defaultBackupFilename("p"), /^firestore-p-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.ndjson$/);
  assert.match(defaultBackupFilename("p", { full: false, prefix: "pre" }), /^pre-p-partial-/);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
});

test("mapWithConcurrency keeps order and the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapWithConcurrency([5, 1, 3, 2], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20]);
  assert.equal(peak, 2);
});
