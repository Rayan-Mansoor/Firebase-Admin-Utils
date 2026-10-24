// scripts/stripe/createStripeCustomers.js
// Give every existing Auth user a Stripe customer, for apps that create one at
// sign-up and need to catch up the users who signed up before that (the shape the
// Stripe Firebase extension uses: stripe_customers/{uid}.customer_id).
//
// What it writes: for each user with an email and no customer document yet, a
// Stripe customer (metadata firebase_uid = the uid) and the document
// <COLLECTION>/<uid> { <CUSTOMER_ID_FIELD>: "cus_…" }. With SETUP_SECRET_FIELD,
// also a SetupIntent whose client secret goes in that field, for apps that start
// saving a card from it.
//
// Why it's safe: the dry run (the default) lists the users without calling Stripe.
// Each customer is created with an idempotency key from the uid, so a run that
// stops halfway can be run again without making a second customer (Stripe keeps
// the key for 24 hours); a user whose document exists is skipped, and documents
// are only created, never overwritten. A live-mode key is refused unless
// ALLOW_LIVE_MODE is on.
//
// Needs STRIPE_API_KEY in .env.
//
// Usage: set CONFIG below, run `node scripts/stripe/createStripeCustomers.js`, read
// the list, then set DRY_RUN = false and run it again.

const { isCollectionPath } = require("../../lib/backupFile");
const { listAllUsers, who } = require("../../lib/authUsers");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - COLLECTION: where each user's customer document lives, keyed by uid
 * - CUSTOMER_ID_FIELD: the field holding the Stripe customer id
 * - SETUP_SECRET_FIELD: null, or a field for a new SetupIntent's client secret
 * - METADATA_UID_KEY: the Stripe customer metadata key that holds the uid
 * - ALLOW_LIVE_MODE: allow a live-mode key (real customers in your Stripe account)
 * - DRY_RUN: list without calling Stripe or writing
 * - LOG_SAMPLES: how many users to print
 */
const CONFIG = {
  COLLECTION: "stripe_customers",
  CUSTOMER_ID_FIELD: "customer_id",
  SETUP_SECRET_FIELD: null,
  METADATA_UID_KEY: "firebase_uid",
  ALLOW_LIVE_MODE: false,
  DRY_RUN: true,
  LOG_SAMPLES: 25,
};

function validateConfig(cfg = CONFIG) {
  if (typeof cfg.COLLECTION !== "string" || cfg.COLLECTION.split("/").some((s) => !s) || !isCollectionPath(cfg.COLLECTION)) {
    throw new Error("CONFIG.COLLECTION must be a collection path.");
  }
  for (const k of ["CUSTOMER_ID_FIELD", "METADATA_UID_KEY"]) {
    if (typeof cfg[k] !== "string" || !cfg[k]) throw new Error(`CONFIG.${k} must be a non-empty string.`);
  }
  if (cfg.SETUP_SECRET_FIELD !== null && (typeof cfg.SETUP_SECRET_FIELD !== "string" || !cfg.SETUP_SECRET_FIELD)) {
    throw new Error("CONFIG.SETUP_SECRET_FIELD must be a field name or null.");
  }
  for (const k of ["ALLOW_LIVE_MODE", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** "live" or "test", from a secret or restricted key's prefix; throws on anything else. */
function keyMode(key) {
  const m = /^(sk|rk)_(live|test)_/.exec(key || "");
  if (!m) throw new Error("STRIPE_API_KEY must be a Stripe secret key (sk_test_… or sk_live_…).");
  return m[2];
}

/** The users to create customers for, and why the rest are skipped. */
function planUsers(users, existingUids) {
  const create = [];
  const skipped = { hasCustomer: 0, noEmail: 0 };
  for (const u of users) {
    if (existingUids.has(u.uid)) skipped.hasCustomer++;
    else if (!u.email) skipped.noEmail++;
    else create.push(u);
  }
  return { create, skipped };
}

/** Create one user's Stripe customer (and SetupIntent): the document data to store. */
async function createFor(stripe, user, cfg) {
  const customer = await stripe.customers.create(
    { email: user.email, name: user.displayName || undefined, metadata: { [cfg.METADATA_UID_KEY]: user.uid } },
    { idempotencyKey: `firebase-admin-utils-customer-${user.uid}` },
  );
  const data = { [cfg.CUSTOMER_ID_FIELD]: customer.id };
  if (cfg.SETUP_SECRET_FIELD) {
    const intent = await stripe.setupIntents.create({ customer: customer.id }, { idempotencyKey: `firebase-admin-utils-setup-${user.uid}` });
    data[cfg.SETUP_SECRET_FIELD] = intent.client_secret;
  }
  return data;
}

async function main() {
  const { auth, db } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Stripe customers for Auth users without a ${CONFIG.COLLECTION} document`);
  banner(CONFIG.DRY_RUN);

  const users = [];
  for await (const u of listAllUsers(auth)) users.push(u);
  const refs = await db.collection(CONFIG.COLLECTION).listDocuments();
  const existing = new Set();
  for (let i = 0; i < refs.length; i += 300) for (const s of await db.getAll(...refs.slice(i, i + 300))) if (s.exists) existing.add(s.id);
  const { create, skipped } = planUsers(users, existing);
  console.log(`📊 ${users.length} users: ${create.length} need a customer; ${skipped.hasCustomer} have one; ${skipped.noEmail} have no email (skipped).`);
  for (const u of create.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   ➕ ${who(u)}`);
  if (create.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${create.length - CONFIG.LOG_SAMPLES} more.`);

  if (CONFIG.DRY_RUN || !create.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete (no Stripe calls)" : "Nothing to create"}.`);
    return;
  }

  const key = process.env.STRIPE_API_KEY;
  const mode = keyMode(key);
  if (mode === "live" && !CONFIG.ALLOW_LIVE_MODE) throw new Error("STRIPE_API_KEY is a live-mode key. Set ALLOW_LIVE_MODE = true to create real customers.");
  console.log(`💳 Stripe ${mode} mode.`);
  const stripe = require("stripe")(key);

  const writes = [];
  for (const u of create) {
    try {
      writes.push({ op: "create", path: `${CONFIG.COLLECTION}/${u.uid}`, data: await createFor(stripe, u, CONFIG) });
    } catch (err) {
      console.error(`   ❌ ${who(u)}: ${err.message}`);
    }
  }
  const { done, failures } = await applyWrites(db, writes);
  printFailures(failures);
  console.log(`\n✅ Created ${writes.length} Stripe customers; stored ${done} documents.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, keyMode, planUsers, createFor };
