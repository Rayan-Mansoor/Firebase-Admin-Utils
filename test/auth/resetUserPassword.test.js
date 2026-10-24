// test/auth/resetUserPassword.test.js
//
// What resetUserPassword accepts, and how users are looked up. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig } = require("../../scripts/auth/resetUserPassword");
const { resolveUsers, who } = require("../../lib/authUsers");

const cfg = (over) => ({ USER_IDS: ["u1"], EMAILS: [], TEMP_PASSWORD: "secret1", REVOKE_SESSIONS: false, FIRESTORE_FIELD: null, DRY_RUN: true, ...over });

test("users, a long enough password and a well-formed field are required", () => {
  assert.doesNotThrow(() => validateConfig(cfg({ FIRESTORE_FIELD: { collection: "users", field: "tempPassword" } })));
  assert.throws(() => validateConfig(cfg({ USER_IDS: [] })), /USER_IDS or EMAILS/);
  assert.throws(() => validateConfig(cfg({ EMAILS: [""] })), /invalid entry/);
  assert.throws(() => validateConfig(cfg({ TEMP_PASSWORD: "12345" })), /at least 6/);
  assert.throws(() => validateConfig(cfg({ FIRESTORE_FIELD: { collection: "users" } })), /FIRESTORE_FIELD/);
});

test("lookups go 100 at a time, list each user once and say who wasn't found", async () => {
  const calls = [];
  const fakeAuth = {
    async getUsers(ids) {
      calls.push(ids.length);
      return {
        users: ids.filter((i) => i.uid !== "gone").map((i) => ({ uid: i.uid || "u-" + i.email, email: i.email })),
        notFound: ids.filter((i) => i.uid === "gone"),
      };
    },
  };
  const uids = Array.from({ length: 150 }, (_, i) => `u${i}`).concat("gone", "u0");
  const { users, missing } = await resolveUsers(fakeAuth, { uids, emails: ["a@x.com"] });
  assert.deepEqual(calls, [100, 53]);
  assert.equal(users.length, 151);
  assert.deepEqual(missing, ["gone"]);
  assert.equal(who({ uid: "u", email: "a@x.com" }), "u (a@x.com)");
});
