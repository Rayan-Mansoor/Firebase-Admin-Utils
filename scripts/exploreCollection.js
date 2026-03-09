// scripts/exportCollection.js
// Export all documents from a Firestore collection (or subcollection) to stdout as JSON.
// Supports targeting subcollections across all parent docs, recursive subcollection inclusion,
// WHERE filters, DOC_IDS targeting, and optional sampling.
//
// Usage: set CONFIG below and run: `node scripts/exportCollection.js`

const { db, admin } = require("../firebaseAdmin");

/**
 * CONFIG
 *
 * ── Targeting ──
 * - COLLECTION_PATH: collection (or subcollection) path to export.
 *     Top-level:  "users"
 *     Direct sub: "schools/ALCE/classes"  (exports that single subcollection)
 *
 * - SUBCOLLECTION_TARGET: (optional) fan-out across parent docs.
 *     When set, the script iterates every doc (or filtered subset) in COLLECTION_PATH,
 *     then collects docs from the named subcollection on each parent doc.
 *     Example: { subcollection: "attendance" }
 *       with COLLECTION_PATH: "weekly_lessons"
 *       → exports weekly_lessons/{each}/attendance/{docs}
 *
 *     Fields:
 *       subcollection  (string, required): subcollection name under each parent doc
 *       parentWhere    (array, optional):  WHERE filters on the *parent* collection
 *       parentDocIds   (array, optional):  specific parent doc IDs to target
 *
 * - WHERE: filters applied to the *exported* docs (the final-level collection).
 *     Not used when SUBCOLLECTION_TARGET is active (use parentWhere there instead,
 *     and SUBCOLLECTION_WHERE for the child docs).
 *
 * - SUBCOLLECTION_WHERE: filters applied to each subcollection query when
 *     SUBCOLLECTION_TARGET is active.
 *
 * - DOC_IDS: specific doc IDs to fetch (top-level COLLECTION_PATH mode only,
 *     without SUBCOLLECTION_TARGET).
 *
 * ── Depth ──
 * - INCLUDE_SUBCOLLECTIONS: true = recursively embed subcollections inside each doc.
 *     Adds a `_subcollections: { [name]: [...docs] }` key to every doc that has children.
 *
 * - MAX_SUBCOLLECTION_DEPTH: how many levels deep to recurse (default 5; safety cap).
 *
 * ── Limits ──
 * - SAMPLE_LIMIT: max docs to export per collection/subcollection query (undefined = all).
 * - LOG_EVERY: log a progress line every N docs (0 = quiet).
 */
const CONFIG = {
  COLLECTION_PATH: "stripe_customers/fMWULdqG0yWoN1vDG1VCSL23T8H2/payments",

  SUBCOLLECTION_TARGET: null,
  // Example:
  // SUBCOLLECTION_TARGET: {
  //   subcollection: "attendance",
  //   parentWhere: [],          // e.g. [["levelKey", "==", "a1"]]
  //   parentDocIds: [],         // e.g. ["a1_s1", "a1_s2"]
  // },

  WHERE: [],
  SUBCOLLECTION_WHERE: [],
  DOC_IDS: [],

  INCLUDE_SUBCOLLECTIONS: false,
  MAX_SUBCOLLECTION_DEPTH: 5,

  SAMPLE_LIMIT: undefined,
  LOG_EVERY: 50,
};

// ──────────────────────── validation ────────────────────────

