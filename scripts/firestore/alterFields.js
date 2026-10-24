// scripts/firestore/alterFields.js
// Change field VALUES across a collection (or every collection with an id).
// To delete fields, use scrubFields.js.
//
// What it writes: an update per document whose values actually change; a rule
// that would leave a value as it is is skipped, so running it again writes nothing.
//
// Why it's safe: the dry run (the default) prints every planned change. The armed
// run first saves each document it will change into backups/ (restorable with
// restoreFirestore.js), and each update is refused if the document changed after
// it was read.
//
// Usage: set CONFIG below, run `node scripts/firestore/alterFields.js`, read the
// plan, then set DRY_RUN = false and run it again.

const { FieldValue } = require("firebase-admin").firestore;
const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath, setByPath, pathsOverlap, sameValue } = require("../../lib/fieldPaths");
const { saveBeforeState } = require("../../lib/beforeState");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, preview, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: which documents (see lib/targets.js)
 *
 * - ALTERS: value operations, applied in order to each document
 *     - { op: "set", path, value, onlyIf?, equalsValue? }
 *     - { op: "copy", from, to, onlyIf?, equalsValue? }        copies; "from" stays
 *     - { op: "increment", path, by, defaultIfMissing? }
 *     - { op: "replace", path, pattern, flags?: "g", replace }  strings only
 *     - { op: "coerce", path, type: "string"|"number"|"int"|"boolean", defaultValue? }
 *     - { op: "serverTimestamp", path }
 *   onlyIf: "always" (default) | "exists" | "missing" | "equals" (with equalsValue),
 *   tested on `path` (or `from` for copy).
 *
 * - ARRAY_ALTERS: the same ops on each object inside an array field
 *     [{ arrayPath: "slots", itemFilter?: { path, op: "equals"|"exists"|"missing", value? },
 *        alters: [ ...paths relative to each item... ] }]
 *   (serverTimestamp and increment can't be used inside arrays.)
 *
 * - DRY_RUN: print the plan without writing
 * - LOG_SAMPLES: how many documents' changes to print (0 = none)
 */
const CONFIG = {
  COLLECTION: "users",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],

  ALTERS: [
    // { op: "set", path: "status", value: "active", onlyIf: "missing" },
    // { op: "copy", from: "profile.fullName", to: "profile.displayName" },
    // { op: "increment", path: "stats.loginCount", by: 1, defaultIfMissing: 0 },
    // { op: "replace", path: "profile.fullName", pattern: "\\s+", flags: "g", replace: " " },
    // { op: "coerce", path: "age", type: "int", defaultValue: null },
    // { op: "serverTimestamp", path: "updatedAt" },
  ],

  ARRAY_ALTERS: [
    // {
    //   arrayPath: "slots",
    //   itemFilter: { path: "status", op: "equals", value: "active" },
    //   alters: [{ op: "set", path: "checkedIn", value: false }],
    // },
  ],

  DRY_RUN: true,
  LOG_SAMPLES: 10,
};

const OPS = ["set", "copy", "increment", "replace", "coerce", "serverTimestamp"];
const ONLY_IF = ["always", "exists", "missing", "equals"];

// ------------------------- validation -------------------------

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  if (!Array.isArray(cfg.ALTERS)) throw new Error("CONFIG.ALTERS must be an array.");
  if (!Array.isArray(cfg.ARRAY_ALTERS)) throw new Error("CONFIG.ARRAY_ALTERS must be an array.");
  if (!cfg.ALTERS.length && !cfg.ARRAY_ALTERS.length) throw new Error("Nothing to do: ALTERS and ARRAY_ALTERS are empty.");
  if (typeof cfg.DRY_RUN !== "boolean") throw new Error("CONFIG.DRY_RUN must be boolean.");
  for (const rule of cfg.ALTERS) validateRule(rule, "ALTERS");
  for (const ar of cfg.ARRAY_ALTERS) {
    if (!ar || typeof ar.arrayPath !== "string" || !ar.arrayPath) throw new Error("ARRAY_ALTERS.arrayPath must be a string.");
    if (!Array.isArray(ar.alters)) throw new Error(`ARRAY_ALTERS(${ar.arrayPath}).alters must be an array.`);
    for (const rule of ar.alters) {
      validateRule(rule, `ARRAY_ALTERS(${ar.arrayPath})`);
      if (["serverTimestamp", "increment"].includes(rule.op)) throw new Error(`ARRAY_ALTERS(${ar.arrayPath}): ${rule.op} can't be used inside arrays.`);
    }
    if (ar.itemFilter) validateItemFilter(ar.itemFilter, `ARRAY_ALTERS(${ar.arrayPath}).itemFilter`);
  }
}

