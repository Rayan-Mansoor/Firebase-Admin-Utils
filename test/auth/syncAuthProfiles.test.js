// test/auth/syncAuthProfiles.test.js
//
// How syncAuthProfiles builds each profile and its changes. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { profileFrom, profileChanges, validateConfig } = require("../../scripts/auth/syncAuthProfiles");

test("values come from one field or several joined; empty ones are left out", () => {
  const mapping = { displayName: ["p.first", "p.last"], photoURL: "photo", phoneNumber: "phone" };
  assert.deepEqual(profileFrom({ p: { first: " Ada ", last: "Lovelace" }, photo: "https://x/a.png", phone: "" }, mapping),
    { displayName: "Ada Lovelace", photoURL: "https://x/a.png" });
  assert.deepEqual(profileFrom({ p: { first: "Ada" } }, mapping), { displayName: "Ada" });
  assert.deepEqual(profileFrom({ p: { first: 5 } }, mapping), {});
});

test("only values that differ from Auth are sent", () => {
  const user = { displayName: "Ada Lovelace", photoURL: undefined };
  assert.deepEqual(profileChanges(user, { displayName: "Ada Lovelace", photoURL: "u" }), { photoURL: "u" });
  assert.deepEqual(profileChanges(user, { displayName: "Ada Lovelace" }), {});
});

test("MAPPING keys are Auth profile keys", () => {
  const cfg = (MAPPING) => ({ COLLECTION: "users", WHERE: [], DOC_IDS: [], UID_FIELD: null, MAPPING, DRY_RUN: true });
  assert.throws(() => validateConfig(cfg({})), /at least one/);
  assert.throws(() => validateConfig(cfg({ email: "e" })), /Auth profiles have/);
  assert.throws(() => validateConfig(cfg({ displayName: [] })), /field path/);
});
