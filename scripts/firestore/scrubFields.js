// scripts/firestore/scrubFields.js
// Remove fields across a collection (or every collection with an id): delete them
// or set them to null, strip keys from the objects inside array fields, and
// optionally delete whole subcollections under each matched document.
//
// What it writes: an update per document that holds something to scrub (a field
// already gone is skipped, so running it again writes nothing), and a recursive
// delete of each listed subcollection that has documents.
//
// Why it's safe: the dry run (the default) prints what would go, with each
// subcollection's document count. The armed run first saves the documents it will
// update, and every subcollection it will delete, into backups/ (both restorable
// with restoreFirestore.js), and each update is refused if the document changed
// after it was read.
//
// Usage: set CONFIG below, run `node scripts/firestore/scrubFields.js`, read the
// plan, then set DRY_RUN = false and run it again.

const { FieldValue } = require("firebase-admin").firestore;
const path = require("path");
const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath, setByPath, unsetByPath, sameValue } = require("../../lib/fieldPaths");
const { BACKUPS_DIR, backupToFile, defaultBackupFilename } = require("../../lib/backupFile");
const { saveBeforeState } = require("../../lib/beforeState");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: which documents (see lib/targets.js)
 * - FIELD_PATHS: field paths to scrub (dotted map paths; no array indexing)
 * - ARRAY_CLEANERS: [{ arrayPath, deleteKeys: [...] }] keys to scrub from each object in an array field
 * - SUBCOLLECTIONS_TO_DELETE: subcollection names to delete, with everything under them,
 *   from each matched document. Always a real delete, whatever HARD_DELETE says.
 * - HARD_DELETE: true = delete fields and keys; false = set them to null
 * - DRY_RUN: print the plan without writing
 * - LOG_SAMPLES: how many documents to print (0 = none)
 */
const CONFIG = {
  COLLECTION: "users",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],

  FIELD_PATHS: [],
  ARRAY_CLEANERS: [],
  SUBCOLLECTIONS_TO_DELETE: [],

  HARD_DELETE: false,
  DRY_RUN: true,
  LOG_SAMPLES: 10,
};

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  for (const k of ["FIELD_PATHS", "ARRAY_CLEANERS", "SUBCOLLECTIONS_TO_DELETE"]) {
    if (!Array.isArray(cfg[k])) throw new Error(`CONFIG.${k} must be an array.`);
  }
  for (const p of cfg.FIELD_PATHS) {
    if (typeof p !== "string" || !p.trim()) throw new Error(`Invalid field path: "${p}"`);
  }
  for (const rule of cfg.ARRAY_CLEANERS) {
    if (!rule || typeof rule.arrayPath !== "string" || !Array.isArray(rule.deleteKeys) || !rule.deleteKeys.length) {
      throw new Error("ARRAY_CLEANERS entries need an arrayPath and a non-empty deleteKeys list.");
    }
  }
  for (const name of cfg.SUBCOLLECTIONS_TO_DELETE) {
    if (typeof name !== "string" || !name.trim() || name.includes("/")) throw new Error(`Invalid subcollection name: "${name}"`);
  }
  if (!cfg.FIELD_PATHS.length && !cfg.ARRAY_CLEANERS.length && !cfg.SUBCOLLECTIONS_TO_DELETE.length) {
    throw new Error("Nothing to do: FIELD_PATHS, ARRAY_CLEANERS and SUBCOLLECTIONS_TO_DELETE are all empty.");
  }
  for (const k of ["HARD_DELETE", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** Whether `v` still needs scrubbing: present, and not already null in null mode. */
const needsScrub = (v, hard) => v !== undefined && (hard || v !== null);

/** The field update for one document: { update, changes }, empty when there is nothing to scrub. */
function planDoc(data, cfg = CONFIG) {
  const update = {};
  const changes = [];
  const hard = cfg.HARD_DELETE;
  for (const p of cfg.FIELD_PATHS) {
    if (!needsScrub(getByPath(data, p), hard)) continue;
    update[p] = hard ? FieldValue.delete() : null;
    changes.push(`${hard ? "delete" : "null"} ${p}`);
  }
  for (const rule of cfg.ARRAY_CLEANERS) {
    const arr = getByPath(data, rule.arrayPath);
    if (!Array.isArray(arr)) continue;
    const next = arr.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const clone = { ...item };
      for (const key of rule.deleteKeys) {
        if (!needsScrub(getByPath(clone, key), hard)) continue;
        if (hard) unsetByPath(clone, key);
        else setByPath(clone, key, null);
      }
      return clone;
    });
    if (!sameValue(next, arr)) {
      update[rule.arrayPath] = next;
      changes.push(`${hard ? "delete" : "null"} ${rule.deleteKeys.join(", ")} in ${rule.arrayPath}[]`);
    }
  }
  return { update, changes };
}

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Scrub fields in ${describeTarget(CONFIG)}`);
  banner(CONFIG.DRY_RUN);

  const plans = [];
  const subcollections = []; // { path, count }
  let scanned = 0;
  for await (const snap of targetDocs(db, CONFIG)) {
    scanned++;
    const { update, changes } = planDoc(snap.data(), CONFIG);
    if (changes.length) plans.push({ snap, update, changes });
    for (const name of CONFIG.SUBCOLLECTIONS_TO_DELETE) {
      const col = snap.ref.collection(name);
      const count = (await col.count().get()).data().count;
      if (count) subcollections.push({ path: col.path, count });
    }
  }

  const subDocs = subcollections.reduce((n, s) => n + s.count, 0);
  console.log(`📊 ${scanned} documents matched; ${plans.length} have fields to scrub; ${subcollections.length} subcollections to delete (${subDocs} top-level docs, plus anything under them).`);
  for (const p of plans.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   ✏️  ${p.snap.ref.path}: ${p.changes.join("; ")}`);
  if (plans.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${plans.length - CONFIG.LOG_SAMPLES} more documents.`);
  for (const s of subcollections.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   🗑️  ${s.path}: ${s.count} docs`);
  if (subcollections.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${subcollections.length - CONFIG.LOG_SAMPLES} more subcollections.`);

  if (CONFIG.DRY_RUN || (!plans.length && !subcollections.length)) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to do"}.`);
    return;
  }

  if (plans.length) {
    const backup = await saveBeforeState(plans.map((p) => p.snap), { projectId, prefix: "scrub-fields" });
    console.log(`💾 Before-state saved: ${backup}`);
    const { done, failures } = await applyWrites(db, plans.map((p) => ({
      op: "update", path: p.snap.ref.path, data: p.update, lastUpdateTime: p.snap.updateTime,
    })));
    printFailures(failures);
    console.log(`✅ Scrubbed ${done} of ${plans.length} documents.`);
  }

  if (subcollections.length) {
    const outPath = path.join(BACKUPS_DIR, defaultBackupFilename(projectId, { full: false, prefix: "scrub-fields-subcollections" }));
    const saved = await backupToFile(db, { targets: subcollections.map((s) => s.path), outPath, projectId, log: () => {} });
    console.log(`💾 ${saved.docs} subcollection docs saved: ${outPath}`);
    for (const s of subcollections) await db.recursiveDelete(db.collection(s.path));
    console.log(`✅ Deleted ${subcollections.length} subcollections.`);
  }
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, planDoc };
