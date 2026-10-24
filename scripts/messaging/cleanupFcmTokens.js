// scripts/messaging/cleanupFcmTokens.js
// Remove Cloud Messaging tokens that no longer work: apps uninstalled, tokens
// rotated or expired. Sends to them fail, slow every broadcast down and skew
// delivery counts.
//
// Each token is checked with FCM's validate-only send: Google checks it and
// delivers nothing. Only tokens FCM reports as unregistered or invalid are
// removed; any other error (quota, network) leaves the token alone.
//
// Tokens live in one of two shapes:
//   MODE "array"  a list of tokens in a field of each document (users/{uid}.fcmTokens)
//   MODE "docs"   one token per document (users/{uid}/devices/{id}.token)
//
// What it writes: in "array" mode, the dead tokens pulled out of the list; in
// "docs" mode, each dead document deleted (or just its token field removed).
//
// Why it's safe: the dry run (the default) checks the tokens too (validate-only,
// nothing is delivered) and lists the dead ones. The armed run saves every
// document it changes or deletes into backups/ first, and each write is refused
// if the document changed after it was read.
//
// Usage: set CONFIG below, run `node scripts/messaging/cleanupFcmTokens.js`, read
// the list, then set DRY_RUN = false and run it again.

const { FieldValue } = require("firebase-admin").firestore;
const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath } = require("../../lib/fieldPaths");
const { saveBeforeState } = require("../../lib/beforeState");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, runMain } = require("../../lib/run");

const SEND_BATCH = 500; // sendEach() takes at most 500 messages
const DEAD_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: the documents holding tokens (see lib/targets.js);
 *   for "docs" mode usually a collection group such as "devices"
 * - MODE: "array" | "docs"
 * - TOKEN_FIELD: the field with the token list ("array") or the single token ("docs")
 * - DOCS_ACTION: "docs" mode only: "delete-doc" | "remove-field"
 * - DRY_RUN: check and list without writing
 * - LOG_SAMPLES: how many dead tokens to print
 */
const CONFIG = {
  COLLECTION: "users",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],

  MODE: "array",
  TOKEN_FIELD: "fcmTokens",
  DOCS_ACTION: "delete-doc",

  DRY_RUN: true,
  LOG_SAMPLES: 25,
};

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  if (!["array", "docs"].includes(cfg.MODE)) throw new Error('CONFIG.MODE must be "array" or "docs".');
  if (typeof cfg.TOKEN_FIELD !== "string" || !cfg.TOKEN_FIELD) throw new Error("CONFIG.TOKEN_FIELD must be a field path.");
  if (!["delete-doc", "remove-field"].includes(cfg.DOCS_ACTION)) throw new Error('CONFIG.DOCS_ACTION must be "delete-doc" or "remove-field".');
  if (typeof cfg.DRY_RUN !== "boolean") throw new Error("CONFIG.DRY_RUN must be boolean.");
}

/** The tokens a document holds under this config. */
function tokensOf(data, cfg) {
  const v = getByPath(data, cfg.TOKEN_FIELD);
  const list = cfg.MODE === "array" ? (Array.isArray(v) ? v : []) : [v];
  return list.filter((t) => typeof t === "string" && t.trim());
}

/** Whether a validate-only send's result means the token is dead. */
const isDead = (response) => !response.success && DEAD_CODES.has(response.error?.code);

/** The write for one document, given its dead tokens; null when nothing is dead. */
function writeFor(snap, deadTokens, cfg) {
  if (!deadTokens.length) return null;
  if (cfg.MODE === "array") {
    return { op: "update", path: snap.ref.path, data: { [cfg.TOKEN_FIELD]: FieldValue.arrayRemove(...deadTokens) }, lastUpdateTime: snap.updateTime };
  }
  return cfg.DOCS_ACTION === "delete-doc"
    ? { op: "delete", path: snap.ref.path, lastUpdateTime: snap.updateTime }
    : { op: "update", path: snap.ref.path, data: { [cfg.TOKEN_FIELD]: FieldValue.delete() }, lastUpdateTime: snap.updateTime };
}

/** Check tokens with validate-only sends: Map token → { dead, code }. */
async function checkTokens(messaging, tokens) {
  const results = new Map();
  for (let i = 0; i < tokens.length; i += SEND_BATCH) {
    const batch = tokens.slice(i, i + SEND_BATCH);
    const res = await messaging.sendEach(batch.map((token) => ({ token, data: { check: "1" } })), true); // true = validate only
    res.responses.forEach((r, j) => results.set(batch[j], { dead: isDead(r), code: r.error?.code || null }));
  }
  return results;
}

async function main() {
  const { admin, db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Dead FCM tokens in ${CONFIG.MODE === "array" ? `the ${CONFIG.TOKEN_FIELD} lists` : `the ${CONFIG.TOKEN_FIELD} field`} of ${describeTarget(CONFIG)}`);
  banner(CONFIG.DRY_RUN);

  const docs = [];
  for await (const snap of targetDocs(db, CONFIG)) {
    const tokens = tokensOf(snap.data(), CONFIG);
    if (tokens.length) docs.push({ snap, tokens });
  }
  const unique = [...new Set(docs.flatMap((d) => d.tokens))];
  console.log(`📊 ${docs.length} documents hold ${unique.length} distinct tokens; checking them with FCM (validate only, nothing is delivered)…`);
  const results = await checkTokens(admin.messaging(), unique);
  const otherErrors = [...results.values()].filter((r) => !r.dead && r.code);
  const plans = docs.map((d) => ({ snap: d.snap, dead: d.tokens.filter((t) => results.get(t)?.dead) })).filter((p) => p.dead.length);
  const deadCount = [...results.values()].filter((r) => r.dead).length;

  console.log(`   ${deadCount} dead, ${unique.length - deadCount - otherErrors.length} working, ${otherErrors.length} left alone after other errors.`);
  for (const p of plans.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   🪦 ${p.snap.ref.path}: ${p.dead.length} dead (${p.dead.map((t) => t.slice(0, 12) + "…").join(", ")})`);
  if (plans.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${plans.length - CONFIG.LOG_SAMPLES} more documents.`);
  const codes = [...new Set(otherErrors.map((r) => r.code))];
  if (codes.length) console.log(`   🟡 other errors: ${codes.join(", ")}`);

  if (CONFIG.DRY_RUN || !plans.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "No dead tokens"}.`);
    return;
  }

  console.log(`💾 Before-state saved: ${await saveBeforeState(plans.map((p) => p.snap), { projectId, prefix: "cleanup-fcm-tokens" })}`);
  const { done, failures } = await applyWrites(db, plans.map((p) => writeFor(p.snap, p.dead, CONFIG)));
  printFailures(failures);
  console.log(`\n✅ Cleaned ${done} of ${plans.length} documents.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, tokensOf, isDead, writeFor, checkTokens };