function validateConfig() {
  if (!CONFIG.COLLECTION_PATH || typeof CONFIG.COLLECTION_PATH !== "string") {
    throw new Error("CONFIG.COLLECTION_PATH must be a non-empty string.");
  }
  if (!Array.isArray(CONFIG.WHERE)) throw new Error("CONFIG.WHERE must be an array.");
  if (!Array.isArray(CONFIG.SUBCOLLECTION_WHERE)) throw new Error("CONFIG.SUBCOLLECTION_WHERE must be an array.");
  if (!Array.isArray(CONFIG.DOC_IDS)) throw new Error("CONFIG.DOC_IDS must be an array.");
  if (typeof CONFIG.INCLUDE_SUBCOLLECTIONS !== "boolean") {
    throw new Error("CONFIG.INCLUDE_SUBCOLLECTIONS must be boolean.");
  }
  if (typeof CONFIG.MAX_SUBCOLLECTION_DEPTH !== "number" || CONFIG.MAX_SUBCOLLECTION_DEPTH < 1) {
    throw new Error("CONFIG.MAX_SUBCOLLECTION_DEPTH must be a positive integer.");
  }
  if (CONFIG.SAMPLE_LIMIT !== undefined) {
    if (typeof CONFIG.SAMPLE_LIMIT !== "number" || CONFIG.SAMPLE_LIMIT < 1) {
      throw new Error("CONFIG.SAMPLE_LIMIT must be a positive number or undefined.");
    }
  }

  if (CONFIG.SUBCOLLECTION_TARGET) {
    const st = CONFIG.SUBCOLLECTION_TARGET;
    if (!st.subcollection || typeof st.subcollection !== "string") {
      throw new Error("SUBCOLLECTION_TARGET.subcollection must be a non-empty string.");
    }
    if (st.parentWhere && !Array.isArray(st.parentWhere)) {
      throw new Error("SUBCOLLECTION_TARGET.parentWhere must be an array.");
    }
    if (st.parentDocIds && !Array.isArray(st.parentDocIds)) {
      throw new Error("SUBCOLLECTION_TARGET.parentDocIds must be an array.");
    }
    if (CONFIG.DOC_IDS.length > 0) {
      throw new Error("DOC_IDS is not compatible with SUBCOLLECTION_TARGET. Use parentDocIds instead.");
    }
  }

  validateWhereClauses(CONFIG.WHERE, "WHERE");
  validateWhereClauses(CONFIG.SUBCOLLECTION_WHERE, "SUBCOLLECTION_WHERE");
  if (CONFIG.SUBCOLLECTION_TARGET?.parentWhere) {
    validateWhereClauses(CONFIG.SUBCOLLECTION_TARGET.parentWhere, "SUBCOLLECTION_TARGET.parentWhere");
  }
}

function validateWhereClauses(clauses, label) {
  for (const clause of clauses) {
    if (!Array.isArray(clause) || clause.length !== 3) {
      throw new Error(`Invalid ${label} clause: ${JSON.stringify(clause)}. Expected [field, op, value].`);
    }
  }
}

// ──────────────────────── serialization ────────────────────────

function serialize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof admin.firestore.Timestamp) return value.toDate().toISOString();
  if (value instanceof admin.firestore.GeoPoint) return { _type: "geopoint", latitude: value.latitude, longitude: value.longitude };
  if (value instanceof admin.firestore.DocumentReference) return { _type: "reference", path: value.path };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { _type: "bytes", base64: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serialize(v);
    }
    return out;
  }
  return String(value);
}

// ──────────────────────── query helpers ────────────────────────

function applyWhere(query, clauses) {
  for (const [field, op, value] of clauses) {
    query = query.where(field, op, value);
  }
  return query;
}

function applyLimit(query) {
  if (typeof CONFIG.SAMPLE_LIMIT === "number" && CONFIG.SAMPLE_LIMIT > 0) {
    return query.limit(CONFIG.SAMPLE_LIMIT);
  }
  return query;
}

// ──────────────────────── recursive subcollection reader ────────────────────────

async function readSubcollections(docRef, depth) {
  if (depth >= CONFIG.MAX_SUBCOLLECTION_DEPTH) return null;

  const subcols = await docRef.listCollections();
  if (!subcols.length) return null;

  const result = {};

  for (const col of subcols) {
    let q = col;
    q = applyLimit(q);
    const snap = await q.get();
    if (snap.empty) continue;

    const docs = [];
    for (const subDoc of snap.docs) {
      const entry = {
        _id: subDoc.id,
        _path: subDoc.ref.path,
        ...serialize(subDoc.data()),
      };

      if (CONFIG.INCLUDE_SUBCOLLECTIONS) {
        const nested = await readSubcollections(subDoc.ref, depth + 1);
        if (nested) entry._subcollections = nested;
      }

      docs.push(entry);
    }

    if (docs.length) result[col.id] = docs;
  }

  return Object.keys(result).length ? result : null;
}

// ──────────────────────── doc serializer ────────────────────────

async function exportDoc(snap) {
  const entry = {
    _id: snap.id,
    _path: snap.ref.path,
    ...serialize(snap.data()),
  };

  if (CONFIG.INCLUDE_SUBCOLLECTIONS) {
    const subs = await readSubcollections(snap.ref, 0);
    if (subs) entry._subcollections = subs;
  }

  return entry;
}

// ──────────────────────── mode: direct collection ────────────────────────

