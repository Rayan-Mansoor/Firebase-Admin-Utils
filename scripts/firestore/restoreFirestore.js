// scripts/firestore/restoreFirestore.js
// Restore Firestore from a backup file written by backupFirestore.js. Built as an
// emergency-restore tool: everything is validated before anything is touched.
//
// MODES (CONFIG.MODE):
//   "merge"     – set(..., { merge: true }): overlays the backed-up fields onto whatever
//                 is there now; fields and docs added since the backup survive.
//   "overwrite" – set(): every backed-up doc becomes exactly its backup state; docs
//                 created after the backup survive. (default)
//   "wipe"      – recursively DELETES the restore scope first, then writes: a true
//                 point-in-time restore for those paths. Requires CONFIRM_PROJECT_ID.
//
// SAFETY RAILS:
//   • DRY_RUN is true by default — prints the full plan, writes nothing.
//   • Refuses to restore into a different project than the backup came from
//     (ALLOW_CROSS_PROJECT overrides).
//   • The whole file is validated — including the end-of-file doc count — BEFORE
//     anything is deleted or written.
//   • PRE_RESTORE_BACKUP first snapshots the affected paths to backups/pre-restore-*.ndjson,
//     so even a bad restore is itself restorable.
//
// Usage (CLI arg overrides CONFIG.BACKUP_FILE; mode stays in CONFIG on purpose):
//   node scripts/firestore/restoreFirestore.js backups/firestore-<project>-<ts>.ndjson

const fs = require("fs");
const path = require("path");
const {
  BACKUPS_DIR,
  assertValidPath,
  isCollectionPath,
  pathIsUnder,
  decodeValue,
  backupToFile,
  backupRecords,
  scanBackup,
  integrityProblem,
  resolveBackupFile,
  defaultBackupFilename,
  formatBytes,
} = require("../../lib/backupFile");

/**
 * CONFIG
 * - BACKUP_FILE: path to the .ndjson backup (first CLI arg overrides).
 * - MODE: "merge" | "overwrite" | "wipe" — see header.
 * - TARGETS: restore only docs at/under these paths; [] = everything in the file.
 * - DRY_RUN: print the plan without deleting/writing anything.
 * - CONFIRM_PROJECT_ID: must be set to the live project id to run MODE "wipe".
 * - ALLOW_CROSS_PROJECT: allow restoring a backup taken from a different project.
 * - ALLOW_INCOMPLETE_FILE: allow restoring a truncated file (missing/mismatched end marker).
 * - PRE_RESTORE_BACKUP: snapshot the affected paths before an armed run.
 */
const CONFIG = {
  BACKUP_FILE: "",
  MODE: "overwrite",
  TARGETS: [],
  DRY_RUN: true,
  CONFIRM_PROJECT_ID: "",
  ALLOW_CROSS_PROJECT: false,
  ALLOW_INCOMPLETE_FILE: false,
  PRE_RESTORE_BACKUP: true,
};

const MODES = ["merge", "overwrite", "wipe"];

