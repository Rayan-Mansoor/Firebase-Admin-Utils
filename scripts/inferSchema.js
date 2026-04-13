// scripts/inferSchema.js
// LLM-friendly YAML profile for a Firestore collection (or entire database).
// - COLLECTION_PATH = "*" => scan ALL root-level collections.
// - Root YAML excludes project/collection keys (avoids redundancy).
// - `example` includes one doc from each direct subcollection of the example doc when INCLUDE_SUBCOLLECTIONS=true.
// - Final `meta` only: sample_limit, docs_sampled, include_subcollections.
// - OUTPUT_FILE: optional path to write the YAML output to a .txt file.
const { db, admin } = require("../firebaseAdmin");
const fs = require("fs");
const path = require("path");

/* ----------------------------- CONFIG ----------------------------- */
const CONFIG = {
  COLLECTION_PATH: "*",                // "*" => all root collections; or e.g. "users", "schools/ALCE/classes"
  INCLUDE_SUBCOLLECTIONS: true,        // merge subcollection schemas + include subexamples
  SAMPLE_LIMIT: undefined,             // e.g., 500 (undefined => scan all)
  INCLUDE_EXAMPLE: true,               // include a representative example document
  EXAMPLE_SUBDOCS_PER_SUBCOLLECTION: 1,// how many example docs per subcollection of the example doc
  SUBCOLLECTION_DISCOVERY_LIMIT: null,   // only probe this many docs for subcollection names (null => all)
  CONCURRENCY: 5,                      // max parallel Firestore operations
  OUTPUT_FILE: null,                   // e.g. "./schema-output.txt" (null => console only)
};

/* ----------------------------- output helper ----------------------------- */
const outputLines = [];
function emit(line = "") {
  console.log(line);
  if (CONFIG.OUTPUT_FILE) outputLines.push(line);
}
function flushOutput() {
  if (!CONFIG.OUTPUT_FILE || !outputLines.length) return;
  const resolved = path.resolve(CONFIG.OUTPUT_FILE);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, outputLines.join("\n"), "utf-8");
  console.log(`\n📄 Output written to: ${resolved}`);
}

/* ----------------------------- concurrency helper ----------------------------- */
async function parallelMap(items, fn, concurrency = CONFIG.CONCURRENCY) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/* -------------------------- type + aggs -------------------------- */
function isPlainObject(v) { return Object.prototype.toString.call(v) === "[object Object]"; }
function detectKind(v) {
  if (v === null) return "null";
  if (v instanceof admin.firestore.Timestamp) return "timestamp";
  if (v instanceof admin.firestore.GeoPoint) return "geopoint";
  if (v instanceof admin.firestore.DocumentReference) return "reference";
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return "bytes";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string") return "string";
  if (t === "boolean") return "boolean";
  if (t === "number") return "number";
  if (isPlainObject(v)) return "object";
  return "unknown";
}
function makeFieldAgg() { return { presentCount: 0, variants: [] }; }
function makeObjectAgg() { return { totalSeen: 0, properties: new Map() }; }
function makeArrayAgg() { return { totalSeen: 0, emptyCount: 0, items: null }; }
function getOrCreateVariant(fieldAgg, kind) {
  let v = fieldAgg.variants.find(x => x.kind === kind);
  if (!v) {
    v = { kind, count: 0 };
    if (kind === "object") v.object = makeObjectAgg();
    if (kind === "array") v.array = makeArrayAgg();
    if (kind === "number") v.number = { integerOnly: true };
    fieldAgg.variants.push(v);
  }
  return v;
}
function addValueSample(fieldAgg, value) {
  fieldAgg.presentCount++;
  const kind = detectKind(value);
  const variant = getOrCreateVariant(fieldAgg, kind);
  variant.count++;

  switch (kind) {
    case "object": {
      const oa = variant.object;
      oa.totalSeen++;
      for (const [k, v] of Object.entries(value)) {
        let child = oa.properties.get(k);
        if (!child) { child = makeFieldAgg(); oa.properties.set(k, child); }
        addValueSample(child, v);
      }
      break;
    }
    case "array": {
      const aa = variant.array;
      aa.totalSeen++;
      if (value.length === 0) aa.emptyCount++;
      else {
        if (!aa.items) aa.items = makeFieldAgg();
        for (const el of value) addValueSample(aa.items, el);
      }
      break;
    }
    case "number":
      if (!Number.isInteger(value)) variant.number.integerOnly = false;
      break;
    default: break;
  }
}
function addObjectSample(objAgg, obj) {
  objAgg.totalSeen++;
  for (const [k, v] of Object.entries(obj)) {
    let fa = objAgg.properties.get(k);
    if (!fa) { fa = makeFieldAgg(); objAgg.properties.set(k, fa); }
    addValueSample(fa, v);
  }
}

