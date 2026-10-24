// scripts/firestore/backupFirestore.js
// Back up the ENTIRE Firestore database — or specific collections, subcollections,
// or document subtrees — into a single local NDJSON file under backups/.
// Restore it with restoreFirestore.js. The format is described in lib/backupFile.js.
//
// What gets preserved:
//   • The full hierarchy (subcollections at any depth), including subcollections whose
//     parent document no longer exists ("ghost" parents, shown italic in the console).
//   • Firestore types round-trip exactly: Timestamp, GeoPoint, DocumentReference,
//     Bytes, NaN/±Infinity, vector values.
//
// It only reads, so there is no DRY_RUN.
//
// Usage (CLI paths override CONFIG.TARGETS):
//   node scripts/firestore/backupFirestore.js                      # full database
//   node scripts/firestore/backupFirestore.js users classes        # just these collections
//   node scripts/firestore/backupFirestore.js users/abc/attempts   # a subcollection
//   node scripts/firestore/backupFirestore.js users/abc            # a single doc + its descendants

const fs = require("fs");
const path = require("path");
const { BACKUPS_DIR, assertValidPath, backupToFile, defaultBackupFilename, formatBytes } = require("../../lib/backupFile");

/**
 * CONFIG
 * - TARGETS: [] = entire database. Otherwise a list of paths:
 *   odd number of segments = collection ("users", "users/abc/attempts"),
 *   even = a single document and all of its descendants ("users/abc").
 * - OUTPUT_DIR: where backup files are written.
 */
const CONFIG = {
  TARGETS: [],
  OUTPUT_DIR: BACKUPS_DIR,
};

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  const started = Date.now();
  const cliTargets = process.argv.slice(2);
  const targets = cliTargets.length ? cliTargets : CONFIG.TARGETS;
  targets.forEach(assertValidPath);

  fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
  const outPath = path.join(CONFIG.OUTPUT_DIR, defaultBackupFilename(projectId, { full: targets.length === 0 }));

  console.log(
    `🚀 Backing up ${targets.length ? targets.join(", ") : "the ENTIRE database"} → ${path.relative(process.cwd(), outPath)}`
  );
  const stats = await backupToFile(db, { targets, outPath, projectId });

  console.log("\n📊 Backup summary:");
  console.log(`   Project:             ${stats.projectId}`);
  console.log(`   Roots:               ${stats.roots.join(", ")}`);
  console.log(`   Documents:           ${stats.docs}`);
  console.log(`   Collections visited: ${stats.collections}`);
  if (stats.ghostParents > 0) {
    console.log(
      `   Ghost parents:       ${stats.ghostParents} (deleted docs whose subcollections still exist — descendants were backed up)`
    );
  }
  console.log(`   File:                ${path.relative(process.cwd(), outPath)} (${formatBytes(stats.bytes)})`);
  console.log(`   Elapsed:             ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (stats.docs === 0) {
    console.log("\n⚠️  0 documents were backed up — double-check your target paths.");
  } else {
    console.log(`\n✅ Done. Restore with: node scripts/firestore/restoreFirestore.js ${path.relative(process.cwd(), outPath)}`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error("💥 Backup failed:", err?.message || err);
    process.exit(1);
  });
}

module.exports = { CONFIG, main };
