// test/messaging/cleanupFcmTokens.test.js
//
// How cleanupFcmTokens finds tokens, judges FCM's answers and plans writes,
// against a fake messaging client. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { tokensOf, isDead, writeFor, checkTokens, validateConfig } = require("../../scripts/messaging/cleanupFcmTokens");

const cfg = (over) => ({ COLLECTION: "users", WHERE: [], DOC_IDS: [], MODE: "array", TOKEN_FIELD: "fcmTokens", DOCS_ACTION: "delete-doc", DRY_RUN: true, ...over });
const snap = { ref: { path: "users/u" }, updateTime: "t" };

test("tokens come from a list field or a single field", () => {
  assert.deepEqual(tokensOf({ fcmTokens: ["a", "", 5, "b"] }, cfg()), ["a", "b"]);
  assert.deepEqual(tokensOf({ fcmTokens: "a" }, cfg()), []);
  assert.deepEqual(tokensOf({ token: "a" }, cfg({ MODE: "docs", TOKEN_FIELD: "token" })), ["a"]);
});

test("only unregistered or invalid tokens are dead", () => {
  assert.equal(isDead({ success: false, error: { code: "messaging/registration-token-not-registered" } }), true);
  assert.equal(isDead({ success: false, error: { code: "messaging/quota-exceeded" } }), false);
  assert.equal(isDead({ success: true }), false);
});

test("writes: pull from the list, delete the doc, or remove the field", () => {
  const pull = writeFor(snap, ["a"], cfg());
  assert.equal(pull.op, "update");
  assert.equal(pull.data.fcmTokens.methodName, "FieldValue.arrayRemove");
  assert.equal(writeFor(snap, ["a"], cfg({ MODE: "docs" })).op, "delete");
  assert.equal(writeFor(snap, ["a"], cfg({ MODE: "docs", DOCS_ACTION: "remove-field", TOKEN_FIELD: "token" })).data.token.methodName, "FieldValue.delete");
  assert.equal(writeFor(snap, [], cfg()), null);
});

test("checks go 500 at a time, validate only", async () => {
  const calls = [];
  const messaging = {
    async sendEach(messages, validateOnly) {
      calls.push([messages.length, validateOnly]);
      return { responses: messages.map((m) => (m.token.startsWith("dead") ? { success: false, error: { code: "messaging/registration-token-not-registered" } } : { success: true })) };
    },
  };
  const tokens = Array.from({ length: 600 }, (_, i) => (i % 3 ? `ok${i}` : `dead${i}`));
  const results = await checkTokens(messaging, tokens);
  assert.deepEqual(calls, [[500, true], [100, true]]);
  assert.equal([...results.values()].filter((r) => r.dead).length, 200);
});

test("config choices are checked", () => {
  assert.throws(() => validateConfig(cfg({ MODE: "map" })), /MODE/);
  assert.throws(() => validateConfig(cfg({ DOCS_ACTION: "archive" })), /DOCS_ACTION/);
});