/* ----------------------- dictionary / map heuristic ---------------------- */
// Patterns that strongly suggest dynamic/map keys
const DYNAMIC_KEY_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,                   // ISO date: 2026-03-25
  /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/,         // time range: 09:00-11:00
  /^[A-Za-z0-9]{20,}$/,                     // Firebase UID / long alphanum ID
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i,            // UUID prefix
  /^\d{10,13}$/,                            // Unix timestamp (sec or ms)
];

function looksLikeDynamicKeys(keys) {
  if (keys.length === 0) return false;
  const dynamicCount = keys.filter(k => DYNAMIC_KEY_PATTERNS.some(p => p.test(k))).length;
  return dynamicCount / keys.length >= 0.5;
}

/**
 * Infer the value kind across all properties of a suspected map object.
 * If all values share the same single kind, return a descriptive type string.
 * For object values, recursively summarize the merged shape.
 */
function inferMapValueSummary(props, parentTotalSeen) {
  const kinds = [];
  for (const [, fa] of props) {
    const nonNull = fa.variants.filter(v => v.kind !== "null");
    if (nonNull.length !== 1) return { mapValueType: "any" };
    kinds.push(nonNull[0].kind);
  }
  if (!kinds.length) return { mapValueType: "any" };
  const first = kinds[0];
  if (!kinds.every(k => k === first)) return { mapValueType: "any" };

  // For object map values, merge all child object aggregates and summarize their shape
  if (first === "object") {
    const mergedObjAgg = makeObjectAgg();
    for (const [, fa] of props) {
      const objVariant = fa.variants.find(v => v.kind === "object");
      if (!objVariant) continue;
      mergedObjAgg.totalSeen += objVariant.object.totalSeen;
      for (const [ck, cfa] of objVariant.object.properties.entries()) {
        let existing = mergedObjAgg.properties.get(ck);
        if (!existing) {
          mergedObjAgg.properties.set(ck, cfa);
        } else {
          // Merge: combine presentCount and variants
          existing.presentCount += cfa.presentCount;
          for (const cv of cfa.variants) {
            let ev = existing.variants.find(x => x.kind === cv.kind);
            if (!ev) {
              existing.variants.push(cv);
            } else {
              ev.count += cv.count;
              if (cv.kind === "object" && cv.object) {
                // Deep-merge object aggs
                ev.object.totalSeen += cv.object.totalSeen;
                for (const [gk, gfa] of cv.object.properties.entries()) {
                  let gexisting = ev.object.properties.get(gk);
                  if (!gexisting) { ev.object.properties.set(gk, gfa); }
                  else { gexisting.presentCount += gfa.presentCount; }
                }
              }
              if (cv.kind === "array" && cv.array) {
                ev.array.totalSeen += cv.array.totalSeen;
                ev.array.emptyCount += cv.array.emptyCount;
              }
              if (cv.kind === "number" && cv.number) {
                if (!cv.number.integerOnly) ev.number.integerOnly = false;
              }
            }
          }
        }
      }
    }
    // Now summarize the merged shape — but apply map detection recursively
    const valueFields = {};
    for (const [k, childFA] of mergedObjAgg.properties.entries()) {
      valueFields[k] = summarizeField(childFA, mergedObjAgg.totalSeen);
    }
    return { mapValueType: "object", valueFields };
  }

  // For arrays as map values
  if (first === "array") return { mapValueType: "array" };

  // Simple types
  if (first === "number") {
    const allInt = props.every(([, fa]) => {
      const nv = fa.variants.find(v => v.kind === "number");
      return nv && nv.number && nv.number.integerOnly;
    });
    return { mapValueType: allInt ? "integer" : "number" };
  }

  return { mapValueType: first };
}