function validateConfig() {
  if (!MODES.includes(CONFIG.MODE)) throw new Error(`CONFIG.MODE must be one of: ${MODES.join(", ")}.`);
  if (!Array.isArray(CONFIG.TARGETS)) throw new Error("CONFIG.TARGETS must be an array of paths.");
  CONFIG.TARGETS.forEach(assertValidPath);
  for (const k of ["DRY_RUN", "ALLOW_CROSS_PROJECT", "ALLOW_INCOMPLETE_FILE", "PRE_RESTORE_BACKUP"]) {
    if (typeof CONFIG[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** Whether a doc path is in the restore scope `targets` ([] = everything). */
function inScope(docPath, targets) {
  return targets.length === 0 || targets.some((f) => pathIsUnder(docPath, f));
}

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  const started = Date.now();
  validateConfig();
  const fileArg = process.argv[2] || CONFIG.BACKUP_FILE;
  if (!fileArg) throw new Error("No backup file given. Pass it as the first CLI arg or set CONFIG.BACKUP_FILE.");
  const file = resolveBackupFile(fileArg);
  const matches = (p) => inScope(p, CONFIG.TARGETS);

  console.log(`🔍 Validating ${path.relative(process.cwd(), file)}…`);
  const scan = await scanBackup(file, matches);
  const { meta } = scan;
  if (scan.unknownLines > 0) console.warn(`⚠️  Skipped ${scan.unknownLines} record(s) of unknown type.`);

  const problem = integrityProblem(scan);
  if (problem) {
    if (!CONFIG.ALLOW_INCOMPLETE_FILE) {
      throw new Error(`${problem} Set CONFIG.ALLOW_INCOMPLETE_FILE = true to restore it anyway.`);
    }
    console.warn(`⚠️  ${problem} Proceeding because ALLOW_INCOMPLETE_FILE is set.`);
  }

  if (meta.projectId !== projectId && !CONFIG.ALLOW_CROSS_PROJECT) {
    throw new Error(
      `Backup is from project '${meta.projectId}' but you are connected to '${projectId}'. Set ALLOW_CROSS_PROJECT = true if this is intentional.`
    );
  }

  // Scope = what gets pre-backed-up, and deleted first in wipe mode.
  const scope = CONFIG.TARGETS.length ? CONFIG.TARGETS : meta.roots;

  console.log("\n📋 Restore plan:");
  console.log(`   Backup taken:   ${meta.capturedAt} from '${meta.projectId}' (${meta.full ? "full database" : `partial: ${meta.roots.join(", ")}`})`);
  console.log(`   Target project: ${projectId}`);
  console.log(`   Mode:           ${CONFIG.MODE}`);
  console.log(`   Scope:          ${CONFIG.TARGETS.length ? CONFIG.TARGETS.join(", ") : "everything in the file"}`);
  console.log(`   Docs to write:  ${scan.matchedDocs} of ${scan.totalDocs} in file`);
  for (const [root, n] of [...scan.perRoot.entries()].sort()) console.log(`     • ${root}: ${n}`);
  if (CONFIG.MODE === "wipe") {
    console.log(`   Wipe first:     ${scope.join(", ")}  ⚠️  these paths will be DELETED before writing`);
  }

  if (scan.matchedDocs === 0) {
    throw new Error("0 documents match the restore scope — nothing to restore. Check TARGETS against the backup contents.");
  }

  if (CONFIG.DRY_RUN) {
    console.log("\n✅ Dry run only — nothing was deleted or written. Set CONFIG.DRY_RUN = false to run this plan.");
    return;
  }

  if (CONFIG.MODE === "wipe" && CONFIG.CONFIRM_PROJECT_ID !== projectId) {
    throw new Error(`MODE "wipe" deletes data. Type the project id into CONFIG.CONFIRM_PROJECT_ID ("${projectId}") to confirm.`);
  }

  if (CONFIG.PRE_RESTORE_BACKUP) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const preOut = path.join(BACKUPS_DIR, defaultBackupFilename(projectId, { prefix: "pre-restore" }));
    console.log(`\n🛟 Taking pre-restore snapshot of ${scope.join(", ")}…`);
    const pre = await backupToFile(db, { targets: scope, outPath: preOut, projectId, log: () => {} });
    console.log(`   Saved ${pre.docs} docs → ${path.relative(process.cwd(), preOut)} (${formatBytes(pre.bytes)})`);
  }

  if (CONFIG.MODE === "wipe") {
    console.log("\n🗑️  Wiping restore scope…");
    for (const p of scope) {
      console.log(`   deleting ${p}…`);
      await db.recursiveDelete(isCollectionPath(p) ? db.collection(p) : db.doc(p));
    }
  }

  console.log(`\n🚀 Restoring ${scan.matchedDocs} documents (${CONFIG.MODE})…`);
  const writer = db.bulkWriter();
  let failed = 0;
  writer.onWriteError((err) => {
    if (err.failedAttempts < 5) return true; // retry with backoff
    failed++;
    console.error(`   ❌ ${err.documentRef.path}: ${err.message}`);
    return false;
  });

  let queued = 0;
  let decodeErrors = 0;
  for await (const obj of backupRecords(file)) {
    if (obj.type !== "doc" || !matches(obj.path)) continue;
    let data;
    try {
      data = decodeValue(obj.data, obj.path, db);
    } catch (err) {
      decodeErrors++;
      console.error(`   ❌ Could not decode ${obj.path}: ${err.message}`);
      continue;
    }
    const ref = db.doc(obj.path);
    // Failures are already counted/logged in onWriteError — swallow the per-write rejection.
    if (CONFIG.MODE === "merge") writer.set(ref, data, { merge: true }).catch(() => {});
    else writer.set(ref, data).catch(() => {});
    queued++;
    if (queued % 500 === 0) {
      console.log(`   …${queued}/${scan.matchedDocs} queued`);
      await writer.flush();
    }
  }
  await writer.close();

  const succeeded = queued - failed;
  console.log("\n📊 Restore summary:");
  console.log(`   Docs written:   ${succeeded}/${scan.matchedDocs}`);
  if (failed) console.log(`   Write failures: ${failed}`);
  if (decodeErrors) console.log(`   Decode errors:  ${decodeErrors}`);
  console.log(`   Elapsed:        ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (failed || decodeErrors) {
    throw new Error("Completed with errors — rerunning the same restore is safe (writes are idempotent).");
  }
  console.log("🎉 Restore complete.");
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error("💥 Restore failed:", err?.message || err);
    process.exit(1);
  });
}

module.exports = { CONFIG, main, inScope };
