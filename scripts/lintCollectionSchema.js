// scripts/lintCollectionSchema.js
// Firestore collection “schema linter” (consistency checker).
// Flags:
// - missing fields (based on REQUIRED_THRESHOLD)
// - type mismatches (string vs number vs timestamp, etc.)
// - suspicious field-name variants (firstName vs first_name)
// - regex violations (e.g. date strings "YYYY-MM-DD")
//
// Usage:
//   node scripts/lintCollectionSchema.js
//
// Output: YAML (LLM-friendly)

const { db } = require("../firebaseAdmin");
const admin = require("firebase-admin");

/* ----------------------------- CONFIG ----------------------------- */
const CONFIG = {
  COLLECTION_PATH: "users",
  SAMPLE_LIMIT: undefined, // e.g. 2000 (undefined => scan all)
  BATCH_SIZE: 500, // pagination batch size

  // A field is considered “expected” if it exists in >= this fraction of docs.
  // Docs missing that field will be reported (with example doc ids).
  REQUIRED_THRESHOLD: 0.9, // 0.9 => present in 90%+ docs

  // “Rare” fields: present in <= this fraction of docs (often typos / stray fields)
  RARE_FIELD_MAX_PCT: 0.05, // 5%

  // Limit examples printed per issue (keeps output readable)
  EXAMPLES_PER_ISSUE: 20,

  // Field-name variants heuristic (firstName vs first_name)
  CHECK_FIELD_NAME_VARIANTS: true,

  // Regex rules (path -> { regex, note? })
  // Use flat paths for nested fields too (e.g. "profile.birthDate")
  STRING_REGEX_RULES: {
    "date": { regex: /^\d{4}-\d{2}-\d{2}$/, note: "YYYY-MM-DD" },
    "time": { regex: /^([01]\d|2[0-3]):[0-5]\d$/, note: "HH:mm (24h)" },
  },
};
/* ------------------------------------------------------------------ */

/* ----------------------------- helpers ---------------------------- */
function isPlainObject(v) {
  return Object.prototype.toString.call(v) === "[object Object]";
}

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

// Flatten nested objects into "a.b.c" -> value
function flattenDoc(data, base = "", out = {}) {
  if (!isPlainObject(data)) return out;

  for (const [k, v] of Object.entries(data)) {
    const path = base ? `${base}.${k}` : k;

    if (
      isPlainObject(v) &&
      !(v instanceof admin.firestore.Timestamp) &&
      !(v instanceof admin.firestore.GeoPoint) &&
      !(v instanceof admin.firestore.DocumentReference)
    ) {
      flattenDoc(v, path, out);
    } else {
      out[path] = v;
    }
  }
  return out;
}

function normalizeFieldName(path) {
  // for variant detection: remove dots + underscores, lowercase
  return path.replace(/\./g, "").replace(/_/g, "").toLowerCase();
}

function pushExample(arr, value, limit) {
  if (arr.length >= limit) return;
  arr.push(value);
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
    return value
      .map((item) => `${pad}- ${toYAML(item, indent + 1).replace(/^  /, "")}`)
      .join("\n");
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (!keys.length) return "{}";
    return keys
      .map((k) => {
        const v = value[k];
        const rendered = toYAML(v, indent + 1);
        if (isPlainObject(v) || Array.isArray(v)) return `${pad}${k}:\n${rendered}`;
        return `${pad}${k}: ${rendered}`;
      })
      .join("\n");
  }

  return JSON.stringify(value);
}

/* --------------------------- scan utilities --------------------------- */
async function scanCollectionDocs(collectionPath, onDoc) {
  const col = db.collection(collectionPath);

  let docsSeen = 0;
  let q = col.orderBy(admin.firestore.FieldPath.documentId()).limit(CONFIG.BATCH_SIZE);

  while (true) {
    if (typeof CONFIG.SAMPLE_LIMIT === "number" && docsSeen >= CONFIG.SAMPLE_LIMIT) break;

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      docsSeen++;
      await onDoc(doc);

      if (typeof CONFIG.SAMPLE_LIMIT === "number" && docsSeen >= CONFIG.SAMPLE_LIMIT) break;
    }

    const last = snap.docs[snap.docs.length - 1];
    q = col.orderBy(admin.firestore.FieldPath.documentId()).startAfter(last.id).limit(CONFIG.BATCH_SIZE);

    if (snap.size < CONFIG.BATCH_SIZE) break;
  }

  return docsSeen;
}

/* --------------------------- pass 1: stats --------------------------- */
function makeFieldStat() {
  return {
    presentCount: 0,
    kinds: {}, // kind -> count
    kindExamples: {}, // kind -> [docId...]
    valueExamples: [], // [ { doc, value } ... ]
    regexViolations: [], // [ { doc, value } ... ]
  };
}