function maybeAsMap(objAgg, parentTotalSeen) {
  const props = [...objAgg.properties.entries()];
  if (!props.length) return null;

  const keys = props.map(([k]) => k);
  const total = objAgg.totalSeen;

  // 1. Pattern-based: if keys look like dates, UIDs, time ranges, etc. → map
  if (looksLikeDynamicKeys(keys)) {
    return inferMapValueSummary(props, total);
  }

  // 2. Cardinality-based: many unique keys relative to docs seen → likely a map
  if (keys.length > Math.max(total * 2, 10)) {
    return inferMapValueSummary(props, total);
  }

  // 3. All keys present in every sample → fixed shape, not a map
  const allStable = props.every(([, fa]) => fa.presentCount === total);
  if (allStable) return null;

  // 4. Sparse keys with uniform value types → map
  //    Only trigger if enough keys are sparse (>50% of keys appear in < all samples)
  const sparseCount = props.filter(([, fa]) => fa.presentCount < total).length;
  if (sparseCount / keys.length < 0.5) return null;

  return inferMapValueSummary(props, total);
}

/* --------------------------- field summary -------------------------- */
function friendlyTypeName(variant) {
  switch (variant.kind) {
    case "number": return variant.number.integerOnly ? "integer" : "number";
    case "timestamp": return "timestamp";
    case "reference": return "documentReference";
    case "bytes": return "bytes(base64)";
    case "geopoint": return "geopoint";
    default: return variant.kind;
  }
}
function summarizeField(fa, parentTotalSeen) {
  const isNullable = fa.variants.some(v => v.kind === "null");
  const required = fa.presentCount === parentTotalSeen;
  const nonNull = fa.variants.filter(v => v.kind !== "null");

  if (!nonNull.length) return { type: "unknown", required, nullable: true };
  if (nonNull.length > 1) {
    const union = nonNull.map(v => friendlyTypeName(v)).sort();
    return { type: "union", union, required, nullable: isNullable };
  }

  const v = nonNull[0];
  switch (v.kind) {
    case "string": return { type: "string", required, nullable: isNullable };
    case "boolean": return { type: "boolean", required, nullable: isNullable };
    case "number": return { type: v.number.integerOnly ? "integer" : "number", required, nullable: isNullable };
    case "timestamp": return { type: "timestamp", format: "RFC3339", required, nullable: isNullable };
    case "reference": return { type: "documentReference", required, nullable: isNullable };
    case "bytes": return { type: "bytes(base64)", required, nullable: isNullable };
    case "geopoint": return { type: "geopoint{latitude:number, longitude:number}", required, nullable: isNullable };
    case "array": {
      const itemsSummary = v.array.items
        ? summarizeField(v.array.items, v.array.items.presentCount || 1)
        : { type: "any" };
      return { type: "array", items: itemsSummary, required, nullable: isNullable };
    }
    case "object": {
      const mapResult = maybeAsMap(v.object, parentTotalSeen);
      if (mapResult) {
        // Simple map type: map<string, boolean>, map<string, string>, etc.
        if (mapResult.mapValueType !== "object" || !mapResult.valueFields) {
          return { type: `map<string, ${mapResult.mapValueType}>`, required, nullable: isNullable };
        }
        // Map with object values: show the merged inner shape
        return {
          type: "map<string, object>",
          required,
          nullable: isNullable,
          valueShape: mapResult.valueFields,
        };
      }
      const fields = {};
      const req = [];
      for (const [k, childFA] of v.object.properties.entries()) {
        fields[k] = summarizeField(childFA, v.object.totalSeen);
        if (childFA.presentCount === v.object.totalSeen) req.push(k);
      }
      return { type: "object", required, nullable: isNullable, requiredFields: req.length ? req : undefined, fields };
    }
    default: return { type: "unknown", required, nullable: isNullable };
  }
}
function profileFromAgg(collectionPath, agg) {
  const fields = {};
  const required = [];
  for (const [k, fa] of agg.properties.entries()) {
    fields[k] = summarizeField(fa, agg.totalSeen);
    if (fa.presentCount === agg.totalSeen) required.push(k);
  }
  return { collection: collectionPath, document: { requiredFields: required.length ? required : undefined, fields } };
}

