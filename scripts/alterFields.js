// scripts/alterFields.js
// Alter (manipulate) field VALUES across a collection (or collectionGroup).
// No deleting fields, no renaming fields — use scrubFields.js for removals.
//
// Usage: set CONFIG below and run: `node scripts/alterFields.js`

const { db, FieldValue } = require("../firebaseAdmin");

/**
 * CONFIG
 * - COLLECTION: collection name (e.g., 'users')
 * - USE_COLLECTION_GROUP: set true to target a collectionGroup instead of a top-level collection
 * - WHERE: optional filters: [ [field, op, value], ... ]
 * - DOC_IDS: optional list of doc IDs (top-level COLLECTION mode only)
 *
 * - ALTERS: list of value operations (order matters)
 *     Supported ops:
 *       - { op: "set", path, value, onlyIf?: "always"|"exists"|"missing"|"equals", equalsValue? }
 *       - { op: "copy", from, to, onlyIf?: "always"|"exists"|"missing"|"equals", equalsValue? }
 *            (Copies value from "from" to "to". Does NOT remove from "from".)
 *       - { op: "increment", path, by, defaultIfMissing?: 0 }
 *       - { op: "replace", path, pattern, flags?: "g", replace, onlyIfType?: "string" }
 *       - { op: "coerce", path, type: "string"|"number"|"int"|"boolean", defaultValue?: any }
 *       - { op: "serverTimestamp", path }
 *
 * - ARRAY_ALTERS: transforms objects inside an array field
 *     [
 *       {
 *         arrayPath: "slots",
 *         itemFilter?: { path, op: "equals"|"exists"|"missing", value? },
 *         alters: [ ...same ops as above, but paths are relative to each item object... ]
 *       }
 *     ]
 *
 * - BATCH_SIZE: commit size (≤ 500; keep a safety margin)
 * - DRY_RUN: log what would happen without writing
 * - LOG_SAMPLES: show sample changes for up to N docs (0 disables)
 */
const CONFIG = {
  COLLECTION: "users",
  USE_COLLECTION_GROUP: false,

  WHERE: [],
  DOC_IDS: [],

  ALTERS: [
    { op: "set", path: "progress.firstTestCompleted", value: false },
    // { op: "copy", from: "profile.fullName", to: "profile.displayName" },
    // { op: "increment", path: "stats.loginCount", by: 1, defaultIfMissing: 0 },
    // { op: "replace", path: "profile.fullName", pattern: "\\s+", flags: "g", replace: " ", onlyIfType: "string" },
    // { op: "coerce", path: "age", type: "int", defaultValue: null },
    // { op: "serverTimestamp", path: "updatedAt" },
  ],

  ARRAY_ALTERS: [
    // {
    //   arrayPath: "slots",
    //   itemFilter: { path: "status", op: "equals", value: "active" },
    //   alters: [
    //     { op: "set", path: "checkedIn", value: false },
    //     { op: "replace", path: "teacherName", pattern: "\\s+", flags: "g", replace: " " },
    //   ],
    // },
  ],

  BATCH_SIZE: 400,
  DRY_RUN: false,
  LOG_SAMPLES: 10,
};

// ------------------------- validation -------------------------

function validateConfig() {
  if (!CONFIG.COLLECTION || typeof CONFIG.COLLECTION !== "string") {
    throw new Error("CONFIG.COLLECTION must be a non-empty string.");
  }
  if (!Array.isArray(CONFIG.WHERE)) throw new Error("CONFIG.WHERE must be an array.");
  if (!Array.isArray(CONFIG.DOC_IDS)) throw new Error("CONFIG.DOC_IDS must be an array.");
  if (CONFIG.USE_COLLECTION_GROUP && CONFIG.DOC_IDS.length) {
    throw new Error("DOC_IDS is not supported with USE_COLLECTION_GROUP=true.");
  }
  if (!Array.isArray(CONFIG.ALTERS)) throw new Error("CONFIG.ALTERS must be an array.");
  if (!Array.isArray(CONFIG.ARRAY_ALTERS)) throw new Error("CONFIG.ARRAY_ALTERS must be an array.");
  if (CONFIG.BATCH_SIZE < 1 || CONFIG.BATCH_SIZE > 500) {
    throw new Error("CONFIG.BATCH_SIZE must be between 1 and 500.");
  }

  for (const rule of CONFIG.ALTERS) validateAlterRule(rule, "ALTERS");
  for (const ar of CONFIG.ARRAY_ALTERS) {
    if (!ar || typeof ar !== "object") throw new Error("ARRAY_ALTERS entries must be objects.");
    if (!ar.arrayPath || typeof ar.arrayPath !== "string") throw new Error("ARRAY_ALTERS.arrayPath must be a string.");
    if (!Array.isArray(ar.alters)) throw new Error(`ARRAY_ALTERS.alters must be an array for ${ar.arrayPath}.`);
    for (const rule of ar.alters) validateAlterRule(rule, `ARRAY_ALTERS(${ar.arrayPath})`);
    if (ar.itemFilter) validateItemFilter(ar.itemFilter, `ARRAY_ALTERS(${ar.arrayPath}).itemFilter`);
  }
}

