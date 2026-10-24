// scripts/firestore/linkByLabel.js
// Turn names stored as free text into links: for each document, find the one
// document in LOOKUP_COLLECTION whose label matches its LABEL_FIELD, and write that
// document's id (or path, or a reference) into ID_FIELD. Works on a top-level field,
// or on each object inside an array field (ARRAY_PATH).
//
// Names match after normalising: accents dropped, spacing collapsed, case ignored.
// A name that matches several lookup documents is ambiguous and is reported,
// never guessed; a name that matches none is reported with near misses, which
// are never applied either.
//
// What it writes: ID_FIELD where a name matches exactly one lookup document and
// ID_FIELD isn't set yet (or with OVERWRITE). The names themselves are not touched.
//
// Why it's safe: the dry run (the default) shows the exact / ambiguous / unmatched
// split. The armed run saves every document it changes into backups/ first, and
// each update is refused if the document changed after it was read.
//
// Usage: set CONFIG below, run `node scripts/firestore/linkByLabel.js`, fix names or
// labels until the split looks right, then set DRY_RUN = false and run it again.

const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath } = require("../../lib/fieldPaths");
const { saveBeforeState } = require("../../lib/beforeState");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: the documents to link (see lib/targets.js)
 * - ARRAY_PATH: null, or an array field whose objects hold the name (e.g. "slots")
 * - LABEL_FIELD: the field holding the name ("teacherName"; inside each item with ARRAY_PATH)
 * - ID_FIELD: the field to write the link into ("teacherId")
 * - LOOKUP_COLLECTION: the collection to match names against ("teachers")
 * - LOOKUP_LABEL_FIELDS: fields of a lookup document that name it (["name"]; several allowed)
 * - WRITE: "id" | "path" | "reference": what ID_FIELD gets
 * - OVERWRITE: also relink where ID_FIELD is already set
 * - DRY_RUN: report without writing
 */
