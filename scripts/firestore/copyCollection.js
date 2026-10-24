// scripts/firestore/copyCollection.js
// Copy a Firestore collection to another collection, document ids kept, optionally
// with all its subcollections, reshaping each document on the way (TRANSFORM), and
// optionally delete the source once every copy has landed (a move).
//
// What it writes: every source document to the same id under the destination
// (an existing destination doc is overwritten); with IS_DESTRUCTIVE, then a
// recursive delete of the source.
//
// Why it's safe: the dry run (the default) lists what would be copied and which
// destination docs would be overwritten. The armed run first saves those
// destination docs into backups/, and with IS_DESTRUCTIVE backs up the whole
// source before deleting it, only when no copy failed. Both restore with
// restoreFirestore.js.
//
// Usage: set CONFIG below, run `node scripts/firestore/copyCollection.js`, read the
// plan, then set DRY_RUN = false and run it again.

const path = require("path");
const { BACKUPS_DIR, isCollectionPath, backupToFile, defaultBackupFilename } = require("../../lib/backupFile");
const { saveBeforeState } = require("../../lib/beforeState");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, preview, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - SOURCE_COLLECTION: source collection path ("users", "users/abc/posts")
 * - DESTINATION_COLLECTION: destination collection path
 * - INCLUDE_SUBCOLLECTIONS: also copy every subcollection, at any depth
 * - TRANSFORM: null, or (data, { id, path, destPath }) => new data, or null to skip that doc.
 *   Runs on every copied doc, subcollection docs included (check `path` to tell them apart).
 * - IS_DESTRUCTIVE: delete the source (docs and descendants) after a fully successful copy;
 *   not done when TRANSFORM skipped any doc
 * - DRY_RUN: print the plan without writing or deleting
 * - LOG_SAMPLES: how many copies to print (0 = none)
 */
const CONFIG = {
  SOURCE_COLLECTION: "users",
  DESTINATION_COLLECTION: "users_copy",
  INCLUDE_SUBCOLLECTIONS: false,
  TRANSFORM: null,
  // TRANSFORM: (data, { id }) => ({ ...data, migratedFrom: id, legacyField: undefined }),
  IS_DESTRUCTIVE: false,
  DRY_RUN: true,
  LOG_SAMPLES: 10,
};

function validateConfig(cfg = CONFIG) {
  for (const k of ["SOURCE_COLLECTION", "DESTINATION_COLLECTION"]) {
    const p = cfg[k];
    if (!p || typeof p !== "string" || p.split("/").some((s) => !s)) throw new Error(`CONFIG.${k} must be a collection path.`);
    if (!isCollectionPath(p)) throw new Error(`CONFIG.${k} "${p}" is a document path, not a collection.`);
  }
  const src = cfg.SOURCE_COLLECTION;
  const dest = cfg.DESTINATION_COLLECTION;
  if (src === dest) throw new Error("SOURCE_COLLECTION and DESTINATION_COLLECTION must differ.");
  if (dest.startsWith(src + "/") || src.startsWith(dest + "/")) {
    throw new Error("The source and destination can't be nested in each other.");
  }
  if (cfg.TRANSFORM != null && typeof cfg.TRANSFORM !== "function") throw new Error("CONFIG.TRANSFORM must be null or a function.");
  for (const k of ["INCLUDE_SUBCOLLECTIONS", "IS_DESTRUCTIVE", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** Where a source doc lands: the same relative path under the destination. */
function destPathOf(srcPath, src, dest) {
  if (!srcPath.startsWith(src + "/")) throw new Error(`${srcPath} is not under ${src}.`);
  return dest + srcPath.slice(src.length);
}

/**
 * The copy after TRANSFORM: { ...copy, data } or null when skipped. Fields the
 * transform sets to undefined are dropped.
 */
function transformCopy(copy, transform) {
  if (!transform) return copy;
  const id = copy.from.split("/").pop();
  const data = transform(copy.data, { id, path: copy.from, destPath: copy.to });
  if (data === null) return null;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`TRANSFORM returned ${preview(data)} for ${copy.from}; return an object or null.`);
  return { ...copy, data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
}

/** Every source document (with subcollections when asked), ghost parents' children included. */
async function* sourceDocs(db, colRef, withSubs) {
  const refs = await colRef.listDocuments();
  for (let i = 0; i < refs.length; i += 300) {
    for (const snap of await db.getAll(...refs.slice(i, i + 300))) {
      if (snap.exists) yield snap;
      if (withSubs) for (const sub of await snap.ref.listCollections()) yield* sourceDocs(db, sub, true);
    }
  }
}

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  const { SOURCE_COLLECTION: src, DESTINATION_COLLECTION: dest } = CONFIG;
  console.log(`🚀 Copy '${src}' → '${dest}'${CONFIG.INCLUDE_SUBCOLLECTIONS ? " with subcollections" : ""}${CONFIG.IS_DESTRUCTIVE ? ", then delete the source" : ""}`);
  banner(CONFIG.DRY_RUN);

  const copies = [];
  let skipped = 0;
  for await (const snap of sourceDocs(db, db.collection(src), CONFIG.INCLUDE_SUBCOLLECTIONS)) {
    const copy = transformCopy({ from: snap.ref.path, to: destPathOf(snap.ref.path, src, dest), data: snap.data() }, CONFIG.TRANSFORM);
    if (copy) copies.push(copy);
    else skipped++;
  }
  const overwritten = [];
  for (let i = 0; i < copies.length; i += 300) {
    const snaps = await db.getAll(...copies.slice(i, i + 300).map((c) => db.doc(c.to)));
    overwritten.push(...snaps.filter((s) => s.exists));
  }

  console.log(`📊 ${copies.length} documents to copy${CONFIG.TRANSFORM ? `, ${skipped} skipped by TRANSFORM` : ""}; ${overwritten.length} destination docs would be overwritten.`);
  for (const c of copies.slice(0, CONFIG.LOG_SAMPLES)) {
    console.log(`   → ${c.from}  ->  ${c.to}`);
    if (CONFIG.TRANSFORM) console.log(`        ${preview(c.data)}`);
  }
  if (copies.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${copies.length - CONFIG.LOG_SAMPLES} more.`);
  for (const s of overwritten.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   ⚠️  overwrites ${s.ref.path}`);

  if (CONFIG.DRY_RUN || !copies.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to copy"}.`);
    return;
  }

  if (overwritten.length) {
    console.log(`💾 Before-state of overwritten docs: ${await saveBeforeState(overwritten, { projectId, prefix: "copy-collection" })}`);
  }
  const { done, failures } = await applyWrites(db, copies.map((c) => ({ op: "set", path: c.to, data: c.data })));
  printFailures(failures);
  console.log(`✅ Copied ${done} of ${copies.length} documents.`);

  if (!CONFIG.IS_DESTRUCTIVE) return;
  if (failures.length || done !== copies.length) {
    throw new Error("Some copies failed, so the source was NOT deleted. Run it again.");
  }
  if (skipped) {
    throw new Error(`TRANSFORM skipped ${skipped} docs, so the source was NOT deleted: they exist only there. Delete it with deleteCollection.js once you have checked.`);
  }
  const outPath = path.join(BACKUPS_DIR, defaultBackupFilename(projectId, { full: false, prefix: "copy-collection-source" }));
  const saved = await backupToFile(db, { targets: [src], outPath, projectId, log: () => {} });
  console.log(`💾 Source saved (${saved.docs} docs): ${outPath}`);
  await db.recursiveDelete(db.collection(src));
  console.log(`🗑️  Deleted '${src}' and everything under it.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, destPathOf, transformCopy };
