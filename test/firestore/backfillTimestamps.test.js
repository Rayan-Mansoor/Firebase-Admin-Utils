// test/firestore/backfillTimestamps.test.js
//
// Which timestamps backfillTimestamps fills, and in what form. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin").firestore;
const { planTimestamps, validateConfig } = require("../../scripts/firestore/backfillTimestamps");

const times = { createTime: Timestamp.fromMillis(1000), updateTime: Timestamp.fromMillis(2000) };
const cfg = (over) => ({ COLLECTION: "users", WHERE: [], DOC_IDS: [], CREATED_FIELD: "createdAt", UPDATED_FIELD: "updatedAt", FORMAT: "timestamp", DRY_RUN: true, ...over });

test("missing fields get Firestore's times; set ones are kept", () => {
  const u = planTimestamps({}, times, cfg());
  assert.ok(u.createdAt.isEqual(times.createTime));
  assert.ok(u.updatedAt.isEqual(times.updateTime));
  assert.deepEqual(Object.keys(planTimestamps({ createdAt: "x" }, times, cfg())), ["updatedAt"]);
  assert.deepEqual(planTimestamps({ createdAt: null, updatedAt: 0 }, times, cfg()), {});
});

test("formats and a field turned off", () => {
  assert.deepEqual(planTimestamps({}, times, cfg({ FORMAT: "iso", UPDATED_FIELD: null })), { createdAt: "1970-01-01T00:00:01.000Z" });
  assert.deepEqual(planTimestamps({}, times, cfg({ FORMAT: "millis", CREATED_FIELD: "meta.created" })), { "meta.created": 1000, updatedAt: 2000 });
});

test("config mistakes are refused", () => {
  assert.throws(() => validateConfig(cfg({ CREATED_FIELD: null, UPDATED_FIELD: null })), /Nothing to do/);
  assert.throws(() => validateConfig(cfg({ FORMAT: "date" })), /FORMAT/);
});
