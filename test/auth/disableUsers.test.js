// test/auth/disableUsers.test.js
//
// Which accounts disableUsers changes. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { toChange, validateConfig } = require("../../scripts/auth/disableUsers");

test("only accounts not already in the wanted state change", () => {
  const users = [{ uid: "a", disabled: false }, { uid: "b", disabled: true }, { uid: "c" }];
  assert.deepEqual(toChange(users, true).map((u) => u.uid), ["a", "c"]);
  assert.deepEqual(toChange(users, false).map((u) => u.uid), ["b"]);
});

test("users are required, flags are booleans", () => {
  const cfg = (over) => ({ USER_IDS: ["a"], EMAILS: [], DISABLE: true, REVOKE_SESSIONS: true, DRY_RUN: true, ...over });
  assert.throws(() => validateConfig(cfg({ USER_IDS: [] })), /USER_IDS or EMAILS/);
  assert.throws(() => validateConfig(cfg({ DISABLE: "yes" })), /DISABLE must be boolean/);
});
