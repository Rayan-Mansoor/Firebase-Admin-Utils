// scripts/scrubFields.js
// Scrub fields across a collection (or collectionGroup) — delete them or null them,
// optionally strip keys from objects inside array fields,
// and optionally delete entire subcollections from matched documents.
//
// Usage: set CONFIG below and run: `node scripts/scrubFields.js`

const { db, FieldValue } = require("../firebaseAdmin");

/**
 * CONFIG
 * - COLLECTION: collection name (e.g., 'weekly_lessons')
 * - USE_COLLECTION_GROUP: set true to target a collectionGroup instead of a top-level collection
 * - FIELD_PATHS: array of field paths to scrub (supports dotted map paths; NOT array indexing)
 * - ARRAY_CLEANERS: [{ arrayPath, deleteKeys[] }]
 *     For each object in arrayPath, delete or null the given keys (keys can be dotted for nested maps)
 * - SUBCOLLECTIONS_TO_DELETE: array of subcollection names to recursively delete from each matched doc
 *     e.g., ['notifications', 'activity_logs']
 *     ⚠️  This is a HARD DELETE — subcollection docs are permanently removed regardless of HARD_DELETE setting.
 * - WHERE: optional filters: [ [field, op, value], ... ]
 * - DOC_IDS: optional list of doc IDs (top-level COLLECTION mode only)
 * - HARD_DELETE: true = delete fields; false = set fields/keys to null
 *     (does NOT affect SUBCOLLECTIONS_TO_DELETE — those are always hard-deleted)
 * - BATCH_SIZE: commit size (≤ 500; keep a safety margin)
 * - DRY_RUN: log what would happen without writing
 */
const CONFIG = {
  COLLECTION: "users",
  USE_COLLECTION_GROUP: false,
  FIELD_PATHS: [],              // nothing to scrub
  ARRAY_CLEANERS: [],
  SUBCOLLECTIONS_TO_DELETE: ["notificationReceipts"],
  WHERE: [],
  DOC_IDS: [],
  HARD_DELETE: false,
  BATCH_SIZE: 400,
  DRY_RUN: false,                // run dry first to see the counts
};

function validateConfig() {
  if (!CONFIG.COLLECTION || typeof CONFIG.COLLECTION !== "string") {
    throw new Error("CONFIG.COLLECTION must be a non-empty string.");
  }
  if (!Array.isArray(CONFIG.FIELD_PATHS)) {
    throw new Error("CONFIG.FIELD_PATHS must be an array.");
  }
  if (!Array.isArray(CONFIG.ARRAY_CLEANERS)) {
    throw new Error("CONFIG.ARRAY_CLEANERS must be an array.");
  }
  if (!Array.isArray(CONFIG.SUBCOLLECTIONS_TO_DELETE)) {
    throw new Error("CONFIG.SUBCOLLECTIONS_TO_DELETE must be an array.");
  }
  for (const name of CONFIG.SUBCOLLECTIONS_TO_DELETE) {
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`Invalid subcollection name: "${name}"`);
    }
  }
  if (!Array.isArray(CONFIG.WHERE)) {
    throw new Error("CONFIG.WHERE must be an array.");
  }
  if (!Array.isArray(CONFIG.DOC_IDS)) {
    throw new Error("CONFIG.DOC_IDS must be an array.");
  }
  if (CONFIG.USE_COLLECTION_GROUP && CONFIG.DOC_IDS.length) {
    throw new Error("DOC_IDS is not supported with USE_COLLECTION_GROUP=true.");
  }
  if (CONFIG.BATCH_SIZE < 1 || CONFIG.BATCH_SIZE > 500) {
    throw new Error("CONFIG.BATCH_SIZE must be between 1 and 500.");
  }
}

function buildFieldUpdateMap(paths, hardDelete) {
  const update = {};
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) {
      throw new Error(`Invalid field path: "${p}"`);
    }
    update[p] = hardDelete ? FieldValue.delete() : null;
  }
  return update;
}

// --- small path helpers (map-only; no array indexing support)
function getByPath(obj, path) {
  return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}
function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object" || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}
function unsetByPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
}

/**
 * Recursively delete all documents in a subcollection (and their nested subcollections).
 * Uses batched deletes with the configured BATCH_SIZE.
 * Returns the total number of documents deleted.
 */
async function deleteSubcollection(parentRef, subcollectionName) {
  const colRef = parentRef.collection(subcollectionName);
  let totalDeleted = 0;

  // Process in pages to avoid loading everything into memory
  let query = colRef.limit(CONFIG.BATCH_SIZE);

  while (true) {
    const snap = await query.get();
    if (snap.empty) break;

    // Recurse into nested subcollections of each doc before deleting it
    for (const doc of snap.docs) {
      const nestedCols = await doc.ref.listCollections();
      for (const nested of nestedCols) {
        totalDeleted += await deleteSubcollection(doc.ref, nested.id);
      }
    }

    // Batch-delete this page of docs
    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    totalDeleted += snap.docs.length;
  }

  return totalDeleted;
}

/**
 * Count documents in a subcollection (non-recursive, top-level only) for dry-run reporting.
 */
async function countSubcollectionDocs(parentRef, subcollectionName) {
  const snap = await parentRef.collection(subcollectionName).count().get();
  return snap.data().count;
}

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

  // collectionGroup mode
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

