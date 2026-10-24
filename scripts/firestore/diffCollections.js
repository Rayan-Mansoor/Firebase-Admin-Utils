// scripts/firestore/diffCollections.js
// Compare two sets of documents field by field: two live collections (a copy
// against its source), or a live collection against the same collection in a
// backup file (what changed since the backup). Documents are paired by their
// path below the collection, so subcollections pair up too.
//
// It reports the documents only on one side, and for each document on both sides
// every field that differs (nested fields by dotted path; lists compared whole).
// It only reads.
//
// Usage: set CONFIG below and run `node scripts/firestore/diffCollections.js`.

const fs = require("fs");
const path = require("path");
const { isCollectionPath, pathIsUnder, decodeValue, backupRecords, resolveBackupFile } = require("../../lib/backupFile");
const { isMap, sameValue } = require("../../lib/fieldPaths");
const { preview, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - LEFT, RIGHT: each { collection: "users" } for a live collection, or
 *   { collection: "users", backupFile: "backups/<file>.ndjson" } for that collection
 *   as a backup file holds it
 * - INCLUDE_SUBCOLLECTIONS: also compare the documents of subcollections, at any depth
 * - IGNORE_FIELDS: dotted field paths left out of the comparison (["updatedAt"])
 * - LOG_SAMPLES: how many documents of each kind to print
 * - OUTPUT_FILE: null, or a path to write the full report to as JSON
 */
const CONFIG = {
  LEFT: { collection: "users" },
  RIGHT: { collection: "users_copy" },
  INCLUDE_SUBCOLLECTIONS: false,
  IGNORE_FIELDS: [],
  LOG_SAMPLES: 20,
  OUTPUT_FILE: null,
};

function validateSide(side, name) {
  if (!side || typeof side.collection !== "string" || side.collection.split("/").some((s) => !s) || !isCollectionPath(side.collection)) {
    throw new Error(`CONFIG.${name}.collection must be a collection path.`);
  }
  if (side.backupFile !== undefined && (typeof side.backupFile !== "string" || !side.backupFile)) {
    throw new Error(`CONFIG.${name}.backupFile must be a path.`);
  }
}

function validateConfig(cfg = CONFIG) {
  validateSide(cfg.LEFT, "LEFT");
  validateSide(cfg.RIGHT, "RIGHT");
  if (!cfg.LEFT.backupFile && !cfg.RIGHT.backupFile && cfg.LEFT.collection === cfg.RIGHT.collection) {
    throw new Error("LEFT and RIGHT are the same live collection.");
  }
  if (!Array.isArray(cfg.IGNORE_FIELDS)) throw new Error("CONFIG.IGNORE_FIELDS must be an array.");
  if (typeof cfg.INCLUDE_SUBCOLLECTIONS !== "boolean") throw new Error("CONFIG.INCLUDE_SUBCOLLECTIONS must be boolean.");
}

/** A doc path relative to its collection ("a", "a/posts/1"), or null when it isn't one to compare. */
function relativePath(docPath, collection, withSubs) {
  if (!pathIsUnder(docPath, collection) || docPath === collection) return null;
  const rel = docPath.slice(collection.length + 1);
  return withSubs || !rel.includes("/") ? rel : null;
}

/** Every field that differs: [{ field, left, right }]; undefined on a side means absent there. */
function diffData(left, right, ignore = [], prefix = "") {
  const out = [];
  const keys = [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])].sort();
  for (const k of keys) {
    const field = prefix ? `${prefix}.${k}` : k;
    if (ignore.includes(field)) continue;
    const a = left?.[k];
    const b = right?.[k];
    if (isMap(a) && isMap(b)) out.push(...diffData(a, b, ignore, field));
    else if (!sameValue(a, b)) out.push({ field, left: a, right: b });
  }
  return out;
}

