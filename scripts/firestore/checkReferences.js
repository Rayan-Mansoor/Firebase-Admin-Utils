// scripts/firestore/checkReferences.js
// Find broken links: fields that name a document (by id, by path, or as a
// DocumentReference) when that document doesn't exist, say an order whose
// customerId points at a deleted user.
//
// Each rule names a field and the collection its ids live in. A field may hold one
// value or a list of them, and with arrayPath it is read from each object of an
// array field. Paths and references are checked as they are; a bare id is looked up
// in the rule's collection. Each target is read once, however many documents name it.
//
// It only reads. OUTPUT_FILE saves every broken link as JSON.
//
// Usage: set CONFIG below and run `node scripts/firestore/checkReferences.js`.

const fs = require("fs");
const path = require("path");
const { DocumentReference } = require("firebase-admin").firestore;
const { isCollectionPath } = require("../../lib/backupFile");
const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath } = require("../../lib/fieldPaths");
const { runMain } = require("../../lib/run");

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: the documents to check (see lib/targets.js)
 * - REFERENCES: rules, each { field, collection, arrayPath? }
 *     field       the field holding an id, path or reference (or a list of them)
 *     collection  where a bare id lives ("users"); paths and references ignore it
 *     arrayPath   read `field` from each object of this array field instead
 * - LOG_SAMPLES: how many broken links per rule to print
 * - OUTPUT_FILE: null, or a path to write every broken link to as JSON
 */
const CONFIG = {
  COLLECTION: "orders",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],

  REFERENCES: [
    { field: "customerId", collection: "users" },
    // { field: "productIds", collection: "products" },                     // a list of ids
    // { field: "productId", collection: "products", arrayPath: "lines" },  // lines[].productId
  ],

  LOG_SAMPLES: 25,
  OUTPUT_FILE: null,
};

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  if (!Array.isArray(cfg.REFERENCES) || !cfg.REFERENCES.length) throw new Error("CONFIG.REFERENCES must list at least one rule.");
  for (const r of cfg.REFERENCES) {
    if (!r || typeof r.field !== "string" || !r.field) throw new Error("Each REFERENCES rule needs a field.");
    if (typeof r.collection !== "string" || r.collection.split("/").some((s) => !s) || !isCollectionPath(r.collection)) {
      throw new Error(`REFERENCES ${r.field}: collection must be a collection path.`);
    }
    if (r.arrayPath !== undefined && (typeof r.arrayPath !== "string" || !r.arrayPath)) throw new Error(`REFERENCES ${r.field}: arrayPath must be a field path.`);
  }
}

/**
 * The document paths one value names under `rule`: [{ target, raw }], or
 * [{ invalid: reason, raw }] for a value that can't name a document.
 */
function targetsOfValue(v, rule) {
  if (v === undefined || v === null || v === "") return [];
  if (Array.isArray(v)) return v.flatMap((x) => targetsOfValue(x, rule));
  if (v instanceof DocumentReference) return [{ target: v.path, raw: `ref(${v.path})` }];
  if (typeof v !== "string") return [{ invalid: `a ${typeof v}, not an id`, raw: String(v) }];
  if (v.includes("/")) {
    const segs = v.split("/");
    return segs.length % 2 === 0 && segs.every(Boolean) ? [{ target: v, raw: v }] : [{ invalid: "not a document path", raw: v }];
  }
  return [{ target: `${rule.collection}/${v}`, raw: v }];
}

/** Every reference one document holds under `rule`: [{ where, target?, invalid?, raw }]. */
function referencesOf(data, rule) {
  if (!rule.arrayPath) return targetsOfValue(getByPath(data, rule.field), rule).map((t) => ({ where: rule.field, ...t }));
  const arr = getByPath(data, rule.arrayPath);
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((item, i) => (item && typeof item === "object"
    ? targetsOfValue(getByPath(item, rule.field), rule).map((t) => ({ where: `${rule.arrayPath}[${i}].${rule.field}`, ...t }))
    : []));
}

async function main() {
  const { db } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🔍 Check ${CONFIG.REFERENCES.map((r) => `${r.arrayPath ? r.arrayPath + "[]." : ""}${r.field} → ${r.collection}`).join(", ")} in ${describeTarget(CONFIG)}`);

  const found = []; // { doc, rule, where, target?, invalid?, raw }
  let scanned = 0;
  for await (const snap of targetDocs(db, CONFIG)) {
    scanned++;
    for (const rule of CONFIG.REFERENCES) for (const ref of referencesOf(snap.data(), rule)) found.push({ doc: snap.ref.path, rule, ...ref });
  }

  const targets = [...new Set(found.filter((f) => f.target).map((f) => f.target))];
  const exists = new Set();
  for (let i = 0; i < targets.length; i += 300) {
    for (const s of await db.getAll(...targets.slice(i, i + 300).map((t) => db.doc(t)))) if (s.exists) exists.add(s.ref.path);
  }
  const broken = found.filter((f) => f.invalid || !exists.has(f.target));
  console.log(`📊 ${scanned} documents, ${found.length} references to ${targets.length} documents; ${broken.length} broken.`);

  for (const rule of CONFIG.REFERENCES) {
    const mine = broken.filter((b) => b.rule === rule);
    if (!mine.length) continue;
    console.log(`\n   🔴 ${rule.arrayPath ? rule.arrayPath + "[]." : ""}${rule.field}: ${mine.length} broken`);
    for (const b of mine.slice(0, CONFIG.LOG_SAMPLES)) console.log(`        ${b.doc} ${b.where} = ${b.raw}: ${b.invalid || `${b.target} doesn't exist`}`);
    if (mine.length > CONFIG.LOG_SAMPLES) console.log(`        … and ${mine.length - CONFIG.LOG_SAMPLES} more`);
  }
  if (CONFIG.OUTPUT_FILE) {
    const out = path.resolve(CONFIG.OUTPUT_FILE);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(broken.map(({ rule, ...b }) => b), null, 2));
    console.log(`📄 Broken links written to ${out}`);
  }
  if (!broken.length) console.log("✅ Every reference points at a document.");
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, targetsOfValue, referencesOf };
