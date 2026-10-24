// scripts/firestore/importCollection.js
// Load documents into a collection from a JSON or CSV file: seed data, a
// spreadsheet export, or another system's dump.
//
//   JSON  an array of objects, or an object of { id: object }. Values may use the
//         backup format's "$fst" tags (lib/backupFile.js) for Timestamps,
//         references, GeoPoints and bytes.
//   CSV   a header row, then one row per document. Cells are strings unless TYPES
//         says otherwise; a header like "address.city" builds a nested map.
//
// What it writes: one document per row, its id from ID_FIELD (or a new auto id).
// MODE "create" only creates (an existing id is skipped), "merge" also updates
// existing documents field by field, "overwrite" replaces them whole.
//
// Why it's safe: the dry run (the default) parses the whole file and lists what
// would be created, updated or skipped, and any bad rows; nothing runs while a
// row is bad. The armed run saves every existing document it will change into
// backups/ first, and a merge update is refused if the document changed after it
// was read.
//
// Usage: set CONFIG below, run `node scripts/firestore/importCollection.js`, read
// the plan, then set DRY_RUN = false and run it again.

const fs = require("fs");
const path = require("path");
const { Timestamp } = require("firebase-admin").firestore;
const { isCollectionPath, decodeValue } = require("../../lib/backupFile");
const { parseCsv } = require("../../lib/csv");
const { isMap, setByPath } = require("../../lib/fieldPaths");
const { saveBeforeState } = require("../../lib/beforeState");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, preview, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - FILE: path to a .json or .csv file (first CLI arg overrides)
 * - COLLECTION: the collection to write to ("products", "shops/abc/products")
 * - ID_FIELD: the field holding each document's id, or null for auto ids (a rerun
 *   then imports everything again). For a JSON object of { id: object }, the keys are the ids.
 * - KEEP_ID_FIELD: also store ID_FIELD inside the document
 * - MODE: "create" | "merge" | "overwrite"
 * - TYPES: CSV only, { column: "string"|"number"|"int"|"boolean"|"timestamp"|"json" }
 * - EMPTY_CELLS: CSV only, what an empty cell becomes: "omit" | "null" | "empty-string"
 * - DRY_RUN: parse and plan without writing
 * - LOG_SAMPLES: how many documents to print (0 = none)
 */
const CONFIG = {
  FILE: "",
  COLLECTION: "products",
  ID_FIELD: "id",
  KEEP_ID_FIELD: false,
  MODE: "create",
  TYPES: {},
  EMPTY_CELLS: "omit",
  DRY_RUN: true,
  LOG_SAMPLES: 5,
};

const MODES = ["create", "merge", "overwrite"];
const TYPES = ["string", "number", "int", "boolean", "timestamp", "json"];
const EMPTY = ["omit", "null", "empty-string"];