/* -------------------------- example document ------------------------- */
function sanitizeForExample(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof admin.firestore.Timestamp) return value.toDate().toISOString();
  if (value instanceof admin.firestore.GeoPoint) return { latitude: value.latitude, longitude: value.longitude };
  if (value instanceof admin.firestore.DocumentReference) return value.path;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(sanitizeForExample);
  if (isPlainObject(value)) { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = sanitizeForExample(v); return out; }
  return String(value);
}
function pickExampleDoc(docSnaps) {
  if (!docSnaps.length) return null;
  let best = docSnaps[0], bestCount = Object.keys(docSnaps[0].data() || {}).length;
  for (let i = 1; i < docSnaps.length; i++) {
    const cnt = Object.keys(docSnaps[i].data() || {}).length;
    if (cnt > bestCount) { best = docSnaps[i]; bestCount = cnt; }
  }
  return best;
}
async function buildExampleBlockForDoc(docSnap, knownSubIds) {
  const example = { document: sanitizeForExample(docSnap.data()) };

  if (!CONFIG.INCLUDE_SUBCOLLECTIONS) return example;

  // Reuse already-discovered subcollection IDs if available, else discover
  const subcols = knownSubIds
    ? knownSubIds.map(id => docSnap.ref.collection(id))
    : await docSnap.ref.listCollections();

  if (!subcols.length) return example;

  example.subcollections = {};
  const subResults = await parallelMap(subcols, async (col) => {
    const colRef = typeof col === "string" ? docSnap.ref.collection(col) : col;
    const snap = await colRef.limit(Math.max(1, CONFIG.EXAMPLE_SUBDOCS_PER_SUBCOLLECTION | 0)).get();
    if (snap.empty) return null;
    return { id: colRef.id, docs: snap.docs.map(d => sanitizeForExample(d.data())) };
  });

  for (const r of subResults) {
    if (r) example.subcollections[r.id] = r.docs;
  }
  if (!Object.keys(example.subcollections).length) delete example.subcollections;
  return example;
}