const CONFIG = {
  COLLECTION: "lessons",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],

  ARRAY_PATH: null,
  LABEL_FIELD: "teacherName",
  ID_FIELD: "teacherId",

  LOOKUP_COLLECTION: "teachers",
  LOOKUP_LABEL_FIELDS: ["name"],

  WRITE: "id",
  OVERWRITE: false,
  DRY_RUN: true,
};

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  for (const k of ["LABEL_FIELD", "ID_FIELD", "LOOKUP_COLLECTION"]) {
    if (typeof cfg[k] !== "string" || !cfg[k]) throw new Error(`CONFIG.${k} must be a non-empty string.`);
  }
  if (cfg.LABEL_FIELD === cfg.ID_FIELD) throw new Error("LABEL_FIELD and ID_FIELD must differ.");
  if (cfg.ARRAY_PATH !== null && (typeof cfg.ARRAY_PATH !== "string" || !cfg.ARRAY_PATH)) throw new Error("CONFIG.ARRAY_PATH must be a field path or null.");
  if (!Array.isArray(cfg.LOOKUP_LABEL_FIELDS) || !cfg.LOOKUP_LABEL_FIELDS.length) throw new Error("CONFIG.LOOKUP_LABEL_FIELDS must list at least one field.");
  if (!["id", "path", "reference"].includes(cfg.WRITE)) throw new Error('CONFIG.WRITE must be "id", "path" or "reference".');
  for (const k of ["OVERWRITE", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** A name as it is compared: accents dropped, spacing collapsed, lower case. */
function normalize(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Lookup documents by normalized label. `lookups` is [{ id, path, data }]. */
function buildIndex(lookups, labelFields) {
  const byKey = new Map();
  const labelOf = new Map();
  for (const doc of lookups) {
    for (const f of labelFields) {
      const label = getByPath(doc.data, f);
      if (typeof label !== "string" || !normalize(label)) continue;
      const key = normalize(label);
      if (!byKey.has(key)) byKey.set(key, []);
      if (!byKey.get(key).some((d) => d.path === doc.path)) byKey.get(key).push(doc);
      if (!labelOf.has(doc.path)) labelOf.set(doc.path, label);
    }
  }
  return { byKey, labelOf };
}

/** Near misses for a name nothing matched: advisory, never applied. */
function suggest(key, index) {
  const first = key.split(" ")[0];
  const hits = [];
  for (const [k, docs] of index.byKey) {
    if (k.startsWith(key) || key.startsWith(k) || k.split(" ")[0] === first) hits.push(...docs.map((d) => index.labelOf.get(d.path)));
  }
  return [...new Set(hits)].slice(0, 3);
}

/** { status: "exact", doc } | { status: "ambiguous", docs } | { status: "unmatched", suggestions } | { status: "blank" } */
function classify(name, index) {
  const key = normalize(name);
  if (!key) return { status: "blank" };
  const docs = index.byKey.get(key) || [];
  if (docs.length === 1) return { status: "exact", doc: docs[0] };
  if (docs.length > 1) return { status: "ambiguous", docs };
  return { status: "unmatched", suggestions: suggest(key, index) };
}

/**
 * One document's links: { update, results }, results [{ where, name, status, ... }].
 * `linkValue(doc)` gives what ID_FIELD gets for a matched lookup doc.
 */
function planDoc(data, index, cfg, linkValue) {
  const results = [];
  const linkOne = (holder, where) => {
    const name = getByPath(holder, cfg.LABEL_FIELD);
    if (name === undefined) return null;
    if (getByPath(holder, cfg.ID_FIELD) !== undefined && !cfg.OVERWRITE) return null;
    const r = classify(name, index);
    results.push({ where, name, ...r });
    return r.status === "exact" ? linkValue(r.doc) : null;
  };

  if (!cfg.ARRAY_PATH) {
    const value = linkOne(data, cfg.LABEL_FIELD);
    return { update: value === null ? {} : { [cfg.ID_FIELD]: value }, results };
  }
  const arr = getByPath(data, cfg.ARRAY_PATH);
  if (!Array.isArray(arr)) return { update: {}, results };
  let touched = false;
  const next = arr.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const value = linkOne(item, `${cfg.ARRAY_PATH}[${i}].${cfg.LABEL_FIELD}`);
    if (value === null) return item;
    touched = true;
    const copy = { ...item };
    setNested(copy, cfg.ID_FIELD, value);
    return copy;
  });
  return { update: touched ? { [cfg.ARRAY_PATH]: next } : {}, results };
}

/** Set a dotted path on `obj`, copying the maps along the way so the original item is never changed. */
function setNested(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] && typeof cur[parts[i]] === "object" ? { ...cur[parts[i]] } : {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Link ${CONFIG.ARRAY_PATH ? CONFIG.ARRAY_PATH + "[]." : ""}${CONFIG.LABEL_FIELD} → ${CONFIG.ID_FIELD} by '${CONFIG.LOOKUP_COLLECTION}' (${CONFIG.LOOKUP_LABEL_FIELDS.join(", ")}) on ${describeTarget(CONFIG)}`);
  banner(CONFIG.DRY_RUN);

  const lookupSnap = await db.collection(CONFIG.LOOKUP_COLLECTION).get();
  const index = buildIndex(lookupSnap.docs.map((d) => ({ id: d.id, path: d.ref.path, data: d.data() })), CONFIG.LOOKUP_LABEL_FIELDS);
  const linkValue = (doc) => (CONFIG.WRITE === "id" ? doc.id : CONFIG.WRITE === "path" ? doc.path : db.doc(doc.path));
  console.log(`📚 ${lookupSnap.size} lookup documents, ${index.byKey.size} distinct labels.`);

  const plans = [];
  const tally = { exact: [], ambiguous: [], unmatched: [], blank: [] };
  for await (const snap of targetDocs(db, CONFIG)) {
    const { update, results } = planDoc(snap.data(), index, CONFIG, linkValue);
    for (const r of results) tally[r.status].push({ path: snap.ref.path, ...r });
    if (Object.keys(update).length) plans.push({ snap, update });
  }

  console.log(`\n📊 ${tally.exact.length} exact · ${tally.ambiguous.length} ambiguous · ${tally.unmatched.length} unmatched · ${tally.blank.length} blank → ${plans.length} documents would be linked.`);
  for (const r of tally.ambiguous.slice(0, 50)) console.log(`   🟡 ${r.path} ${r.where} "${r.name}": matches ${r.docs.map((d) => d.path).join(", ")}`);
  const unmatched = new Map();
  for (const r of tally.unmatched) unmatched.set(r.name, r);
  for (const r of [...unmatched.values()].slice(0, 50)) {
    console.log(`   🔴 "${r.name}": no match${r.suggestions.length ? ` (near: ${r.suggestions.join(", ")})` : ""}`);
  }

  if (CONFIG.DRY_RUN || !plans.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to link"}.`);
    return;
  }

  console.log(`💾 Before-state saved: ${await saveBeforeState(plans.map((p) => p.snap), { projectId, prefix: "link-by-label" })}`);
  const { done, failures } = await applyWrites(db, plans.map((p) => ({
    op: "update", path: p.snap.ref.path, data: p.update, lastUpdateTime: p.snap.updateTime,
  })));
  printFailures(failures);
  console.log(`\n✅ Linked ${done} of ${plans.length} documents.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, normalize, buildIndex, classify, planDoc };