/** Pair the two sides: { onlyLeft, onlyRight, changed: [{ path, diffs }], same }. */
function compare(leftDocs, rightDocs, ignore = []) {
  const onlyLeft = [];
  const changed = [];
  let same = 0;
  for (const [p, data] of leftDocs) {
    if (!rightDocs.has(p)) {
      onlyLeft.push(p);
      continue;
    }
    const diffs = diffData(data, rightDocs.get(p), ignore);
    if (diffs.length) changed.push({ path: p, diffs });
    else same++;
  }
  const onlyRight = [...rightDocs.keys()].filter((p) => !leftDocs.has(p));
  return { onlyLeft: onlyLeft.sort(), onlyRight: onlyRight.sort(), changed, same };
}

/** relative path → data, from a live collection. */
async function liveDocs(db, collection, withSubs) {
  const out = new Map();
  const walk = async (colRef) => {
    const refs = await colRef.listDocuments();
    for (let i = 0; i < refs.length; i += 300) {
      for (const snap of await db.getAll(...refs.slice(i, i + 300))) {
        if (snap.exists) out.set(relativePath(snap.ref.path, collection, true), snap.data());
        if (withSubs) for (const sub of await snap.ref.listCollections()) await walk(sub);
      }
    }
  };
  await walk(db.collection(collection));
  return out;
}

/** relative path → data, from the docs of a backup file under the collection. */
async function backupDocs(db, file, collection, withSubs) {
  const out = new Map();
  for await (const r of backupRecords(resolveBackupFile(file))) {
    if (r.type !== "doc") continue;
    const rel = relativePath(r.path, collection, withSubs);
    if (rel !== null) out.set(rel, decodeValue(r.data, r.path, db));
  }
  return out;
}

const sideName = (s) => (s.backupFile ? `${s.collection} in ${path.basename(s.backupFile)}` : `${s.collection} (live)`);

async function main() {
  const { db } = require("../../firebaseAdmin");
  validateConfig();
  const load = (s) => (s.backupFile ? backupDocs(db, s.backupFile, s.collection, CONFIG.INCLUDE_SUBCOLLECTIONS) : liveDocs(db, s.collection, CONFIG.INCLUDE_SUBCOLLECTIONS));
  console.log(`🔍 Compare ${sideName(CONFIG.LEFT)}  ⟷  ${sideName(CONFIG.RIGHT)}`);
  const [left, right] = await Promise.all([load(CONFIG.LEFT), load(CONFIG.RIGHT)]);
  const r = compare(left, right, CONFIG.IGNORE_FIELDS);

  console.log(`📊 ${left.size} left, ${right.size} right: ${r.same} the same, ${r.changed.length} different, ${r.onlyLeft.length} only left, ${r.onlyRight.length} only right.`);
  const n = CONFIG.LOG_SAMPLES;
  for (const p of r.onlyLeft.slice(0, n)) console.log(`   ⬅️  only left:  ${p}`);
  for (const p of r.onlyRight.slice(0, n)) console.log(`   ➡️  only right: ${p}`);
  for (const c of r.changed.slice(0, n)) {
    console.log(`   ✏️  ${c.path}`);
    for (const d of c.diffs.slice(0, 15)) console.log(`        ${d.field}: ${d.left === undefined ? "(absent)" : preview(d.left, 60)}  →  ${d.right === undefined ? "(absent)" : preview(d.right, 60)}`);
    if (c.diffs.length > 15) console.log(`        … and ${c.diffs.length - 15} more fields`);
  }
  const hidden = Math.max(0, r.onlyLeft.length - n) + Math.max(0, r.onlyRight.length - n) + Math.max(0, r.changed.length - n);
  if (hidden) console.log(`   … ${hidden} more not shown${CONFIG.OUTPUT_FILE ? "" : " (set OUTPUT_FILE for all of them)"}.`);

  if (CONFIG.OUTPUT_FILE) {
    const file = path.resolve(CONFIG.OUTPUT_FILE);
    const report = { ...r, changed: r.changed.map((c) => ({ path: c.path, diffs: c.diffs.map((d) => ({ field: d.field, left: preview(d.left, 10000), right: preview(d.right, 10000) })) })) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`📄 Full report: ${file}`);
  }
  if (!r.changed.length && !r.onlyLeft.length && !r.onlyRight.length) console.log("✅ Identical.");
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, relativePath, diffData, compare };
