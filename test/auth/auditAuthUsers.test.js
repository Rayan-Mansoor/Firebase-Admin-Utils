// test/auth/auditAuthUsers.test.js
//
// How auditAuthUsers pairs accounts with documents. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { audit } = require("../../scripts/auth/auditAuthUsers");
const { isAnonymous } = require("../../lib/authUsers");

const accounts = [
  { uid: "a", email: "Ann@x.com", anonymous: false },
  { uid: "b", email: "bob@x.com", anonymous: false },
  { uid: "c", email: "cy@x.com", anonymous: false },
  { uid: "anon", email: undefined, anonymous: true },
];
const docs = [
  { uid: "a", path: "users/a", email: " ann@x.com" },
  { uid: "b", path: "users/b", email: "robert@x.com" },
  { uid: "z", path: "users/z", email: "z@x.com" },
];

test("accounts without documents, and documents without accounts", () => {
  const r = audit(accounts, docs, { INCLUDE_ANONYMOUS: false, EMAIL_FIELD: null });
  assert.deepEqual(r.noDocument, [{ uid: "c", email: "cy@x.com" }]);
  assert.deepEqual(r.noAccount, [{ uid: "z", path: "users/z" }]);
  assert.equal(r.anonymousSkipped, 1);
  assert.deepEqual(r.emailMismatch, []);
});

test("anonymous accounts count when asked; emails compare case and space blind", () => {
  const r = audit(accounts, docs, { INCLUDE_ANONYMOUS: true, EMAIL_FIELD: "email" });
  assert.deepEqual(r.noDocument.map((a) => a.uid), ["c", "anon"]);
  assert.deepEqual(r.emailMismatch, [{ uid: "b", accountEmail: "bob@x.com", documentEmail: "robert@x.com" }]);
});

test("an account with no email, phone or provider is anonymous", () => {
  assert.equal(isAnonymous({ providerData: [] }), true);
  assert.equal(isAnonymous({ providerData: [{ providerId: "google.com" }] }), false);
  assert.equal(isAnonymous({ providerData: [], phoneNumber: "+1" }), false);
});