function sanitizeValueForReport(v) {
  const kind = detectKind(v);
  if (v == null || kind === "string" || kind === "number" || kind === "boolean") return v;
  if (kind === "timestamp") return v.toDate().toISOString();
  if (kind === "geopoint") return { latitude: v.latitude, longitude: v.longitude };
  if (kind === "reference") return v.path;
  if (kind === "bytes") return "(bytes)";
  if (kind === "array") return `(array len=${v.length})`;
  if (kind === "object") return "(object)";
  return String(v);
}

async function pass1_buildStats(collectionPath) {
  const fieldStats = new Map(); // fieldPath -> stat
  const variantGroups = new Map(); // normalized -> Set(fieldPath)
  let totalDocs = 0;

  const docsScanned = await scanCollectionDocs(collectionPath, async (doc) => {
    totalDocs++;
    const flat = flattenDoc(doc.data() || {});
    const docId = doc.id;

    for (const [fieldPath, value] of Object.entries(flat)) {
      let stat = fieldStats.get(fieldPath);
      if (!stat) {
        stat = makeFieldStat();
        fieldStats.set(fieldPath, stat);
      }

      stat.presentCount++;

      const kind = detectKind(value);
      stat.kinds[kind] = (stat.kinds[kind] || 0) + 1;

      if (!stat.kindExamples[kind]) stat.kindExamples[kind] = [];
      pushExample(stat.kindExamples[kind], docId, CONFIG.EXAMPLES_PER_ISSUE);

      pushExample(
        stat.valueExamples,
        { doc: docId, value: sanitizeValueForReport(value) },
        CONFIG.EXAMPLES_PER_ISSUE
      );

      const rule = CONFIG.STRING_REGEX_RULES[fieldPath];
      if (rule && kind === "string") {
        if (!rule.regex.test(value)) {
          pushExample(stat.regexViolations, { doc: docId, value }, CONFIG.EXAMPLES_PER_ISSUE);
        }
      }

      if (CONFIG.CHECK_FIELD_NAME_VARIANTS) {
        const norm = normalizeFieldName(fieldPath);
        let set = variantGroups.get(norm);
        if (!set) {
          set = new Set();
          variantGroups.set(norm, set);
        }
        set.add(fieldPath);
      }
    }
  });

  return { fieldStats, variantGroups, totalDocs, docsScanned };
}

/* --------------------- pass 2: missing field examples --------------------- */
async function pass2_missingExamples(collectionPath, expectedFields) {
  const missingExamples = new Map(); // fieldPath -> [docId...]
  const expectedList = Array.from(expectedFields);

  await scanCollectionDocs(collectionPath, async (doc) => {
    const flat = flattenDoc(doc.data() || {});
    const present = new Set(Object.keys(flat));
    const docId = doc.id;

    for (const f of expectedList) {
      if (present.has(f)) continue;

      let arr = missingExamples.get(f);
      if (!arr) {
        arr = [];
        missingExamples.set(f, arr);
      }
      pushExample(arr, docId, CONFIG.EXAMPLES_PER_ISSUE);
    }
  });

  return missingExamples;
}

