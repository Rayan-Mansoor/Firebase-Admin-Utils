// scripts/firestore/changesSince.js
// List what changed in Firestore since a backup was taken: documents created,
// documents updated, and documents the backup holds that are gone. Useful after a
// migration or deploy window, to find what was written in between.
//
// It reads Firestore's own create and update times, so it doesn't compare fields
// (diffCollections.js does that). Without a backup, give SINCE instead: created and
// updated documents are found the same way, but deletions can't be.
//
// It only reads. OUTPUT_FILE saves the paths as JSON, to feed a follow-up script.
//
// Usage: node scripts/firestore/changesSince.js backups/firestore-<project>-<time>.ndjson

const fs = require("fs");
const path = require("path");
const { assertValidPath, isCollectionPath, scanBackup, backupRecords, resolveBackupFile } = require("../../lib/backupFile");
const { runMain } = require("../../lib/run");

/**
 * CONFIG
 * - BACKUP_FILE: the backup to compare with (first CLI arg overrides); its capture time is
 *   the "since", and its roots are what is checked
 * - SINCE: or, without a backup, an ISO date-time ("2026-10-01T00:00:00Z")
 * - ROOTS: with SINCE, the collection or document paths to check ([] = every root collection)
 * - LOG_SAMPLES: how many paths of each kind to print
 * - OUTPUT_FILE: null, or a path to write { since, created, updated, deleted } to as JSON
 */
const CONFIG = {
  BACKUP_FILE: "",
  SINCE: "",
  ROOTS: [],
  LOG_SAMPLES: 25,
  OUTPUT_FILE: null,
};

function validateConfig(cfg = CONFIG, fileArg = "") {
  const file = fileArg || cfg.BACKUP_FILE;
  if (!file && !cfg.SINCE) throw new Error("Give a backup file (CLI arg or BACKUP_FILE), or SINCE.");
  if (file && cfg.SINCE) throw new Error("Use a backup file or SINCE, not both.");
  if (cfg.SINCE && Number.isNaN(Date.parse(cfg.SINCE))) throw new Error(`SINCE "${cfg.SINCE}" is not a date-time.`);
  if (!Array.isArray(cfg.ROOTS)) throw new Error("CONFIG.ROOTS must be an array.");
  cfg.ROOTS.forEach(assertValidPath);
  if (file && cfg.ROOTS.length) throw new Error("ROOTS goes with SINCE; with a backup, its own roots are checked.");
}

/**
 * What happened to one document since `sinceMs`: "created" | "updated" | "deleted" | null.
 * `live` is { createMs, updateMs } or null when it no longer exists.
 */
function changeOf(inBackup, live, sinceMs) {
  if (!live) return inBackup ? "deleted" : null;
  if (live.createMs > sinceMs && !inBackup) return "created";
  if (live.updateMs > sinceMs) return inBackup || live.createMs <= sinceMs ? "updated" : "created";
  return null;
}

/** Every live document under the roots: path → { createMs, updateMs }. */
async function liveTimes(db, roots) {
  const out = new Map();
  const visitDoc = async (snap) => {
    if (snap.exists) out.set(snap.ref.path, { createMs: snap.createTime.toMillis(), updateMs: snap.updateTime.toMillis() });
    for (const sub of await snap.ref.listCollections()) await visitCol(sub);
  };
  const visitCol = async (colRef) => {
    const refs = await colRef.listDocuments();
    for (let i = 0; i < refs.length; i += 300) for (const snap of await db.getAll(...refs.slice(i, i + 300))) await visitDoc(snap);
  };
  for (const root of roots) {
    if (isCollectionPath(root)) await visitCol(db.collection(root));
    else await visitDoc(await db.doc(root).get());
  }
  return out;
}

async function main() {
  const { db } = require("../../firebaseAdmin");
  const fileArg = process.argv[2] || "";
  validateConfig(CONFIG, fileArg);

  let sinceMs;
  let roots;
  const backedUp = new Set();
  const fileIn = fileArg || CONFIG.BACKUP_FILE;
  if (fileIn) {
    const file = resolveBackupFile(fileIn);
    const { meta } = await scanBackup(file);
    sinceMs = Date.parse(meta.capturedAt);
    // A full backup checks every root collection now, including ones created since.
    roots = meta.full ? [...new Set([...meta.roots, ...(await db.listCollections()).map((c) => c.id)])] : meta.roots;
    for await (const r of backupRecords(file)) if (r.type === "doc") backedUp.add(r.path);
    console.log(`🔍 Changes since ${path.basename(file)} (taken ${meta.capturedAt}) under ${roots.join(", ")}`);
  } else {
    sinceMs = Date.parse(CONFIG.SINCE);
    roots = CONFIG.ROOTS.length ? CONFIG.ROOTS : (await db.listCollections()).map((c) => c.id);
    console.log(`🔍 Changes since ${new Date(sinceMs).toISOString()} under ${roots.join(", ")} (deletions can't be seen without a backup)`);
  }

  const live = await liveTimes(db, roots);
  const result = { since: new Date(sinceMs).toISOString(), created: [], updated: [], deleted: [] };
  for (const p of new Set([...live.keys(), ...backedUp])) {
    const change = changeOf(backedUp.has(p), live.get(p) || null, sinceMs);
    if (change) result[change].push(p);
  }
  for (const k of ["created", "updated", "deleted"]) result[k].sort();

  console.log(`📊 ${live.size} live documents: ${result.created.length} created, ${result.updated.length} updated${fileIn ? `, ${result.deleted.length} deleted` : ""}.`);
  const icons = { created: "➕", updated: "✏️ ", deleted: "🗑️ " };
  for (const k of ["created", "updated", "deleted"]) {
    for (const p of result[k].slice(0, CONFIG.LOG_SAMPLES)) console.log(`   ${icons[k]} ${p}`);
    if (result[k].length > CONFIG.LOG_SAMPLES) console.log(`   … and ${result[k].length - CONFIG.LOG_SAMPLES} more ${k}.`);
  }
  if (CONFIG.OUTPUT_FILE) {
    const out = path.resolve(CONFIG.OUTPUT_FILE);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`📄 Paths written to ${out}`);
  }
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, changeOf };
