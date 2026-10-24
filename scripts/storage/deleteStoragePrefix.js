// scripts/storage/deleteStoragePrefix.js
// Delete Storage files: everything under the folders in PREFIXES, or exactly the
// files a JSON list names (NAMES_FILE), such as the "orphans" that
// auditStorageReferences.js writes to its OUTPUT_FILE.
//
// What it writes: object deletions. With DOWNLOAD_FIRST, each file is first saved
// under backups/<prefix>-<project>-<time>/ with its path kept.
//
// Why it's safe: the dry run (the default) lists every file and the total size.
// The armed run needs CONFIRM_PROJECT_ID. Storage keeps no copy of a deleted file
// (unless the bucket has versioning), so use DOWNLOAD_FIRST when in doubt.
//
// Usage: set CONFIG below, run `node scripts/storage/deleteStoragePrefix.js`, read
// the list, then set DRY_RUN = false and CONFIRM_PROJECT_ID and run it again.

const fs = require("fs");
const path = require("path");
const { normalizePrefix, validatePrefix } = require("../../lib/storage");
const { BACKUPS_DIR, defaultBackupFilename, formatBytes } = require("../../lib/backupFile");
const { mapWithConcurrency } = require("../../lib/concurrency");
const { banner, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - PREFIXES: folders to delete everything under (["tmp/", "exports/2024/"])
 * - NAMES_FILE: or a JSON file listing the files: an array of names, or an object
 *   whose "orphans" (as auditStorageReferences.js writes) are { name } entries
 * - DOWNLOAD_FIRST: save each file under backups/ before deleting it
 * - CONFIRM_PROJECT_ID: the project id, typed in, for an armed run
 * - DRY_RUN: list without deleting
 * - LOG_SAMPLES: how many files to print
 */
const CONFIG = {
  PREFIXES: [],
  NAMES_FILE: "",
  DOWNLOAD_FIRST: false,
  CONFIRM_PROJECT_ID: "",
  DRY_RUN: true,
  LOG_SAMPLES: 25,
};

const CONCURRENCY = 16;

function validateConfig(cfg = CONFIG) {
  if (!Array.isArray(cfg.PREFIXES)) throw new Error("CONFIG.PREFIXES must be an array.");
  cfg.PREFIXES.forEach((p, i) => validatePrefix(p, `PREFIXES[${i}]`));
  if (!cfg.PREFIXES.length && !cfg.NAMES_FILE) throw new Error("Set PREFIXES or NAMES_FILE.");
  if (cfg.PREFIXES.length && cfg.NAMES_FILE) throw new Error("Use PREFIXES or NAMES_FILE, not both.");
  for (const k of ["DOWNLOAD_FIRST", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** The object names a NAMES_FILE lists. */
function namesFromJson(parsed) {
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.orphans) ? parsed.orphans : null;
  if (!list) throw new Error('NAMES_FILE must hold an array of names, or an object with an "orphans" list.');
  const names = list.map((x) => (typeof x === "string" ? x : x?.name));
  const bad = names.findIndex((n) => typeof n !== "string" || !n || n.startsWith("/"));
  if (bad >= 0) throw new Error(`NAMES_FILE entry ${bad + 1} isn't an object name.`);
  return [...new Set(names)];
}

async function main() {
  const { bucket, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Delete ${CONFIG.NAMES_FILE ? `the files listed in ${CONFIG.NAMES_FILE}` : `everything under ${CONFIG.PREFIXES.map(normalizePrefix).join(", ")}`} in gs://${bucket.name}`);
  banner(CONFIG.DRY_RUN);

  let files;
  const missing = [];
  if (CONFIG.NAMES_FILE) {
    const names = namesFromJson(JSON.parse(fs.readFileSync(path.resolve(CONFIG.NAMES_FILE), "utf8")));
    files = [];
    await mapWithConcurrency(names, CONCURRENCY, async (name) => {
      const f = bucket.file(name);
      const [exists] = await f.exists();
      if (!exists) return missing.push(name);
      const [meta] = await f.getMetadata();
      files.push({ file: f, name, size: Number(meta.size || 0) });
    });
  } else {
    files = [];
    for (const p of CONFIG.PREFIXES.map(normalizePrefix)) {
      const [listed] = await bucket.getFiles({ prefix: p });
      for (const f of listed) files.push({ file: f, name: f.name, size: Number(f.metadata?.size || 0) });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const bytes = files.reduce((n, f) => n + f.size, 0);
  console.log(`📊 ${files.length} files, ${formatBytes(bytes)}${missing.length ? `; ${missing.length} listed files already gone` : ""}.`);
  for (const f of files.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   🗑️  ${f.name} (${formatBytes(f.size)})`);
  if (files.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${files.length - CONFIG.LOG_SAMPLES} more.`);

  if (CONFIG.DRY_RUN || !files.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to delete"}.`);
    return;
  }
  if (CONFIG.CONFIRM_PROJECT_ID !== projectId) {
    throw new Error(`This deletes files. Type the project id into CONFIG.CONFIRM_PROJECT_ID ("${projectId}") to confirm.`);
  }

  if (CONFIG.DOWNLOAD_FIRST) {
    const dir = path.join(BACKUPS_DIR, defaultBackupFilename(projectId, { full: false, prefix: "storage" }).replace(/\.ndjson$/, ""));
    await mapWithConcurrency(files, CONCURRENCY, async (f) => {
      const dest = path.join(dir, f.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await f.file.download({ destination: dest });
    });
    console.log(`💾 ${files.length} files saved under ${dir}`);
  }

  let deleted = 0;
  await mapWithConcurrency(files, CONCURRENCY, async (f) => {
    try {
      await f.file.delete();
      deleted++;
    } catch (err) {
      console.error(`   ❌ ${f.name}: ${err.message}`);
    }
  });
  console.log(`\n✅ Deleted ${deleted} of ${files.length} files.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, namesFromJson };
