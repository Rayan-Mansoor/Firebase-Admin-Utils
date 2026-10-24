// scripts/firestore/backfillTtl.js
// Give existing documents the expiry field a Firestore TTL policy deletes them by:
//
//   EXPIRY_FIELD = SOURCE_FIELD + TTL_DAYS      (a Timestamp or a date string/number)
//
// so a backlog written before your code set the field is cleared the same way as
// new documents. It prints the gcloud command that turns the policy on.
//
// What it writes: EXPIRY_FIELD on each document that lacks it (all of them with
// OVERWRITE). A document without SOURCE_FIELD gets now + TTL_DAYS, or is skipped
// with WHEN_SOURCE_MISSING: "skip".
//
// Why it's safe: the dry run (the default) counts the documents and how many would
// expire at once (their expiry is already past: once the policy is on, Firestore
// deletes them within about a day). The armed run saves every document it changes
// into backups/ first, and each update is refused if the document changed after
// it was read. Until the policy deletes anything, removing the field undoes it.
//
// Usage: set CONFIG below, run `node scripts/firestore/backfillTtl.js`, read the
// counts, then set DRY_RUN = false and run it again. Then run the printed command.

const { Timestamp } = require("firebase-admin").firestore;
const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath } = require("../../lib/fieldPaths");
const { saveBeforeState } = require("../../lib/beforeState");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, runMain } = require("../../lib/run");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: which documents (see lib/targets.js).
 *   TTL policies apply per collection id, so USE_COLLECTION_GROUP is the usual choice.
 * - SOURCE_FIELD: the field the expiry counts from ("createdAt", "deliveredAt")
 * - EXPIRY_FIELD: the field to write, the one the TTL policy watches ("expiresAt")
 * - TTL_DAYS: days after SOURCE_FIELD
 * - WHEN_SOURCE_MISSING: "now" (now + TTL_DAYS) | "skip"
 * - OVERWRITE: also rewrite documents that already have EXPIRY_FIELD
 * - DRY_RUN: count without writing
 */
const CONFIG = {
  COLLECTION: "notifications",
  USE_COLLECTION_GROUP: true,
  WHERE: [],
  DOC_IDS: [],

  SOURCE_FIELD: "createdAt",
  EXPIRY_FIELD: "expiresAt",
  TTL_DAYS: 90,
  WHEN_SOURCE_MISSING: "now",
  OVERWRITE: false,

  DRY_RUN: true,
};

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  for (const k of ["SOURCE_FIELD", "EXPIRY_FIELD"]) {
    if (typeof cfg[k] !== "string" || !cfg[k]) throw new Error(`CONFIG.${k} must be a field path.`);
  }
  if (cfg.SOURCE_FIELD === cfg.EXPIRY_FIELD) throw new Error("SOURCE_FIELD and EXPIRY_FIELD must differ.");
  if (!(cfg.TTL_DAYS > 0)) throw new Error("CONFIG.TTL_DAYS must be a positive number.");
  if (!["now", "skip"].includes(cfg.WHEN_SOURCE_MISSING)) throw new Error('CONFIG.WHEN_SOURCE_MISSING must be "now" or "skip".');
  for (const k of ["OVERWRITE", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** Milliseconds of a Timestamp, Date, epoch number or parseable string; null otherwise. */
function millisOf(v) {
  if (v instanceof Timestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** For one document: { expiresAt: Timestamp, from: "source"|"now" } or { skip: reason }. */
function planExpiry(data, cfg, nowMs) {
  if (getByPath(data, cfg.EXPIRY_FIELD) !== undefined && !cfg.OVERWRITE) return { skip: "has it" };
  const sourceMs = millisOf(getByPath(data, cfg.SOURCE_FIELD));
  if (sourceMs === null && cfg.WHEN_SOURCE_MISSING === "skip") return { skip: `no ${cfg.SOURCE_FIELD}` };
  const base = sourceMs ?? nowMs;
  return { expiresAt: Timestamp.fromMillis(base + cfg.TTL_DAYS * DAY_MS), from: sourceMs === null ? "now" : "source" };
}

/** The gcloud command that turns the TTL policy on for the collection id. */
function ttlCommand(cfg, projectId) {
  const collectionId = cfg.COLLECTION.split("/").pop();
  return `gcloud firestore fields ttls update ${cfg.EXPIRY_FIELD} --collection-group=${collectionId} --enable-ttl --project=${projectId}`;
}

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 ${CONFIG.EXPIRY_FIELD} = ${CONFIG.SOURCE_FIELD} + ${CONFIG.TTL_DAYS} days on ${describeTarget(CONFIG)}`);
  banner(CONFIG.DRY_RUN);

  const nowMs = Date.now();
  const plans = [];
  const skipped = new Map();
  let scanned = 0;
  for await (const snap of targetDocs(db, CONFIG)) {
    scanned++;
    const p = planExpiry(snap.data(), CONFIG, nowMs);
    if (p.skip) skipped.set(p.skip, (skipped.get(p.skip) || 0) + 1);
    else plans.push({ snap, ...p });
  }
  const expired = plans.filter((p) => p.expiresAt.toMillis() <= nowMs).length;
  const fromNow = plans.filter((p) => p.from === "now").length;
  console.log(`📊 ${scanned} documents; ${plans.length} get ${CONFIG.EXPIRY_FIELD} (${fromNow} from now, no ${CONFIG.SOURCE_FIELD}).`);
  for (const [why, n] of skipped) console.log(`   ⏭️  ${n} skipped: ${why}`);
  if (expired) console.log(`   ⚠️  ${expired} would expire at once: the TTL policy deletes them within about a day of being on.`);

  if (CONFIG.DRY_RUN || !plans.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to do"}.`);
    console.log(`   Turn the policy on with:\n   ${ttlCommand(CONFIG, projectId)}`);
    return;
  }

  console.log(`💾 Before-state saved: ${await saveBeforeState(plans.map((p) => p.snap), { projectId, prefix: "backfill-ttl" })}`);
  const { done, failures } = await applyWrites(db, plans.map((p) => ({
    op: "update", path: p.snap.ref.path, data: { [CONFIG.EXPIRY_FIELD]: p.expiresAt }, lastUpdateTime: p.snap.updateTime,
  })));
  printFailures(failures);
  console.log(`\n✅ Wrote ${CONFIG.EXPIRY_FIELD} on ${done} of ${plans.length} documents.`);
  console.log(`   Turn the policy on (if it isn't yet) with:\n   ${ttlCommand(CONFIG, projectId)}`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, planExpiry, millisOf, ttlCommand };
