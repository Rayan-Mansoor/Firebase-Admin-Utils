// scripts/firestore/findDuplicates.js
// Find documents that share a value: two accounts with one email, a product
// entered twice, the same name spelt with different case. FIELDS can be one field
// or several taken together ("firstName" + "lastName").
//
// Values are compared after the normalising you choose: case, surrounding and
// repeated spaces, accents. Documents missing a field (or holding an empty value)
// are left out unless INCLUDE_EMPTY is on.
//
// It only reads. OUTPUT_FILE saves every group as JSON.
//
// Usage: set CONFIG below and run `node scripts/firestore/findDuplicates.js`.

const fs = require("fs");
const path = require("path");
const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath } = require("../../lib/fieldPaths");
const { preview, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: which documents (see lib/targets.js)
 * - FIELDS: field paths whose values together must match (["email"], ["firstName", "lastName"])
 * - IGNORE_CASE, IGNORE_SPACES (trim and collapse), IGNORE_ACCENTS: how strings are compared
 * - INCLUDE_EMPTY: also group documents where a field is missing or empty
 * - LOG_SAMPLES: how many groups to print
 * - OUTPUT_FILE: null, or a path to write every group to as JSON
 */
const CONFIG = {
  COLLECTION: "users",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],

  FIELDS: ["email"],
  IGNORE_CASE: true,
  IGNORE_SPACES: true,
  IGNORE_ACCENTS: false,
  INCLUDE_EMPTY: false,

  LOG_SAMPLES: 25,
  OUTPUT_FILE: null,
};

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  if (!Array.isArray(cfg.FIELDS) || !cfg.FIELDS.length || cfg.FIELDS.some((f) => typeof f !== "string" || !f)) {
    throw new Error("CONFIG.FIELDS must list at least one field path.");
  }
  for (const k of ["IGNORE_CASE", "IGNORE_SPACES", "IGNORE_ACCENTS", "INCLUDE_EMPTY"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** One value as compared: strings normalised as configured, anything else as its JSON. */
function comparable(v, cfg) {
  if (typeof v !== "string") return preview(v, 10000);
  let s = v;
  if (cfg.IGNORE_ACCENTS) s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (cfg.IGNORE_SPACES) s = s.replace(/\s+/g, " ").trim();
  if (cfg.IGNORE_CASE) s = s.toLowerCase();
  return JSON.stringify(s);
}

const isEmpty = (v) => v === undefined || v === null || (typeof v === "string" && !v.trim());

/** The grouping key of a document, or null when it has an empty field and those are left out. */
function keyOf(data, cfg) {
  const values = cfg.FIELDS.map((f) => getByPath(data, f));
  if (!cfg.INCLUDE_EMPTY && values.some(isEmpty)) return null;
  return values.map((v) => comparable(v, cfg)).join(" + ");
}

/** Groups of two or more: [{ key, docs: [{ path, values }] }], largest first. */
function groupDuplicates(docs, cfg) {
  const groups = new Map();
  for (const d of docs) {
    const key = keyOf(d.data, cfg);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ path: d.path, values: cfg.FIELDS.map((f) => getByPath(d.data, f)) });
  }
  return [...groups].filter(([, g]) => g.length > 1)
    .map(([key, g]) => ({ key, docs: g }))
    .sort((a, b) => b.docs.length - a.docs.length || a.key.localeCompare(b.key));
}

async function main() {
  const { db } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🔍 Duplicates of ${CONFIG.FIELDS.join(" + ")} in ${describeTarget(CONFIG)}`);
  const docs = [];
  for await (const snap of targetDocs(db, CONFIG)) docs.push({ path: snap.ref.path, data: snap.data() });
  const groups = groupDuplicates(docs, CONFIG);
  const dupDocs = groups.reduce((n, g) => n + g.docs.length, 0);
  console.log(`📊 ${docs.length} documents; ${groups.length} values shared, by ${dupDocs} documents.`);
  for (const g of groups.slice(0, CONFIG.LOG_SAMPLES)) {
    console.log(`   👥 ${g.key} (${g.docs.length})`);
    for (const d of g.docs.slice(0, 10)) console.log(`        ${d.path}: ${d.values.map((v) => preview(v, 60)).join(" + ")}`);
    if (g.docs.length > 10) console.log(`        … and ${g.docs.length - 10} more`);
  }
  if (groups.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${groups.length - CONFIG.LOG_SAMPLES} more groups.`);
  if (CONFIG.OUTPUT_FILE) {
    const out = path.resolve(CONFIG.OUTPUT_FILE);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(groups.map((g) => ({ key: g.key, paths: g.docs.map((d) => d.path) })), null, 2));
    console.log(`📄 Groups written to ${out}`);
  }
  if (!groups.length) console.log("✅ No duplicates.");
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, comparable, keyOf, groupDuplicates };
