// test/auth/deleteAuthUsers.test.js
//
// Which accounts deleteAuthUsers' filters pick. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { matchesFilter, validateConfig } = require("../../scripts/auth/deleteAuthUsers");

const NOW = Date.parse("2026-10-24T00:00:00Z");
const anon = { providerData: [], metadata: { creationTime: "2025-01-01T00:00:00Z" } };
const active = { email: "a@x.com", providerData: [{}], metadata: { creationTime: "2025-01-01T00:00:00Z", lastSignInTime: "2026-10-01T00:00:00Z" } };
const stale = { email: "s@x.com", providerData: [{}], disabled: true, metadata: { creationTime: "2024-01-01T00:00:00Z", lastSignInTime: "2024-06-01T00:00:00Z" } };

test("each filter, and all set filters together", () => {
  assert.equal(matchesFilter(anon, { ANONYMOUS: true }, NOW), true);
  assert.equal(matchesFilter(active, { ANONYMOUS: true }, NOW), false);
  assert.equal(matchesFilter(stale, { INACTIVE_DAYS: 365 }, NOW), true);
  assert.equal(matchesFilter(active, { INACTIVE_DAYS: 365 }, NOW), false);
  assert.equal(matchesFilter(anon, { ANONYMOUS: true, INACTIVE_DAYS: 365 }, NOW), true); // never signed in: counts from creation
  assert.equal(matchesFilter(stale, { DISABLED: true, ANONYMOUS: true }, NOW), false);
  assert.equal(matchesFilter(stale, { DISABLED: true, INACTIVE_DAYS: 30 }, NOW), true);
});

test("a list or a filter is required", () => {
  const cfg = (over) => ({ USER_IDS: [], EMAILS: [], FILTER: { ANONYMOUS: false, INACTIVE_DAYS: null, DISABLED: false }, DRY_RUN: true, ...over });
  assert.throws(() => validateConfig(cfg({})), /at least one FILTER/);
  assert.doesNotThrow(() => validateConfig(cfg({ EMAILS: ["a@x.com"] })));
  assert.doesNotThrow(() => validateConfig(cfg({ FILTER: { ANONYMOUS: true } })));
  assert.throws(() => validateConfig(cfg({ FILTER: { INACTIVE_DAYS: -1 } })), /positive/);
});