async function exportDirect() {
  const colRef = db.collection(CONFIG.COLLECTION_PATH);

  // Specific doc IDs
  if (CONFIG.DOC_IDS.length > 0) {
    console.log(`🔑 Fetching ${CONFIG.DOC_IDS.length} specific doc(s)...`);
    const snaps = await Promise.all(CONFIG.DOC_IDS.map((id) => colRef.doc(id).get()));
    const existing = snaps.filter((s) => s.exists);
    console.log(`📊 Found ${existing.length} of ${CONFIG.DOC_IDS.length} requested docs.`);
    return existing;
  }

  // Query
  let query = colRef;
  query = applyWhere(query, CONFIG.WHERE);
  query = applyLimit(query);

  console.log(`📄 Querying '${CONFIG.COLLECTION_PATH}'...`);
  const snap = await query.get();
  console.log(`📊 Found ${snap.size} document(s).`);
  return snap.docs;
}

// ──────────────────────── mode: subcollection fan-out ────────────────────────

async function exportSubcollectionFanout() {
  const st = CONFIG.SUBCOLLECTION_TARGET;
  const parentColRef = db.collection(CONFIG.COLLECTION_PATH);

  // Resolve parent docs
  let parentDocs;
  if (st.parentDocIds && st.parentDocIds.length > 0) {
    console.log(`🔑 Fetching ${st.parentDocIds.length} specific parent doc(s) from '${CONFIG.COLLECTION_PATH}'...`);
    const snaps = await Promise.all(st.parentDocIds.map((id) => parentColRef.doc(id).get()));
    parentDocs = snaps.filter((s) => s.exists);
  } else {
    let query = parentColRef;
    if (st.parentWhere && st.parentWhere.length) {
      query = applyWhere(query, st.parentWhere);
    }
    console.log(`📄 Querying parent collection '${CONFIG.COLLECTION_PATH}'...`);
    const snap = await query.get();
    parentDocs = snap.docs;
  }

  console.log(`📊 Found ${parentDocs.length} parent doc(s). Scanning subcollection '${st.subcollection}' on each...`);

  const allDocs = [];

  for (const parentSnap of parentDocs) {
    let subQuery = parentSnap.ref.collection(st.subcollection);
    subQuery = applyWhere(subQuery, CONFIG.SUBCOLLECTION_WHERE);
    subQuery = applyLimit(subQuery);

    const subSnap = await subQuery.get();
    if (!subSnap.empty) {
      for (const doc of subSnap.docs) {
        allDocs.push(doc);
      }
    }
  }

  console.log(`📊 Found ${allDocs.length} subcollection doc(s) total across ${parentDocs.length} parents.`);
  return allDocs;
}

// ──────────────────────── main ────────────────────────

async function exportCollection() {
  validateConfig();

  console.log(
    "CONFIG:",
    JSON.stringify(
      {
        COLLECTION_PATH: CONFIG.COLLECTION_PATH,
        SUBCOLLECTION_TARGET: CONFIG.SUBCOLLECTION_TARGET,
        WHERE: CONFIG.WHERE,
        SUBCOLLECTION_WHERE: CONFIG.SUBCOLLECTION_WHERE,
        DOC_IDS: CONFIG.DOC_IDS.length,
        INCLUDE_SUBCOLLECTIONS: CONFIG.INCLUDE_SUBCOLLECTIONS,
        MAX_SUBCOLLECTION_DEPTH: CONFIG.MAX_SUBCOLLECTION_DEPTH,
        SAMPLE_LIMIT: CONFIG.SAMPLE_LIMIT ?? null,
        LOG_EVERY: CONFIG.LOG_EVERY,
      },
      null,
      2
    )
  );

  // ── Fetch docs ──
  const rawDocs = CONFIG.SUBCOLLECTION_TARGET
    ? await exportSubcollectionFanout()
    : await exportDirect();

  if (rawDocs.length === 0) {
    console.log("ℹ️  No documents found. Nothing to export.");
    return { exported: 0 };
  }

  // ── Serialize ──
  console.log(`🔄 Serializing ${rawDocs.length} document(s)...`);
  const output = [];
  let count = 0;

  for (const snap of rawDocs) {
    const entry = await exportDoc(snap);
    output.push(entry);
    count++;

    if (CONFIG.LOG_EVERY > 0 && count % CONFIG.LOG_EVERY === 0) {
      console.log(`   …serialized ${count}/${rawDocs.length}`);
    }
  }

  // ── Output ──
  console.log("\n" + JSON.stringify(output, null, 2));

  return { exported: output.length };
}

(async () => {
  try {
    const res = await exportCollection();
    console.log(`✅ Done. Exported ${res.exported} document(s).`);
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();