/* ----------------------------- report build ----------------------------- */
function buildReport({ collectionPath, totalDocs, docsScanned, fieldStats, variantGroups, missingExamples }) {
  const fields = Array.from(fieldStats.entries()).map(([field, stat]) => {
    const pct = totalDocs ? stat.presentCount / totalDocs : 0;
    const kindKeys = Object.keys(stat.kinds);
    const nonNullKinds = kindKeys.filter((k) => k !== "null");
    const typeMismatch = nonNullKinds.length > 1;

    return {
      field,
      present_count: stat.presentCount,
      present_pct: Number(pct.toFixed(4)),
      kinds: stat.kinds,
      type_mismatch: typeMismatch || undefined,
      regex_violations_examples:
        stat.regexViolations.length
          ? stat.regexViolations.map((x) => ({ doc: x.doc, value: x.value }))
          : undefined,
    };
  });

  // Expected fields (based on REQUIRED_THRESHOLD)
  const expectedFields = fields
    .filter((f) => f.present_pct >= CONFIG.REQUIRED_THRESHOLD)
    .sort((a, b) => b.present_pct - a.present_pct);

  // Missing fields issues (with example doc ids)
  const missingIssues = expectedFields
    .map((f) => {
      const missingCount = totalDocs - f.present_count;
      if (missingCount <= 0) return null;
      const examples = missingExamples?.get(f.field) || [];
      return {
        field: f.field,
        missing_count: missingCount,
        missing_pct: Number((missingCount / totalDocs).toFixed(4)),
        example_doc_ids: examples.length ? examples : undefined,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.missing_count - a.missing_count);

  // Type mismatch issues
  const typeMismatchIssues = fields
    .filter((f) => f.type_mismatch)
    .map((f) => {
      const stat = fieldStats.get(f.field);
      const kind_examples = {};
      for (const [kind, arr] of Object.entries(stat.kindExamples)) {
        if (arr && arr.length) kind_examples[kind] = arr;
      }
      return {
        field: f.field,
        kinds: f.kinds,
        example_doc_ids_by_kind: kind_examples,
      };
    })
    .sort((a, b) => Object.keys(b.kinds).length - Object.keys(a.kinds).length);

  // Rare fields issues
  const rareIssues = fields
    .filter((f) => f.present_pct <= CONFIG.RARE_FIELD_MAX_PCT)
    .map((f) => {
      const stat = fieldStats.get(f.field);
      const anyKind = Object.keys(stat.kindExamples)[0];
      const ex = (anyKind && stat.kindExamples[anyKind]) || [];
      return {
        field: f.field,
        present_count: f.present_count,
        present_pct: f.present_pct,
        example_doc_ids: ex.length ? ex : undefined,
      };
    })
    .sort((a, b) => a.present_pct - b.present_pct);

  // Field-name variants
  let fieldNameVariantIssues = undefined;
  if (CONFIG.CHECK_FIELD_NAME_VARIANTS) {
    const groups = [];
    for (const [norm, set] of variantGroups.entries()) {
      const variants = Array.from(set);
      if (variants.length <= 1) continue;

      // Canonical = most common (highest presentCount)
      variants.sort((a, b) => (fieldStats.get(b)?.presentCount || 0) - (fieldStats.get(a)?.presentCount || 0));
      const canonical = variants[0];

      groups.push({
        normalized: norm,
        canonical,
        variants: variants.map((v) => ({
          field: v,
          present_count: fieldStats.get(v)?.presentCount || 0,
        })),
      });
    }

    fieldNameVariantIssues = groups.length ? groups : undefined;
  }

  // Regex violation issues (grouped)
  const regexIssues = [];
  for (const [field, rule] of Object.entries(CONFIG.STRING_REGEX_RULES)) {
    const stat = fieldStats.get(field);
    if (!stat) continue;
    if (!stat.regexViolations.length) continue;

    regexIssues.push({
      field,
      regex: String(rule.regex),
      note: rule.note,
      examples: stat.regexViolations.map((x) => ({ doc: x.doc, value: x.value })),
    });
  }

  const docsWithIssuesEstimate =
    new Set([
      ...missingIssues.flatMap((x) => x.example_doc_ids || []),
      ...typeMismatchIssues.flatMap((x) => Object.values(x.example_doc_ids_by_kind || {}).flat()),
      ...regexIssues.flatMap((x) => x.examples.map((e) => e.doc)),
    ]).size;

  return {
    collection: collectionPath,
    meta: {
      sample_limit: typeof CONFIG.SAMPLE_LIMIT === "number" ? CONFIG.SAMPLE_LIMIT : null,
      docs_scanned: docsScanned,
      docs_total_seen: totalDocs,
      required_threshold: CONFIG.REQUIRED_THRESHOLD,
      rare_field_max_pct: CONFIG.RARE_FIELD_MAX_PCT,
      examples_per_issue: CONFIG.EXAMPLES_PER_ISSUE,
    },
    summary: {
      fields_total: fields.length,
      expected_fields_count: expectedFields.length,
      missing_fields_issues: missingIssues.length,
      type_mismatch_issues: typeMismatchIssues.length,
      regex_issues: regexIssues.length,
      rare_fields_issues: rareIssues.length,
      docs_with_issues_examples_count: docsWithIssuesEstimate,
    },
    issues: {
      missing_fields: missingIssues.length ? missingIssues : undefined,
      type_mismatches: typeMismatchIssues.length ? typeMismatchIssues : undefined,
      regex_violations: regexIssues.length ? regexIssues : undefined,
      rare_fields: rareIssues.length ? rareIssues : undefined,
      field_name_variants: fieldNameVariantIssues,
    },
  };
}

/* -------------------------------- RUN -------------------------------- */
(async () => {
  try {
    const collectionPath = CONFIG.COLLECTION_PATH;
    console.log(`collection: ${collectionPath}`);

    // Pass 1: collect counts/types/regex/name-variants
    const pass1 = await pass1_buildStats(collectionPath);

    // Determine expected fields from pass1
    const expectedFields = new Set();
    for (const [field, stat] of pass1.fieldStats.entries()) {
      const pct = pass1.totalDocs ? stat.presentCount / pass1.totalDocs : 0;
      if (pct >= CONFIG.REQUIRED_THRESHOLD) expectedFields.add(field);
    }

    // Pass 2: find example docs missing expected fields
    const missingExamples =
      expectedFields.size > 0 ? await pass2_missingExamples(collectionPath, expectedFields) : new Map();

    const report = buildReport({
      collectionPath,
      totalDocs: pass1.totalDocs,
      docsScanned: pass1.docsScanned,
      fieldStats: pass1.fieldStats,
      variantGroups: pass1.variantGroups,
      missingExamples,
    });

    console.log(toYAML(report));
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();