// test/auth/setCustomClaims.test.js
//
// How setCustomClaims works out each user's claims. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { nextClaims, validateConfig } = require("../../scripts/auth/setCustomClaims");

const cfg = (over) => ({ USER_IDS: ["u"], EMAILS: [], SET: {}, REMOVE: [], REPLACE_ALL: false, REVOKE_SESSIONS: false, DRY_RUN: true, ...over });

test("SET merges, REMOVE takes away, REPLACE_ALL starts over", () => {
  const current = { role: "user", plan: "pro" };
  assert.deepEqual(nextClaims(current, cfg({ SET: { role: "admin" } })).claims, { role: "admin", plan: "pro" });
  assert.deepEqual(nextClaims(current, cfg({ REMOVE: ["plan"] })).claims, { role: "user" });
  assert.deepEqual(nextClaims(current, cfg({ SET: { beta: true }, REPLACE_ALL: true })).claims, { beta: true });
  assert.deepEqual(nextClaims(undefined, cfg({ SET: { a: 1 } })).claims, { a: 1 });
});

test("claims over 1,000 bytes are refused", () => {
  assert.match(nextClaims({}, cfg({ SET: { big: "x".repeat(1000) } })).error, /Firebase allows 1000/);
});

test("reserved names, contradictions and empty changes are refused", () => {
  assert.throws(() => validateConfig(cfg({ SET: { sub: "x" } })), /reserves/);
  assert.throws(() => validateConfig(cfg({ SET: { a: 1 }, REMOVE: ["a"] })), /both SET and REMOVE/);
  assert.throws(() => validateConfig(cfg({})), /Nothing to do/);
  assert.doesNotThrow(() => validateConfig(cfg({ REPLACE_ALL: true }))); // clears every claim
});