function validateAlterRule(rule, where) {
  if (!rule || typeof rule !== "object") throw new Error(`${where}: rule must be an object.`);
  if (!rule.op || typeof rule.op !== "string") throw new Error(`${where}: rule.op must be a string.`);

  const allowedOps = new Set(["set", "copy", "increment", "replace", "coerce", "serverTimestamp"]);
  if (!allowedOps.has(rule.op)) {
    throw new Error(`${where}: unsupported op "${rule.op}". Allowed: ${Array.from(allowedOps).join(", ")}`);
  }

  const op = rule.op;
  const needsPath = ["set", "increment", "replace", "coerce", "serverTimestamp"].includes(op);
  if (needsPath && (!rule.path || typeof rule.path !== "string")) {
    throw new Error(`${where}: op="${op}" requires "path" (string).`);
  }

  if (op === "copy") {
    if (!rule.from || typeof rule.from !== "string") throw new Error(`${where}: copy requires "from" (string).`);
    if (!rule.to || typeof rule.to !== "string") throw new Error(`${where}: copy requires "to" (string).`);
  }

  if (op === "set") {
    if (rule.value === undefined) throw new Error(`${where}: set(${rule.path}) value cannot be undefined.`);
  }

  if (op === "increment") {
    if (typeof rule.by !== "number" || !Number.isFinite(rule.by)) {
      throw new Error(`${where}: increment.by must be a finite number.`);
    }
    if ("defaultIfMissing" in rule && (typeof rule.defaultIfMissing !== "number" || !Number.isFinite(rule.defaultIfMissing))) {
      throw new Error(`${where}: increment.defaultIfMissing must be a finite number.`);
    }
  }

  if (op === "replace") {
    if (typeof rule.pattern !== "string") throw new Error(`${where}: replace.pattern must be a string.`);
    if (typeof rule.replace !== "string") throw new Error(`${where}: replace.replace must be a string.`);
    if ("flags" in rule && typeof rule.flags !== "string") throw new Error(`${where}: replace.flags must be a string.`);
  }

  if (op === "coerce") {
    const allowed = new Set(["string", "number", "int", "boolean"]);
    if (!allowed.has(rule.type)) throw new Error(`${where}: coerce.type must be one of ${Array.from(allowed).join(", ")}.`);
  }

  if ("onlyIf" in rule) {
    const allowed = new Set(["always", "exists", "missing", "equals"]);
    if (!allowed.has(rule.onlyIf)) throw new Error(`${where}: onlyIf must be one of always|exists|missing|equals.`);
    if (rule.onlyIf === "equals" && !("equalsValue" in rule)) {
      throw new Error(`${where}: onlyIf="equals" requires equalsValue.`);
    }
  }
}

function validateItemFilter(filter, where) {
  if (!filter || typeof filter !== "object") throw new Error(`${where}: must be an object.`);
  if (!filter.path || typeof filter.path !== "string") throw new Error(`${where}: path must be a string.`);
  const allowed = new Set(["equals", "exists", "missing"]);
  if (!allowed.has(filter.op)) throw new Error(`${where}: op must be equals|exists|missing.`);
  if (filter.op === "equals" && !("value" in filter)) throw new Error(`${where}: equals requires value.`);
}

