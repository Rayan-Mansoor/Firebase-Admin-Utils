// scripts/inferSchema.js
// LLM-friendly YAML profile for a Firestore collection.
// - Root YAML excludes project/collection keys (avoids redundancy).
// - `example` includes one doc from each direct subcollection of the example doc when INCLUDE_SUBCOLLECTIONS=true.
// - Final `meta` only: sample_limit, docs_sampled, include_subcollections.
const { db } = require("../firebaseAdmin");

/* ----------------------------- CONFIG ----------------------------- */
const CONFIG = {
  COLLECTION_PATH: "weekly_lessons",  // e.g. "users" or "schools/ALCE/classes"
  INCLUDE_SUBCOLLECTIONS: true,       // merge subcollection schemas + include subexamples
  SAMPLE_LIMIT: undefined,            // e.g., 500 (undefined => scan all)
  INCLUDE_EXAMPLE: true,              // include a representative example document
  EXAMPLE_SUBDOCS_PER_SUBCOLLECTION: 1, // how many example docs per subcollection of the example doc
};
/* ------------------------------------------------------------------ */

const PROJECT_ID =
  admin.app().options.projectId ||
  serviceAccount.project_id ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  "(unknown)";

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

/* ----------------------- dictionary heuristic ---------------------- */
function maybeAsMap(objAgg) {
  const props = [...objAgg.properties.entries()];
  if (!props.length) return null;
  const total = objAgg.totalSeen;
  for (const [, fa] of props) if (fa.presentCount === total) return null; // stable keys -> fixed shape
  const kinds = [];
  for (const [, fa] of props) {
    if (fa.variants.length !== 1) return null;
    const k = fa.variants[0].kind;
    if (!["boolean", "string", "number"].includes(k)) return null;
    kinds.push(k);
  }
  const first = kinds[0];
  return kinds.every(k => k === first) ? first : null;
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
      const mapValueKind = maybeAsMap(v.object);
      if (mapValueKind) return { type: `map<string, ${mapValueKind}>`, required, nullable: isNullable };
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
async function buildExampleBlockForDoc(docSnap) {
  const example = { document: sanitizeForExample(docSnap.data()) };

  if (!CONFIG.INCLUDE_SUBCOLLECTIONS) return example;

  const subcols = await docSnap.ref.listCollections();
  if (!subcols.length) return example;

  example.subcollections = {};
  for (const col of subcols) {
    let q = col.limit(Math.max(1, CONFIG.EXAMPLE_SUBDOCS_PER_SUBCOLLECTION | 0));
    const snap = await q.get();
    if (snap.empty) continue;
    example.subcollections[col.id] = snap.docs.map(d => sanitizeForExample(d.data()));
  }
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

/* --------------------- Build profile + subcollections -------------------- */
async function buildProfile(collectionPath) {
  const docs = await fetchDocs(collectionPath);
  const agg = makeObjectAgg();
  docs.forEach(d => addObjectSample(agg, d.data()));

  const mainProfile = profileFromAgg(collectionPath, agg);

  // subcollection schemas
  let subprofiles = undefined;
  if (CONFIG.INCLUDE_SUBCOLLECTIONS && docs.length) {
    const subIds = new Set();
    for (const d of docs) {
      const cols = await d.ref.listCollections();
      cols.forEach(c => subIds.add(c.id));
    }
    if (subIds.size) {
      subprofiles = {};
      for (const subId of subIds) {
        const subAgg = makeObjectAgg();
        for (const d of docs) {
          let q = d.ref.collection(subId);
          if (typeof CONFIG.SAMPLE_LIMIT === "number" && CONFIG.SAMPLE_LIMIT > 0) q = q.limit(CONFIG.SAMPLE_LIMIT);
          const ssnap = await q.get();
          ssnap.forEach(s => addObjectSample(subAgg, s.data()));
        }
        if (subAgg.totalSeen > 0) {
          subprofiles[subId] = profileFromAgg(`${collectionPath}/{doc}/${subId}`, subAgg);
        }
      }
    }
  }

  // example (AFTER subcollections)
  let exampleBlock = null;
  if (CONFIG.INCLUDE_EXAMPLE && docs.length) {
    const chosen = pickExampleDoc(docs);
    if (chosen) exampleBlock = await buildExampleBlockForDoc(chosen);
  }

  // Assemble final YAML object in desired order: document -> subcollections -> example -> meta
  const out = {
    document: mainProfile.document,
  };
  if (subprofiles) out.subcollections = subprofiles;
  if (exampleBlock) out.example = exampleBlock;
  out.meta = {
    sample_limit: (typeof CONFIG.SAMPLE_LIMIT === "number" ? CONFIG.SAMPLE_LIMIT : null),
    docs_sampled: agg.totalSeen,
    include_subcollections: !!CONFIG.INCLUDE_SUBCOLLECTIONS,
  };

  return out;
}

/* -------------------------------- RUN -------------------------------- */
(async () => {
  try {
    console.log(`collection: ${CONFIG.COLLECTION_PATH}`);

    const profile = await buildProfile(CONFIG.COLLECTION_PATH);
    console.log(toYAML(profile));
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();