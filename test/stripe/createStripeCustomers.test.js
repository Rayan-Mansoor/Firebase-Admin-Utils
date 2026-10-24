// test/stripe/createStripeCustomers.test.js
//
// Who gets a customer, which keys are allowed, and what is sent to Stripe,
// against a fake Stripe client. No Firebase, no Stripe.

const test = require("node:test");
const assert = require("node:assert/strict");
const { keyMode, planUsers, createFor, validateConfig } = require("../../scripts/stripe/createStripeCustomers");

const cfg = (over) => ({ COLLECTION: "stripe_customers", CUSTOMER_ID_FIELD: "customer_id", SETUP_SECRET_FIELD: null, METADATA_UID_KEY: "firebase_uid", ALLOW_LIVE_MODE: false, DRY_RUN: true, ...over });

test("users with a customer document or no email are skipped", () => {
  const { create, skipped } = planUsers([{ uid: "a", email: "a@x" }, { uid: "b", email: "b@x" }, { uid: "c" }], new Set(["b"]));
  assert.deepEqual(create.map((u) => u.uid), ["a"]);
  assert.deepEqual(skipped, { hasCustomer: 1, noEmail: 1 });
});

test("key mode comes from the key's prefix", () => {
  assert.equal(keyMode("sk_test_123"), "test");
  assert.equal(keyMode("rk_live_123"), "live");
  assert.throws(() => keyMode("pk_test_123"), /secret key/);
  assert.throws(() => keyMode(undefined), /secret key/);
});

test("each customer carries the uid and an idempotency key; the setup secret is optional", async () => {
  const calls = [];
  const stripe = {
    customers: { async create(params, opts) { calls.push(["customer", params, opts]); return { id: "cus_1" }; } },
    setupIntents: { async create(params, opts) { calls.push(["setup", params, opts]); return { client_secret: "seti_secret" }; } },
  };
  const user = { uid: "u1", email: "a@x", displayName: "Ada" };
  assert.deepEqual(await createFor(stripe, user, cfg()), { customer_id: "cus_1" });
  assert.deepEqual(calls[0], ["customer", { email: "a@x", name: "Ada", metadata: { firebase_uid: "u1" } }, { idempotencyKey: "firebase-admin-utils-customer-u1" }]);
  assert.deepEqual(await createFor(stripe, user, cfg({ SETUP_SECRET_FIELD: "setup_secret" })), { customer_id: "cus_1", setup_secret: "seti_secret" });
  assert.deepEqual(calls.at(-1)[2], { idempotencyKey: "firebase-admin-utils-setup-u1" });
});

test("config is checked", () => {
  assert.throws(() => validateConfig(cfg({ COLLECTION: "a/b" })), /collection path/);
  assert.throws(() => validateConfig(cfg({ SETUP_SECRET_FIELD: "" })), /SETUP_SECRET_FIELD/);
});