async function scrubFields() {
  validateConfig();

  const hasFieldWork = CONFIG.FIELD_PATHS.length > 0 || CONFIG.ARRAY_CLEANERS.length > 0;
  const hasSubcolWork = CONFIG.SUBCOLLECTIONS_TO_DELETE.length > 0;

  if (!hasFieldWork && !hasSubcolWork) {
    console.log("Nothing to do — FIELD_PATHS, ARRAY_CLEANERS, and SUBCOLLECTIONS_TO_DELETE are all empty.");
    return { updated: 0, subcollectionDocsDeleted: 0 };
  }

  console.log(
    "CONFIG:",
    JSON.stringify(
      {
        COLLECTION: CONFIG.COLLECTION,
        USE_COLLECTION_GROUP: CONFIG.USE_COLLECTION_GROUP,
        FIELD_PATHS: CONFIG.FIELD_PATHS,
        ARRAY_CLEANERS: CONFIG.ARRAY_CLEANERS,
        SUBCOLLECTIONS_TO_DELETE: CONFIG.SUBCOLLECTIONS_TO_DELETE,
        WHERE: CONFIG.WHERE,
        DOC_IDS: CONFIG.DOC_IDS.length,
        HARD_DELETE: CONFIG.HARD_DELETE,
        BATCH_SIZE: CONFIG.BATCH_SIZE,
        DRY_RUN: CONFIG.DRY_RUN,
      },
      null,
      2
    )
  );

  const fieldMap = hasFieldWork ? buildFieldUpdateMap(CONFIG.FIELD_PATHS, CONFIG.HARD_DELETE) : {};
  const targets = await getTargets();

  if (targets.length === 0) {
    console.log("No documents matched the criteria. Nothing to do.");
    return { updated: 0, subcollectionDocsDeleted: 0 };
  }

  console.log(`Matched ${targets.length} document(s).`);

  // --- DRY RUN ---
  if (CONFIG.DRY_RUN) {
    const sampleCount = Math.min(10, targets.length);
    console.log(`DRY_RUN is ON — showing up to ${sampleCount} sample refs:`);

    for (let i = 0; i < sampleCount; i++) {
      const ref = targets[i].ref;
      console.log(` - ${ref.path}`);

      if (hasSubcolWork) {
        for (const subName of CONFIG.SUBCOLLECTIONS_TO_DELETE) {
          const count = await countSubcollectionDocs(ref, subName);
          console.log(`     └─ ${subName}: ${count} doc(s) would be deleted`);
        }
      }
    }

    console.log("No writes performed.");
    return { updated: 0, subcollectionDocsDeleted: 0, dryRun: true };
  }

  // --- FIELD SCRUBBING ---
  let updated = 0;

  if (hasFieldWork) {
    let batch = db.batch();
    let ops = 0;

    async function commitIfNeeded(force = false) {
      if (ops >= CONFIG.BATCH_SIZE || force) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    for (const snap of targets) {
      const data = snap.data() || {};
      const update = { ...fieldMap };
      let changed = false;

      for (const rule of CONFIG.ARRAY_CLEANERS) {
        const arr = getByPath(data, rule.arrayPath);
        if (!Array.isArray(arr)) continue;

        const newArr = arr.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return item;
          const clone = { ...item };
          for (const key of rule.deleteKeys) {
            if (CONFIG.HARD_DELETE) {
              unsetByPath(clone, key);
            } else {
              setByPath(clone, key, null);
            }
          }
          return clone;
        });

        if (JSON.stringify(newArr) !== JSON.stringify(arr)) {
          update[rule.arrayPath] = newArr;
          changed = true;
        }
      }

      if (Object.keys(update).length > 0 || changed) {
        batch.update(snap.ref, update);
        ops++;
        updated++;
        if (ops >= CONFIG.BATCH_SIZE) await commitIfNeeded();
      }
    }

    await commitIfNeeded(true);
  }

  // --- SUBCOLLECTION DELETION ---
  let subcollectionDocsDeleted = 0;

  if (hasSubcolWork) {
    console.log(`Deleting subcollections: [${CONFIG.SUBCOLLECTIONS_TO_DELETE.join(", ")}]`);

    for (let i = 0; i < targets.length; i++) {
      const ref = targets[i].ref;

      for (const subName of CONFIG.SUBCOLLECTIONS_TO_DELETE) {
        const deleted = await deleteSubcollection(ref, subName);
        subcollectionDocsDeleted += deleted;

        if (deleted > 0) {
          console.log(`  ${ref.path}/${subName}: deleted ${deleted} doc(s)`);
        }
      }

      // Progress log every 100 parent docs
      if ((i + 1) % 100 === 0) {
        console.log(`  … processed ${i + 1}/${targets.length} parent docs`);
      }
    }
  }

  return { updated, subcollectionDocsDeleted };
}

(async () => {
  try {
    const res = await scrubFields();
    if (res.dryRun) {
      console.log("✅ DRY RUN complete.");
    } else {
      const parts = [];
      if (res.updated > 0) parts.push(`updated ${res.updated} document(s)`);
      if (res.subcollectionDocsDeleted > 0)
        parts.push(`deleted ${res.subcollectionDocsDeleted} subcollection doc(s)`);
      console.log(`✅ Done. ${parts.length ? parts.join(", ") : "No changes needed."}`);
    }
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();