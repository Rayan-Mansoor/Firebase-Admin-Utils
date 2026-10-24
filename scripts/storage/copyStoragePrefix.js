// scripts/storage/copyStoragePrefix.js
// Copy, or move, every Cloud Storage object under one folder (prefix) to another,
// keeping the paths below it: "avatars/u1/a.png" under "avatars/" lands at
// "profile-images/u1/a.png".
//
// What it writes: a copy of each object, metadata included. A destination object
// that already exists is skipped unless OVERWRITE_EXISTING is on, since Storage
// keeps no copy of what an overwrite replaces (unless the bucket has versioning).
//
// With DELETE_SOURCE it is a move: each original is deleted once its own copy has
// landed; one that was skipped or failed stays.
//
// Why it's safe: the dry run (the default) lists the copies and the existing
// objects that would be skipped or overwritten. Without DELETE_SOURCE, originals
// are never touched.
//
// Usage: set CONFIG below, run `node scripts/storage/copyStoragePrefix.js`, read
// the plan, then set DRY_RUN = false and run it again.

const { normalizePrefix, validatePrefix, peekBucket } = require("../../lib/storage");
const { banner, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - FROM_PREFIX: the folder to copy from ("avatars/")
 * - TO_PREFIX: the folder to copy to ("profile-images/")
 * - OVERWRITE_EXISTING: replace destination objects that already exist (they can't be recovered)
 * - DELETE_SOURCE: move instead of copy: delete each original after its copy lands
 * - DRY_RUN: list without copying
 * - LOG_SAMPLES: how many copies to print
 */
const CONFIG = {
  FROM_PREFIX: "uploads/",
  TO_PREFIX: "uploads-copy/",
  OVERWRITE_EXISTING: false,
  DELETE_SOURCE: false,
  DRY_RUN: true,
  LOG_SAMPLES: 25,
};

function validateConfig(cfg = CONFIG) {
  validatePrefix(cfg.FROM_PREFIX, "FROM_PREFIX");
  validatePrefix(cfg.TO_PREFIX, "TO_PREFIX");
  const from = normalizePrefix(cfg.FROM_PREFIX);
  const to = normalizePrefix(cfg.TO_PREFIX);
  if (from === to) throw new Error("FROM_PREFIX and TO_PREFIX must differ.");
  if (to.startsWith(from) || from.startsWith(to)) throw new Error("FROM_PREFIX and TO_PREFIX can't be nested in each other.");
  for (const k of ["OVERWRITE_EXISTING", "DELETE_SOURCE", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** Where an object lands: the same path below the destination folder; null for the folder placeholder itself. */
function destNameOf(name, from, to) {
  const rel = name.slice(from.length);
  return rel ? to + rel : null;
}

/** The copy plan: { copies: [{ from, to }], existing: [to] }. */
async function planCopies(bucket, cfg) {
  const from = normalizePrefix(cfg.FROM_PREFIX);
  const to = normalizePrefix(cfg.TO_PREFIX);
  const [files] = await bucket.getFiles({ prefix: from });
  const [destFiles] = await bucket.getFiles({ prefix: to });
  const destNames = new Set(destFiles.map((f) => f.name));
  const copies = [];
  const existing = [];
  for (const f of files) {
    const dest = destNameOf(f.name, from, to);
    if (!dest) continue;
    if (destNames.has(dest)) existing.push(dest);
    if (!destNames.has(dest) || cfg.OVERWRITE_EXISTING) copies.push({ from: f.name, to: dest });
  }
  return { copies, existing, sourceCount: files.length };
}

async function main() {
  const { bucket } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 ${CONFIG.DELETE_SOURCE ? "Move" : "Copy"} gs://${bucket.name}/${normalizePrefix(CONFIG.FROM_PREFIX)} → ${normalizePrefix(CONFIG.TO_PREFIX)}`);
  banner(CONFIG.DRY_RUN);

  const { copies, existing, sourceCount } = await planCopies(bucket, CONFIG);
  if (!sourceCount) {
    console.log("ℹ️  No objects under that prefix.");
    await peekBucket(bucket);
    return;
  }
  console.log(`📊 ${sourceCount} objects; ${copies.length} to copy; ${existing.length} already at the destination (${CONFIG.OVERWRITE_EXISTING ? "overwritten" : "skipped"}).`);
  for (const c of copies.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   → ${c.from}  ->  ${c.to}`);
  if (copies.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${copies.length - CONFIG.LOG_SAMPLES} more.`);
  for (const e of existing.slice(0, 10)) console.log(`   ${CONFIG.OVERWRITE_EXISTING ? "⚠️  overwrites" : "⏭️  skips"} ${e}`);

  if (CONFIG.DRY_RUN || !copies.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to copy"}.`);
    return;
  }

  const landed = [];
  for (const c of copies) {
    try {
      await bucket.file(c.from).copy(bucket.file(c.to));
      landed.push(c);
    } catch (err) {
      console.error(`   ❌ ${c.from}: ${err.message}`);
    }
  }
  console.log(`\n✅ Copied ${landed.length} of ${copies.length} objects.`);
  if (!CONFIG.DELETE_SOURCE) return;
  let deleted = 0;
  for (const c of landed) {
    try {
      await bucket.file(c.from).delete();
      deleted++;
    } catch (err) {
      console.error(`   ❌ couldn't delete ${c.from}: ${err.message}`);
    }
  }
  const kept = copies.length - landed.length + (CONFIG.OVERWRITE_EXISTING ? 0 : existing.length);
  console.log(`🗑️  Deleted ${deleted} originals${kept ? `; ${kept} not copied stay` : ""}.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, destNameOf, planCopies };