function validateRule(rule, where) {
  if (!rule || typeof rule !== "object") throw new Error(`${where}: rule must be an object.`);
  if (!OPS.includes(rule.op)) throw new Error(`${where}: unsupported op "${rule.op}". Allowed: ${OPS.join(", ")}`);
  const str = (k) => {
    if (typeof rule[k] !== "string" || !rule[k]) throw new Error(`${where}: ${rule.op} requires "${k}" (string).`);
  };
  if (rule.op === "copy") {
    str("from");
    str("to");
  } else {
    str("path");
  }
  if (rule.op === "set" && rule.value === undefined) throw new Error(`${where}: set(${rule.path}) value cannot be undefined.`);
  if (rule.op === "increment") {
    if (!Number.isFinite(rule.by)) throw new Error(`${where}: increment.by must be a finite number.`);
    if ("defaultIfMissing" in rule && !Number.isFinite(rule.defaultIfMissing)) throw new Error(`${where}: increment.defaultIfMissing must be a finite number.`);
  }
  if (rule.op === "replace") {
    if (typeof rule.pattern !== "string" || typeof rule.replace !== "string") throw new Error(`${where}: replace needs string "pattern" and "replace".`);
    new RegExp(rule.pattern, rule.flags || "g"); // throws on a bad pattern
  }
  if (rule.op === "coerce" && !["string", "number", "int", "boolean"].includes(rule.type)) {
    throw new Error(`${where}: coerce.type must be string, number, int or boolean.`);
  }
  if ("onlyIf" in rule) {
    if (!ONLY_IF.includes(rule.onlyIf)) throw new Error(`${where}: onlyIf must be one of ${ONLY_IF.join("|")}.`);
    if (rule.onlyIf === "equals" && !("equalsValue" in rule)) throw new Error(`${where}: onlyIf="equals" requires equalsValue.`);
  }
}

function validateItemFilter(filter, where) {
  if (!filter || typeof filter.path !== "string") throw new Error(`${where}: path must be a string.`);
  if (!["equals", "exists", "missing"].includes(filter.op)) throw new Error(`${where}: op must be equals|exists|missing.`);
  if (filter.op === "equals" && !("value" in filter)) throw new Error(`${where}: equals requires value.`);
}

// ------------------------- planning (pure) -------------------------

function shouldApply(rule, data) {
  const onlyIf = rule.onlyIf || "always";
  if (onlyIf === "always") return true;
  const cur = getByPath(data, rule.path || rule.from);
  if (onlyIf === "exists") return cur !== undefined;
  if (onlyIf === "missing") return cur === undefined;
  return sameValue(cur, rule.equalsValue);
}

function coerceValue(v, type, defaultValue) {
  if (v === undefined) return defaultValue;
  if (v === null) return null;
  switch (type) {
    case "string":
      return String(v);
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : defaultValue;
    }
    case "int": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
    }
    case "boolean": {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (["true", "1", "yes", "y"].includes(s)) return true;
        if (["false", "0", "no", "n"].includes(s)) return false;
      }
      return defaultValue;
    }
    default:
      return v;
  }
}

/**
 * What one rule does to `data`: [{ path, value, change }] where value may be a
 * FieldValue sentinel. Nothing when the rule is skipped or changes nothing.
 */
function ruleEffects(rule, data) {
  if (!shouldApply(rule, data)) return [];
  const changed = (path, next) => (sameValue(getByPath(data, path), next) ? [] : [{ path, value: next, change: `${rule.op} ${path} → ${preview(next)}` }]);
  switch (rule.op) {
    case "set":
      return changed(rule.path, rule.value);
    case "serverTimestamp":
      return [{ path: rule.path, value: FieldValue.serverTimestamp(), change: `serverTimestamp ${rule.path}` }];
    case "copy": {
      const val = getByPath(data, rule.from);
      return val === undefined ? [] : changed(rule.to, val);
    }
    case "increment": {
      const cur = getByPath(data, rule.path);
      if (cur === undefined && "defaultIfMissing" in rule) return changed(rule.path, rule.defaultIfMissing + rule.by);
      return [{ path: rule.path, value: FieldValue.increment(rule.by), change: `increment ${rule.path} by ${rule.by}` }];
    }
    case "replace": {
      const cur = getByPath(data, rule.path);
      return typeof cur === "string" ? changed(rule.path, cur.replace(new RegExp(rule.pattern, rule.flags || "g"), rule.replace)) : [];
    }
    case "coerce":
      return changed(rule.path, coerceValue(getByPath(data, rule.path), rule.type, rule.defaultValue));
    default:
      throw new Error(`Unsupported op: ${rule.op}`);
  }
}

