// test/firestore/backfillTtl.test.js
//
// How backfillTtl works out each expiry. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin").firestore;
const { planExpiry, millisOf, ttlCommand, validateConfig } = require("../../scripts/firestore/backfillTtl");

const DAY = 24 * 60 * 60 * 1000;
const cfg = (over) => ({
  COLLECTION: "receipts", USE_COLLECTION_GROUP: true, WHERE: [], DOC_IDS: [],
  SOURCE_FIELD: "createdAt", EXPIRY_FIELD: "expiresAt", TTL_DAYS: 10, WHEN_SOURCE_MISSING: "now", OVERWRITE: false, DRY_RUN: true, ...over,
});

test("expiry counts from the source field, in any date form", () => {
  const p = planExpiry({ createdAt: Timestamp.fromMillis(1000) }, cfg(), 0);
  assert.equal(p.expiresAt.toMillis(), 1000 + 10 * DAY);
  assert.equal(p.from, "source");
  assert.equal(millisOf("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(millisOf(new Date(5)), 5);
  assert.equal(millisOf("soon"), null);
});

test("no source: from now, or skipped", () => {
  assert.equal(planExpiry({}, cfg(), 500).expiresAt.toMillis(), 500 + 10 * DAY);
  assert.deepEqual(planExpiry({}, cfg({ WHEN_SOURCE_MISSING: "skip" }), 0), { skip: "no createdAt" });
});

test("a doc that has the field is left alone unless OVERWRITE", () => {
  assert.deepEqual(planExpiry({ expiresAt: 1 }, cfg(), 0), { skip: "has it" });
  assert.ok(planExpiry({ expiresAt: 1 }, cfg({ OVERWRITE: true }), 0).expiresAt);
});

test("the TTL command names the collection id and project", () => {
  assert.equal(ttlCommand(cfg({ COLLECTION: "users/a/receipts", USE_COLLECTION_GROUP: false }), "p"),
    "gcloud firestore fields ttls update expiresAt --collection-group=receipts --enable-ttl --project=p");
});

test("config mistakes are refused", () => {
  assert.throws(() => validateConfig(cfg({ EXPIRY_FIELD: "createdAt" })), /must differ/);
  assert.throws(() => validateConfig(cfg({ TTL_DAYS: 0 })), /positive/);
});