// ------------------------- path helpers (map-only; no array indexing) -------------------------

function getByPath(obj, path) {
  return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}
function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function shouldApplyRule(rule, baseObj) {
  const onlyIf = rule.onlyIf || "always";
  if (onlyIf === "always") return true;

  const readPath = rule.path || rule.from; // for copy we read from "from"
  const cur = readPath ? getByPath(baseObj, readPath) : undefined;

  if (onlyIf === "exists") return cur !== undefined;
  if (onlyIf === "missing") return cur === undefined;
  if (onlyIf === "equals") return cur === rule.equalsValue;
  return true;
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
      if (!Number.isFinite(n)) return defaultValue;
      return n < 0 ? Math.ceil(n) : Math.floor(n);
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

function applyAlterRuleToUpdate({ rule, update, changeLog, baseForReads }) {
  if (!shouldApplyRule(rule, baseForReads)) return;

  switch (rule.op) {
    case "set": {
      update[rule.path] = rule.value;
      changeLog.push({ op: "set", path: rule.path, to: rule.value });
      return;
    }
    case "serverTimestamp": {
      update[rule.path] = FieldValue.serverTimestamp();
      changeLog.push({ op: "serverTimestamp", path: rule.path });
      return;
    }
    case "copy": {
      const val = getByPath(baseForReads, rule.from);
      if (val === undefined) return;
      update[rule.to] = val;
      changeLog.push({ op: "copy", from: rule.from, to: rule.to });
      return;
    }
    case "increment": {
      const cur = getByPath(baseForReads, rule.path);
      if (cur === undefined && "defaultIfMissing" in rule) {
        update[rule.path] = rule.defaultIfMissing + rule.by;
        changeLog.push({ op: "increment(set)", path: rule.path, to: update[rule.path] });
      } else {
        update[rule.path] = FieldValue.increment(rule.by);
        changeLog.push({ op: "increment", path: rule.path, by: rule.by });
      }
      return;
    }
    case "replace": {
      const cur = getByPath(baseForReads, rule.path);
      if (cur === undefined || cur === null) return;
      if (rule.onlyIfType === "string" && typeof cur !== "string") return;
      if (typeof cur !== "string") return; // safest default
      const re = new RegExp(rule.pattern, rule.flags || "g");
      const next = cur.replace(re, rule.replace);
      update[rule.path] = next;
      changeLog.push({ op: "replace", path: rule.path });
      return;
    }
    case "coerce": {
      const cur = getByPath(baseForReads, rule.path);
      const next = coerceValue(cur, rule.type, rule.defaultValue);
      update[rule.path] = next;
      changeLog.push({ op: "coerce", path: rule.path, type: rule.type });
      return;
    }
    default:
      throw new Error(`Unsupported op: ${rule.op}`);
  }
}

function filterItem(item, itemFilter) {
  if (!itemFilter) return true;
  const cur = getByPath(item, itemFilter.path);
  if (itemFilter.op === "exists") return cur !== undefined;
  if (itemFilter.op === "missing") return cur === undefined;
  if (itemFilter.op === "equals") return cur === itemFilter.value;
  return true;
}

// ------------------------- targeting -------------------------

async function getTargets() {
  if (!CONFIG.USE_COLLECTION_GROUP) {
    const colRef = db.collection(CONFIG.COLLECTION);

    if (CONFIG.DOC_IDS.length > 0) {
      const snaps = await Promise.all(CONFIG.DOC_IDS.map((id) => colRef.doc(id).get()));
      return snaps.filter((s) => s.exists);
    }

    let query = colRef;
    for (const clause of CONFIG.WHERE) {
      if (!Array.isArray(clause) || clause.length !== 3) {
        throw new Error(`Invalid WHERE clause: ${JSON.stringify(clause)}`);
      }
      const [field, op, value] = clause;
      query = query.where(field, op, value);
    }
    const snap = await query.get();
    return snap.docs;
  }

  let query = db.collectionGroup(CONFIG.COLLECTION);
  for (const clause of CONFIG.WHERE) {
    if (!Array.isArray(clause) || clause.length !== 3) {
      throw new Error(`Invalid WHERE clause: ${JSON.stringify(clause)}`);
    }
    const [field, op, value] = clause;
    query = query.where(field, op, value);
  }
  const snap = await query.get();
  return snap.docs;
}

// ------------------------- main -------------------------

async function alterFields() {
  validateConfig();

  console.log(
    "CONFIG:",
    JSON.stringify(
      {
        COLLECTION: CONFIG.COLLECTION,
        USE_COLLECTION_GROUP: CONFIG.USE_COLLECTION_GROUP,
        WHERE: CONFIG.WHERE,
        DOC_IDS: CONFIG.DOC_IDS.length,
        ALTERS: CONFIG.ALTERS.length,
        ARRAY_ALTERS: CONFIG.ARRAY_ALTERS.length,
        BATCH_SIZE: CONFIG.BATCH_SIZE,
        DRY_RUN: CONFIG.DRY_RUN,
        LOG_SAMPLES: CONFIG.LOG_SAMPLES,
      },
      null,
      2
    )
  );

  const targets = await getTargets();
  if (targets.length === 0) {
    console.log("No documents matched the criteria. Nothing to do.");
    return { updated: 0 };
  }

  console.log(`Matched ${targets.length} document(s).`);

  if (CONFIG.DRY_RUN) {
    const sampleCount = Math.min(CONFIG.LOG_SAMPLES || 0, targets.length);
    console.log(`DRY_RUN is ON — showing up to ${sampleCount} sample refs:`);
    for (let i = 0; i < sampleCount; i++) console.log(` - ${targets[i].ref.path}`);
    console.log("No writes performed.");
    return { updated: 0, dryRun: true };
  }

  let batch = db.batch();
  let ops = 0;
  let updated = 0;

  async function commitIfNeeded(force = false) {
    if (ops >= CONFIG.BATCH_SIZE || force) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  let sampleLogged = 0;

  for (const snap of targets) {
    const data = snap.data() || {};
    const update = {};
    const changeLog = [];

    // 1) Apply top-level ALTERS
    for (const rule of CONFIG.ALTERS) {
      applyAlterRuleToUpdate({ rule, update, changeLog, baseForReads: data });
    }

    // 2) Apply ARRAY_ALTERS (object-per-item transforms)
    for (const ar of CONFIG.ARRAY_ALTERS) {
      const arr = getByPath(data, ar.arrayPath);
      if (!Array.isArray(arr)) continue;

      let changed = false;
      const nextArr = arr.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        if (!filterItem(item, ar.itemFilter)) return item;

        const clone = { ...item };
        const itemUpdate = {};
        const itemLog = [];

        for (const rule of ar.alters) {
          applyAlterRuleToUpdate({ rule, update: itemUpdate, changeLog: itemLog, baseForReads: clone });
        }

        for (const [path, val] of Object.entries(itemUpdate)) {
          if (val === undefined) throw new Error(`Array item update produced undefined for path "${path}".`);
          setByPath(clone, path, val);
        }

        if (JSON.stringify(clone) !== JSON.stringify(item)) {
          changed = true;
          changeLog.push({ op: "arrayAlter", arrayPath: ar.arrayPath, itemChanges: itemLog });
          return clone;
        }
        return item;
      });

      if (changed) update[ar.arrayPath] = nextArr;
    }

    if (Object.keys(update).length > 0) {
      batch.update(snap.ref, update);
      ops++;
      updated++;

      if (CONFIG.LOG_SAMPLES && sampleLogged < CONFIG.LOG_SAMPLES) {
        sampleLogged++;
        console.log(`\n[Sample ${sampleLogged}] ${snap.ref.path}`);
        for (const c of changeLog.slice(0, 25)) console.log(" -", JSON.stringify(c));
        if (changeLog.length > 25) console.log(` - ... (${changeLog.length - 25} more)`);
      }

      if (ops >= CONFIG.BATCH_SIZE) await commitIfNeeded();
    }
  }

  await commitIfNeeded(true);
  return { updated };
}

(async () => {
  try {
    const res = await alterFields();
    if (res.dryRun) {
      console.log("✅ DRY RUN complete.");
    } else {
      console.log(`✅ Done. Updated ${res.updated} document(s).`);
    }
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();