/* ----------------------------- YAML printer ----------------------------- */
function toYAML(value, indent = 0) {
  const pad = "  ".repeat(indent);
  if (value == null) return "null";
  if (typeof value === "string") {
    if (/[:\-\?\[\]\{\},&\*\#\!\|>\'%@\`]|^\s|[\n\r]|\s$/.test(value)) return JSON.stringify(value);
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value.map(item => `${pad}- ${toYAML(item, indent + 1).replace(/^  /, "")}`).join("\n");
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter(k => value[k] !== undefined);
    if (!keys.length) return "{}";
    return keys.map(k => {
      const v = value[k];
      const rendered = toYAML(v, indent + 1);
      if (isPlainObject(v) || Array.isArray(v)) return `${pad}${k}:\n${rendered}`;
      return `${pad}${k}: ${rendered}`;
    }).join("\n");
  }
  return JSON.stringify(value);
}

/* ------------------------- Firestore scanning ------------------------- */
async function fetchDocs(collectionPath) {
  let ref = db.collection(collectionPath);
  if (typeof CONFIG.SAMPLE_LIMIT === "number" && CONFIG.SAMPLE_LIMIT > 0) ref = ref.limit(CONFIG.SAMPLE_LIMIT);
  const snap = await ref.get();
  return snap.docs;
}

/* --------------- Discover subcollection names (sampled) --------------- */
async function discoverSubcollectionIds(docs) {
  const limit = CONFIG.SUBCOLLECTION_DISCOVERY_LIMIT;
  const probe = (typeof limit === "number" && limit > 0) ? docs.slice(0, limit) : docs;

  const subIds = new Set();
  await parallelMap(probe, async (d) => {
    const cols = await d.ref.listCollections();
    cols.forEach(c => subIds.add(c.id));
  });
  return [...subIds];
}

/* --------------------- Build profile + subcollections -------------------- */
async function buildProfile(collectionPath) {
  const startTime = Date.now();
  const docs = await fetchDocs(collectionPath);
  const agg = makeObjectAgg();
  docs.forEach(d => addObjectSample(agg, d.data()));
  console.log(`  ${collectionPath}: ${docs.length} docs fetched (${Date.now() - startTime}ms)`);

  const mainProfile = profileFromAgg(collectionPath, agg);

  // subcollection schemas
  let subprofiles = undefined;
  let subIds = [];
  if (CONFIG.INCLUDE_SUBCOLLECTIONS && docs.length) {
    subIds = await discoverSubcollectionIds(docs);
    console.log(`  ${collectionPath}: subcollections found: ${subIds.length ? subIds.join(", ") : "(none)"}`);

    if (subIds.length) {
      subprofiles = {};

      for (const subId of subIds) {
        const subAgg = makeObjectAgg();
        await parallelMap(docs, async (d) => {
          let q = d.ref.collection(subId);
          if (typeof CONFIG.SAMPLE_LIMIT === "number" && CONFIG.SAMPLE_LIMIT > 0) q = q.limit(CONFIG.SAMPLE_LIMIT);
          const ssnap = await q.get();
          ssnap.forEach(s => addObjectSample(subAgg, s.data()));
        });
        if (subAgg.totalSeen > 0) {
          subprofiles[subId] = profileFromAgg(`${collectionPath}/{doc}/${subId}`, subAgg);
          console.log(`    ↳ ${subId}: ${subAgg.totalSeen} subdocs sampled`);
        }
      }
    }
  }

  // example — reuse discovered subIds to avoid duplicate listCollections()
  let exampleBlock = null;
  if (CONFIG.INCLUDE_EXAMPLE && docs.length) {
    const chosen = pickExampleDoc(docs);
    if (chosen) exampleBlock = await buildExampleBlockForDoc(chosen, subIds.length ? subIds : null);
  }

  const out = { document: mainProfile.document };
  if (subprofiles && Object.keys(subprofiles).length) out.subcollections = subprofiles;
  if (exampleBlock) out.example = exampleBlock;
  out.meta = {
    sample_limit: (typeof CONFIG.SAMPLE_LIMIT === "number" ? CONFIG.SAMPLE_LIMIT : null),
    docs_sampled: agg.totalSeen,
    include_subcollections: !!CONFIG.INCLUDE_SUBCOLLECTIONS,
  };

  console.log(`  ${collectionPath}: done (${Date.now() - startTime}ms total)\n`);
  return out;
}

/* --------------------- Build full database profile -------------------- */
async function buildFullDatabaseProfile() {
  const rootCollections = await db.listCollections();

  if (!rootCollections.length) {
    console.log("No root-level collections found.");
    return null;
  }

  console.log(`Found ${rootCollections.length} root-level collection(s): ${rootCollections.map(c => c.id).join(", ")}\n`);

  const database = {};
  const colIds = rootCollections.map(c => c.id);

  const results = await parallelMap(colIds, async (colId) => {
    try {
      const profile = await buildProfile(colId);
      return { colId, profile };
    } catch (e) {
      console.error(`⚠️  Failed to profile "${colId}": ${e.message}`);
      return { colId, profile: { error: e.message } };
    }
  });

  for (const { colId, profile } of results) {
    database[colId] = profile;
  }

  return database;
}

/* -------------------------------- RUN -------------------------------- */
(async () => {
  try {
    const totalStart = Date.now();
    const scanAll = CONFIG.COLLECTION_PATH === "*";

    if (scanAll) {
      console.log("Mode: Full database scan\n");
      const database = await buildFullDatabaseProfile();
      if (database) {
        emit("========== FULL DATABASE SCHEMA ==========");
        emit("");
        for (const [colId, profile] of Object.entries(database)) {
          emit(`# collection: ${colId}`);
          emit(toYAML(profile));
          emit("");
        }
      }
    } else {
      emit(`collection: ${CONFIG.COLLECTION_PATH}`);
      const profile = await buildProfile(CONFIG.COLLECTION_PATH);
      emit(toYAML(profile));
    }

    flushOutput();
    console.log(`\nCompleted in ${((Date.now() - totalStart) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();