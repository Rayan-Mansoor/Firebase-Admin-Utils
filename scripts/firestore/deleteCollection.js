// scripts/firestore/deleteCollection.js
// Delete collections, document subtrees, or the documents a query matches, after
// backing them up and checking that the backup holds every document there is.
//
// What it writes: recursive deletes of PATHS (collections or documents, with
// everything under them), or deletes of the documents COLLECTION / WHERE / DOC_IDS
// match (with their subcollections when INCLUDE_SUBCOLLECTIONS is on).
//
// Why it's safe: the dry run (the default) counts what would go. The armed run
// needs CONFIRM_PROJECT_ID, backs everything up into backups/ first (restorable
// with restoreFirestore.js), re-reads what is there and refuses unless every live
// document is in that backup. A matched document changed after it was read is
// not deleted.
//
// Usage: set CONFIG below, run `node scripts/firestore/deleteCollection.js`, read the
// count, then set DRY_RUN = false and CONFIRM_PROJECT_ID and run it again.

const path = require("path");
const {
  BACKUPS_DIR, assertValidPath, isCollectionPath, backupToFile, backupRecords, scanBackup, integrityProblem, defaultBackupFilename,
} = require("../../lib/backupFile");
const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - PATHS: collection or document paths to delete with everything under them
 *   ("app_users", "users/abc"). When set, the target keys below are ignored.
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: or delete the documents these
 *   match (see lib/targets.js)
 * - INCLUDE_SUBCOLLECTIONS: with the target keys, also delete each document's subcollections
 * - CONFIRM_PROJECT_ID: the project id, typed in, for an armed run
 * - DRY_RUN: count without backing up or deleting
 */
const CONFIG = {
  PATHS: [],

  COLLECTION: "",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],
  INCLUDE_SUBCOLLECTIONS: true,

  CONFIRM_PROJECT_ID: "",
  DRY_RUN: true,
};

function validateConfig(cfg = CONFIG) {
  if (!Array.isArray(cfg.PATHS)) throw new Error("CONFIG.PATHS must be an array.");
  if (cfg.PATHS.length) {
    cfg.PATHS.forEach(assertValidPath);
    const nested = cfg.PATHS.find((p) => cfg.PATHS.some((o) => o !== p && p.startsWith(o + "/")));
    if (nested) throw new Error(`"${nested}" is inside another of PATHS; list only the outer one.`);
  } else {
    if (!cfg.COLLECTION) throw new Error("Set PATHS, or COLLECTION with WHERE or DOC_IDS.");
    validateTarget(cfg);
  }
  for (const k of ["INCLUDE_SUBCOLLECTIONS", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** Live document paths that the backup doesn't hold. */
function missingFromBackup(livePaths, backedUp) {
  return livePaths.filter((p) => !backedUp.has(p));
}

/** Every existing document path under a collection or document, ghost parents' children included. */
async function livePaths(db, root, withSubs = true, out = []) {
  if (isCollectionPath(root)) {
    const refs = await db.collection(root).listDocuments();
    for (const ref of refs) await livePaths(db, ref.path, withSubs, out);
    return out;
  }
  const ref = db.doc(root);
  if ((await ref.get()).exists) out.push(root);
  if (withSubs) for (const sub of await ref.listCollections()) await livePaths(db, sub.path, true, out);
  return out;
}

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  const byPaths = CONFIG.PATHS.length > 0;
  const withSubs = byPaths || CONFIG.INCLUDE_SUBCOLLECTIONS;
  console.log(`🚀 Delete ${byPaths ? CONFIG.PATHS.join(", ") + " with everything under them" : `the documents of ${describeTarget(CONFIG)}${withSubs ? " with their subcollections" : ""}`}`);
  banner(CONFIG.DRY_RUN);

  // The roots to back up and delete, and for target mode the matched snapshots.
  const matched = [];
  if (!byPaths) for await (const snap of targetDocs(db, CONFIG)) matched.push(snap);
  const roots = byPaths ? CONFIG.PATHS : matched.map((s) => s.ref.path);

  const live = [];
  for (const root of roots) await livePaths(db, root, withSubs, live);
  console.log(`📊 ${live.length} documents would be deleted${byPaths ? "" : ` (${matched.length} matched)`}.`);
  for (const root of roots.slice(0, 10)) console.log(`   🗑️  ${root}`);
  if (roots.length > 10) console.log(`   … and ${roots.length - 10} more.`);

  if (CONFIG.DRY_RUN || !live.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to delete"}.`);
    return;
  }
  if (CONFIG.CONFIRM_PROJECT_ID !== projectId) {
    throw new Error(`This deletes data. Type the project id into CONFIG.CONFIRM_PROJECT_ID ("${projectId}") to confirm.`);
  }

  const outPath = path.join(BACKUPS_DIR, defaultBackupFilename(projectId, { full: false, prefix: "delete-collection" }));
  const saved = await backupToFile(db, { targets: roots, outPath, projectId, log: () => {} });
  console.log(`💾 Backup: ${outPath} (${saved.docs} docs)`);

  // The check: the backup is whole, and holds every document there is now.
  const problem = integrityProblem(await scanBackup(outPath));
  if (problem) throw new Error(`The backup can't be trusted (${problem}); nothing was deleted.`);
  const backedUp = new Set();
  for await (const r of backupRecords(outPath)) if (r.type === "doc") backedUp.add(r.path);
  const now = [];
  for (const root of roots) await livePaths(db, root, withSubs, now);
  const missing = missingFromBackup(now, backedUp);
  if (missing.length) {
    throw new Error(`${missing.length} documents are not in the backup (written since?), e.g. ${missing.slice(0, 5).join(", ")}. Nothing was deleted; run it again.`);
  }
  console.log(`✅ Every one of the ${now.length} documents is in the backup.`);

  if (byPaths) {
    for (const root of roots) await db.recursiveDelete(isCollectionPath(root) ? db.collection(root) : db.doc(root));
    console.log(`🗑️  Deleted ${roots.join(", ")}.`);
    return;
  }
  if (withSubs) {
    for (const snap of matched) for (const sub of await snap.ref.listCollections()) await db.recursiveDelete(sub);
  }
  const { done, failures } = await applyWrites(db, matched.map((s) => ({ op: "delete", path: s.ref.path, lastUpdateTime: s.updateTime })));
  printFailures(failures);
  console.log(`🗑️  Deleted ${done} of ${matched.length} documents.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, missingFromBackup };