function itemMatches(item, filter) {
  if (!filter) return true;
  const cur = getByPath(item, filter.path);
  if (filter.op === "exists") return cur !== undefined;
  if (filter.op === "missing") return cur === undefined;
  return sameValue(cur, filter.value);
}

/** Apply effects to a copy of `obj`, rules seeing earlier rules' results. Returns { next, changes }. */
function applyRules(rules, obj) {
  const next = structuredCloneData(obj);
  const changes = [];
  for (const rule of rules) {
    for (const e of ruleEffects(rule, next)) {
      setByPath(next, e.path, e.value);
      changes.push(e.change);
    }
  }
  return { next, changes };
}

/** Shallow-enough copy for planning: maps and arrays copied, Firestore values shared. */
function structuredCloneData(v) {
  if (Array.isArray(v)) return v.map(structuredCloneData);
  if (v && typeof v === "object" && (v.constructor === Object || v.constructor === undefined)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, structuredCloneData(x)]));
  }
  return v;
}

/** The update for one document: { update, changes }, update empty when nothing changes. */
function planDoc(data, cfg = CONFIG) {
  const update = {};
  const changes = [];
  let current = structuredCloneData(data || {});
  for (const rule of cfg.ALTERS) {
    for (const e of ruleEffects(rule, current)) {
      update[e.path] = e.value;
      setByPath(current, e.path, e.value);
      changes.push(e.change);
    }
  }
  for (const ar of cfg.ARRAY_ALTERS) {
    const arr = getByPath(current, ar.arrayPath);
    if (!Array.isArray(arr)) continue;
    let touched = false;
    const nextArr = arr.map((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || !itemMatches(item, ar.itemFilter)) return item;
      const { next, changes: itemChanges } = applyRules(ar.alters, item);
      if (!itemChanges.length) return item;
      touched = true;
      changes.push(...itemChanges.map((c) => `${ar.arrayPath}[${i}]: ${c}`));
      return next;
    });
    if (touched) {
      update[ar.arrayPath] = nextArr;
      setByPath(current, ar.arrayPath, nextArr);
    }
  }
  return { update: collapseOverlaps(update, current), changes };
}

/** Firestore refuses an update naming both "a" and "a.b": keep the outer path, with its final value. */
function collapseOverlaps(update, current) {
  const keys = Object.keys(update);
  const outer = keys.filter((k) => !keys.some((o) => o !== k && pathsOverlap(o, k) && o.length < k.length));
  if (outer.length === keys.length) return update;
  return Object.fromEntries(outer.map((k) => [k, keys.some((o) => o !== k && o.startsWith(k + ".")) ? getByPath(current, k) : update[k]]));
}

// ------------------------- main -------------------------

async function main() {
  const { db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Alter fields in ${describeTarget(CONFIG)}`);
  banner(CONFIG.DRY_RUN);

  const plans = [];
  let scanned = 0;
  for await (const snap of targetDocs(db, CONFIG)) {
    scanned++;
    const { update, changes } = planDoc(snap.data(), CONFIG);
    if (changes.length) plans.push({ snap, update, changes });
  }
  console.log(`📊 ${scanned} documents matched; ${plans.length} would change.`);
  for (const p of plans.slice(0, CONFIG.LOG_SAMPLES)) {
    console.log(`   ✏️  ${p.snap.ref.path}`);
    for (const c of p.changes.slice(0, 25)) console.log(`        ${c}`);
    if (p.changes.length > 25) console.log(`        … and ${p.changes.length - 25} more`);
  }
  if (plans.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${plans.length - CONFIG.LOG_SAMPLES} more documents.`);

  if (CONFIG.DRY_RUN || !plans.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to do"}: ${plans.length} documents would be updated.`);
    return;
  }

  const backup = await saveBeforeState(plans.map((p) => p.snap), { projectId, prefix: "alter-fields" });
  console.log(`💾 Before-state saved: ${backup}`);
  const { done, failures } = await applyWrites(db, plans.map((p) => ({
    op: "update", path: p.snap.ref.path, data: p.update, lastUpdateTime: p.snap.updateTime,
  })));
  printFailures(failures);
  console.log(`\n✅ Updated ${done} of ${plans.length} documents.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, planDoc, coerceValue };