function validateConfig(cfg = CONFIG) {
  if (!cfg.COLLECTION || typeof cfg.COLLECTION !== "string" || cfg.COLLECTION.split("/").some((s) => !s) || !isCollectionPath(cfg.COLLECTION)) {
    throw new Error("CONFIG.COLLECTION must be a collection path.");
  }
  if (cfg.ID_FIELD !== null && (typeof cfg.ID_FIELD !== "string" || !cfg.ID_FIELD)) throw new Error("CONFIG.ID_FIELD must be a field name or null.");
  if (!MODES.includes(cfg.MODE)) throw new Error(`CONFIG.MODE must be one of ${MODES.join(", ")}.`);
  if (!isMap(cfg.TYPES)) throw new Error("CONFIG.TYPES must be an object.");
  for (const [col, t] of Object.entries(cfg.TYPES)) {
    if (!TYPES.includes(t)) throw new Error(`TYPES.${col}: "${t}" is not one of ${TYPES.join(", ")}.`);
  }
  if (!EMPTY.includes(cfg.EMPTY_CELLS)) throw new Error(`CONFIG.EMPTY_CELLS must be one of ${EMPTY.join(", ")}.`);
  for (const k of ["KEEP_ID_FIELD", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** One CSV cell as TYPES says. Throws on a cell that isn't that type. */
function convertCell(raw, type, where) {
  const s = raw.trim();
  switch (type || "string") {
    case "string": return raw;
    case "number": {
      const n = Number(s);
      if (s === "" || !Number.isFinite(n)) throw new Error(`${where}: "${raw}" is not a number.`);
      return n;
    }
    case "int": {
      const n = Number(s);
      if (s === "" || !Number.isInteger(n)) throw new Error(`${where}: "${raw}" is not a whole number.`);
      return n;
    }
    case "boolean": {
      const b = { true: true, yes: true, 1: true, false: false, no: false, 0: false }[s.toLowerCase()];
      if (b === undefined) throw new Error(`${where}: "${raw}" is not true/false.`);
      return b;
    }
    case "timestamp": {
      const ms = /^-?\d+$/.test(s) ? Number(s) : Date.parse(s);
      if (Number.isNaN(ms)) throw new Error(`${where}: "${raw}" is not a date.`);
      return Timestamp.fromMillis(ms);
    }
    case "json":
      try {
        return JSON.parse(s);
      } catch {
        throw new Error(`${where}: "${raw}" is not JSON.`);
      }
    default:
      throw new Error(`Unknown type ${type}`);
  }
}

/** A CSV row as document data: typed cells, empty cells per EMPTY_CELLS, dotted headers nested. */
function rowFromCsv(row, cfg, rowNo) {
  const data = {};
  for (const [col, raw] of Object.entries(row)) {
    if (raw === "" && col !== cfg.ID_FIELD) {
      if (cfg.EMPTY_CELLS === "omit") continue;
      setByPath(data, col, cfg.EMPTY_CELLS === "null" ? null : "");
      continue;
    }
    setByPath(data, col, col === cfg.ID_FIELD ? raw : convertCell(raw, cfg.TYPES[col], `row ${rowNo}, ${col}`));
  }
  return data;
}

/** The file's records as [{ data, idKey? }], idKey being a JSON object's own key. */
function recordsOf(text, ext, cfg, db) {
  if (ext === ".csv") return parseCsv(text).map((row, i) => ({ data: rowFromCsv(row, cfg, i + 2) }));
  if (ext !== ".json") throw new Error(`Can't import "${ext}" files: use .json or .csv.`);
  const parsed = JSON.parse(text);
  const decode = (v, where) => decodeValue(v, where, db);
  if (Array.isArray(parsed)) return parsed.map((o, i) => ({ data: decode(o, `[${i}]`) }));
  if (isMap(parsed)) return Object.entries(parsed).map(([k, o]) => ({ data: decode(o, k), idKey: k }));
  throw new Error("A JSON file must hold an array of objects or an object of { id: object }.");
}

/** [{ id|null, data }] from the records, and the problems that stop the import. */
function planRecords(records, cfg) {
  const docs = [];
  const problems = [];
  const seen = new Set();
  records.forEach((r, i) => {
    const where = r.idKey !== undefined ? `"${r.idKey}"` : `record ${i + 1}`;
    if (!isMap(r.data)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const data = { ...r.data };
    let id = r.idKey ?? null;
    if (id === null && cfg.ID_FIELD !== null) {
      id = data[cfg.ID_FIELD];
      if (id === undefined || id === null || String(id).trim() === "") {
        problems.push(`${where}: no ${cfg.ID_FIELD}`);
        return;
      }
      id = String(id).trim();
      if (id.includes("/") || id === "." || id === ".." || /^__.*__$/.test(id)) {
        problems.push(`${where}: "${id}" can't be a document id`);
        return;
      }
      if (!cfg.KEEP_ID_FIELD) delete data[cfg.ID_FIELD];
    }
    if (id !== null) {
      if (seen.has(id)) {
        problems.push(`${where}: id "${id}" appears twice`);
        return;
      }
      seen.add(id);
    }
    docs.push({ id, data });
  });
  return { docs, problems };
}

/** A map's leaves as dotted update paths, so a merge changes only the fields given. */
function flatten(data, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(data)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isMap(v) && Object.keys(v).length) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  const fileArg = process.argv[2] || CONFIG.FILE;
  if (!fileArg) throw new Error("No file given. Pass it as the first CLI arg or set CONFIG.FILE.");
  const file = path.resolve(fileArg);
  console.log(`🚀 Import ${path.relative(process.cwd(), file)} into '${CONFIG.COLLECTION}' (${CONFIG.MODE})`);
  banner(CONFIG.DRY_RUN);

  const records = recordsOf(fs.readFileSync(file, "utf8"), path.extname(file).toLowerCase(), CONFIG, db);
  const { docs, problems } = planRecords(records, CONFIG);
  if (problems.length) {
    for (const p of problems.slice(0, 50)) console.log(`   🔴 ${p}`);
    throw new Error(`${problems.length} records can't be imported; fix the file. Nothing was written.`);
  }

  const col = db.collection(CONFIG.COLLECTION);
  const existing = new Map();
  const withIds = docs.filter((d) => d.id !== null);
  for (let i = 0; i < withIds.length; i += 300) {
    for (const s of await db.getAll(...withIds.slice(i, i + 300).map((d) => col.doc(d.id)))) if (s.exists) existing.set(s.id, s);
  }

  const writes = [];
  let skipped = 0;
  for (const d of docs) {
    const snap = d.id !== null ? existing.get(d.id) : undefined;
    const ref = d.id !== null ? col.doc(d.id) : col.doc();
    if (!snap) writes.push({ op: "create", path: ref.path, data: d.data });
    else if (CONFIG.MODE === "create") skipped++;
    else if (CONFIG.MODE === "merge") writes.push({ op: "update", path: ref.path, data: flatten(d.data), lastUpdateTime: snap.updateTime, snap });
    else writes.push({ op: "set", path: ref.path, data: d.data, snap });
  }
  const creates = writes.filter((w) => w.op === "create").length;
  const changed = writes.filter((w) => w.snap);
  console.log(`📊 ${docs.length} records: ${creates} to create, ${changed.length} existing to ${CONFIG.MODE === "merge" ? "merge into" : "overwrite"}, ${skipped} existing skipped.`);
  if (CONFIG.ID_FIELD === null) console.log("   ⚠️  Auto ids: running this again imports every record again.");
  for (const w of writes.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   ${w.op === "create" ? "➕" : "✏️ "} ${w.path}: ${preview(w.data)}`);
  if (writes.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${writes.length - CONFIG.LOG_SAMPLES} more.`);

  if (CONFIG.DRY_RUN || !writes.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to write"}.`);
    return;
  }

  if (changed.length) console.log(`💾 Before-state saved: ${await saveBeforeState(changed.map((w) => w.snap), { projectId, prefix: "import-collection" })}`);
  const { done, failures } = await applyWrites(db, writes.map(({ snap, ...w }) => w));
  printFailures(failures);
  console.log(`\n✅ Wrote ${done} of ${writes.length} documents.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, convertCell, rowFromCsv, recordsOf, planRecords, flatten };
