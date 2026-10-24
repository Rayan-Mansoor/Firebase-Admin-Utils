// scripts/storage/storageUsage.js
// See where Storage space goes: file count and total size per folder, DEPTH levels
// below PREFIX (1 = its direct subfolders), largest first, with a breakdown by
// content type.
//
// It only reads (object listings, no downloads).
//
// Usage: set CONFIG below and run `node scripts/storage/storageUsage.js`.

const { normalizePrefix, validatePrefix } = require("../../lib/storage");
const { formatBytes } = require("../../lib/backupFile");
const { runMain } = require("../../lib/run");

/**
 * CONFIG
 * - PREFIX: the folder to look inside ("" = the whole bucket)
 * - DEPTH: how many folder levels below PREFIX to group by (1, 2, …)
 * - TOP: how many folders and content types to print
 */
const CONFIG = {
  PREFIX: "",
  DEPTH: 1,
  TOP: 30,
};

function validateConfig(cfg = CONFIG) {
  if (cfg.PREFIX !== "") validatePrefix(cfg.PREFIX, "PREFIX");
  if (!Number.isInteger(cfg.DEPTH) || cfg.DEPTH < 1) throw new Error("CONFIG.DEPTH must be a whole number ≥ 1.");
  if (!Number.isInteger(cfg.TOP) || cfg.TOP < 1) throw new Error("CONFIG.TOP must be a whole number ≥ 1.");
}

/** The folder an object counts under: up to `depth` segments below the prefix; files right in it count as "(files here)". */
function folderOf(name, prefix, depth) {
  const parts = name.slice(prefix.length).split("/");
  if (parts.length === 1) return `${prefix}(files here)`;
  return prefix + parts.slice(0, Math.min(depth, parts.length - 1)).join("/") + "/";
}

/** Totals by key: [{ key, count, bytes }], largest first. */
function tally(files, keyOf) {
  const totals = new Map();
  for (const f of files) {
    const k = keyOf(f);
    const t = totals.get(k) || { key: k, count: 0, bytes: 0 };
    t.count++;
    t.bytes += f.size;
    totals.set(k, t);
  }
  return [...totals.values()].sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
}

function printTable(title, rows, top) {
  console.log(`\n${title}`);
  const width = Math.max(...rows.slice(0, top).map((r) => r.key.length), 6);
  for (const r of rows.slice(0, top)) console.log(`   ${r.key.padEnd(width)}  ${formatBytes(r.bytes).padStart(9)}  ${String(r.count).padStart(7)} files`);
  if (rows.length > top) console.log(`   … and ${rows.length - top} more.`);
}

async function main() {
  const { bucket } = require("../../firebaseAdmin");
  validateConfig();
  const prefix = CONFIG.PREFIX ? normalizePrefix(CONFIG.PREFIX) : "";
  const [listed] = await bucket.getFiles({ prefix });
  const files = listed.filter((f) => !f.name.endsWith("/")).map((f) => ({
    name: f.name, size: Number(f.metadata?.size || 0), contentType: f.metadata?.contentType || "(unknown)",
  }));
  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(`📊 gs://${bucket.name}/${prefix}: ${files.length} files, ${formatBytes(total)}.`);
  if (!files.length) return;
  printTable(`By folder (${CONFIG.DEPTH} level${CONFIG.DEPTH > 1 ? "s" : ""} deep):`, tally(files, (f) => folderOf(f.name, prefix, CONFIG.DEPTH)), CONFIG.TOP);
  printTable("By content type:", tally(files, (f) => f.contentType), CONFIG.TOP);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, folderOf, tally };
