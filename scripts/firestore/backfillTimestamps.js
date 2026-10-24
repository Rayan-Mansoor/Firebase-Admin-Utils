// scripts/firestore/backfillTimestamps.js
// Fill in missing created / updated timestamps from the times Firestore itself
// keeps for every document: when it was created, and when it was last written.
//
// What it writes: CREATED_FIELD = the document's create time, and UPDATED_FIELD =
// its last update time (before this run's own write), only where the field is
// missing; a field already set is never touched. Either can be turned off with null.
//
// Why it's safe: the dry run (the default) counts what is missing. The armed run
// saves every document it changes into backups/ first, and each update is refused
// if the document changed after it was read.
//
// Usage: set CONFIG below, run `node scripts/firestore/backfillTimestamps.js`, read
// the counts, then set DRY_RUN = false and run it again.

const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath } = require("../../lib/fieldPaths");
const { saveBeforeState } = require("../../lib/beforeState");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, preview, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: which documents (see lib/targets.js)
 * - CREATED_FIELD: field for the create time, or null to leave it
 * - UPDATED_FIELD: field for the last update time, or null to leave it
 * - FORMAT: "timestamp" (a Firestore Timestamp) | "iso" (an ISO 8601 string) | "millis" (a number)
 * - DRY_RUN: count without writing
 * - LOG_SAMPLES: how many documents to print (0 = none)
 */
const CONFIG = {
  COLLECTION: "users",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],

  CREATED_FIELD: "createdAt",
  UPDATED_FIELD: "updatedAt",
  FORMAT: "timestamp",

  DRY_RUN: true,
  LOG_SAMPLES: 10,
};

const FORMATS = {
  timestamp: (ts) => ts,
  iso: (ts) => ts.toDate().toISOString(),
  millis: (ts) => ts.toMillis(),
};

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  for (const k of ["CREATED_FIELD", "UPDATED_FIELD"]) {
    if (cfg[k] !== null && (typeof cfg[k] !== "string" || !cfg[k])) throw new Error(`CONFIG.${k} must be a field path or null.`);
  }
  if (!cfg.CREATED_FIELD && !cfg.UPDATED_FIELD) throw new Error("Nothing to do: CREATED_FIELD and UPDATED_FIELD are both null.");
  if (cfg.CREATED_FIELD && cfg.CREATED_FIELD === cfg.UPDATED_FIELD) throw new Error("CREATED_FIELD and UPDATED_FIELD must differ.");
  if (!FORMATS[cfg.FORMAT]) throw new Error(`CONFIG.FORMAT must be one of ${Object.keys(FORMATS).join(", ")}.`);
  if (typeof cfg.DRY_RUN !== "boolean") throw new Error("CONFIG.DRY_RUN must be boolean.");
}

/** The fields to fill on one document, from its data and Firestore's create/update times. */
function planTimestamps(data, { createTime, updateTime }, cfg = CONFIG) {
  const update = {};
  const fmt = FORMATS[cfg.FORMAT];
  if (cfg.CREATED_FIELD && getByPath(data, cfg.CREATED_FIELD) === undefined) update[cfg.CREATED_FIELD] = fmt(createTime);
  if (cfg.UPDATED_FIELD && getByPath(data, cfg.UPDATED_FIELD) === undefined) update[cfg.UPDATED_FIELD] = fmt(updateTime);
  return update;
}

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Fill ${[CONFIG.CREATED_FIELD, CONFIG.UPDATED_FIELD].filter(Boolean).join(" / ")} from Firestore's own times on ${describeTarget(CONFIG)}`);
  banner(CONFIG.DRY_RUN);

  const plans = [];
  let scanned = 0;
  for await (const snap of targetDocs(db, CONFIG)) {
    scanned++;
    const update = planTimestamps(snap.data(), snap, CONFIG);
    if (Object.keys(update).length) plans.push({ snap, update });
  }
  console.log(`📊 ${scanned} documents; ${plans.length} are missing a timestamp.`);
  for (const p of plans.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   ✏️  ${p.snap.ref.path}: ${preview(p.update)}`);
  if (plans.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${plans.length - CONFIG.LOG_SAMPLES} more.`);

  if (CONFIG.DRY_RUN || !plans.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to do"}.`);
    return;
  }

  console.log(`💾 Before-state saved: ${await saveBeforeState(plans.map((p) => p.snap), { projectId, prefix: "backfill-timestamps" })}`);
  const { done, failures } = await applyWrites(db, plans.map((p) => ({
    op: "update", path: p.snap.ref.path, data: p.update, lastUpdateTime: p.snap.updateTime,
  })));
  printFailures(failures);
  console.log(`\n✅ Filled in ${done} of ${plans.length} documents.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, planTimestamps };
