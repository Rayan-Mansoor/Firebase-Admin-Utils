// scripts/copyCollection.js
// Copy a Firestore collection to another collection — optionally include subcollections,
// and optionally delete the source after a successful copy (destructive).
// Usage: set CONFIG below, then run: `node scripts/copyCollection.js`
const { db } = require("../firebaseAdmin");

/**
 * CONFIG
 * - SOURCE_COLLECTION: source collection name
 * - DESTINATION_COLLECTION: destination collection name
 * - INCLUDE_SUBCOLLECTIONS: true = recursively copy subcollections
 * - IS_DESTRUCTIVE: true = delete the source (docs + descendants) after a successful copy
 * - BATCH_SIZE: Firestore batch size (≤ 500; keep a margin)
 * - DRY_RUN: log planned operations without writing/deleting
 */
const CONFIG = {
  SOURCE_COLLECTION: "food_orders",
  DESTINATION_COLLECTION: "norders",
  INCLUDE_SUBCOLLECTIONS: false,
  IS_DESTRUCTIVE: false,
  BATCH_SIZE: 400,
  DRY_RUN: false,
};

function validateConfig() {
  const {
    SOURCE_COLLECTION,
    DESTINATION_COLLECTION,
    INCLUDE_SUBCOLLECTIONS,
    IS_DESTRUCTIVE,
    BATCH_SIZE,
    DRY_RUN,
  } = CONFIG;

  if (!SOURCE_COLLECTION || typeof SOURCE_COLLECTION !== "string") {
    throw new Error("CONFIG.SOURCE_COLLECTION must be a non-empty string.");
  }
  if (!DESTINATION_COLLECTION || typeof DESTINATION_COLLECTION !== "string") {
    throw new Error("CONFIG.DESTINATION_COLLECTION must be a non-empty string.");
  }
  if (SOURCE_COLLECTION === DESTINATION_COLLECTION) {
    throw new Error("SOURCE_COLLECTION and DESTINATION_COLLECTION must differ.");
  }
  if (typeof INCLUDE_SUBCOLLECTIONS !== "boolean") {
    throw new Error("CONFIG.INCLUDE_SUBCOLLECTIONS must be boolean.");
  }
  if (typeof IS_DESTRUCTIVE !== "boolean") {
    throw new Error("CONFIG.IS_DESTRUCTIVE must be boolean.");
  }
  if (BATCH_SIZE < 1 || BATCH_SIZE > 500) {
    throw new Error("CONFIG.BATCH_SIZE must be between 1 and 500.");
  }
  if (typeof DRY_RUN !== "boolean") {
    throw new Error("CONFIG.DRY_RUN must be boolean.");
  }
}

/** Simple batching helper to keep writes under the batch limit. */
function makeBatcher() {
  const limit = CONFIG.BATCH_SIZE;
  let batch = db.batch();
  let count = 0;

  return {
    async set(ref, data, options) {
      if (CONFIG.DRY_RUN) return; // no-op
      batch.set(ref, data, options);
      count++;
      await maybeCommit();
    },
    async delete(ref) {
      if (CONFIG.DRY_RUN) return; // no-op
      batch.delete(ref);
      count++;
      await maybeCommit();
    },
    async flush() {
      if (CONFIG.DRY_RUN) return; // no-op
      if (count > 0) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    },
  };

  async function maybeCommit() {
    if (count >= limit) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
}

/**
 * Recursively copies a document and its subcollections (if enabled).
 * Reads from CONFIG.INCLUDE_SUBCOLLECTIONS and CONFIG.DRY_RUN.
 */
async function copyDocRecursive(srcDocRef, destDocRef, batcher) {
  const snap = await srcDocRef.get();
  if (!snap.exists) return;

  if (CONFIG.DRY_RUN) {
    console.log(`→ (dry-run) would copy: ${srcDocRef.path}  ->  ${destDocRef.path}`);
  } else {
    await batcher.set(destDocRef, snap.data());
  }

  if (!CONFIG.INCLUDE_SUBCOLLECTIONS) return;

  const subcollections = await srcDocRef.listCollections();
  for (const subcol of subcollections) {
    const destSubcolRef = destDocRef.collection(subcol.id);
    const subDocsSnap = await subcol.get();

    for (const subDoc of subDocsSnap.docs) {
      const srcChildDocRef = subcol.doc(subDoc.id);
      const destChildDocRef = destSubcolRef.doc(subDoc.id);
      await copyDocRecursive(srcChildDocRef, destChildDocRef, batcher);
    }
  }
}

/** Recursively deletes a document and all descendants. */
async function deleteDocRecursive(docRef, batcher) {
  const subcollections = await docRef.listCollections();
  for (const subcol of subcollections) {
    const subDocsSnap = await subcol.get();
    for (const subDoc of subDocsSnap.docs) {
      await deleteDocRecursive(subcol.doc(subDoc.id), batcher);
    }
  }
  if (CONFIG.DRY_RUN) {
    console.log(`🗑️  (dry-run) would delete: ${docRef.path}`);
  } else {
    await batcher.delete(docRef);
  }
}

/** Recursively deletes an entire collection (all docs + descendants). */
async function deleteCollectionRecursive(collectionPath) {
  console.log(`🗑️  Recursively deleting source collection '${collectionPath}'...`);
  const batcher = makeBatcher();

  const colRef = db.collection(collectionPath);
  const snapshot = await colRef.get();

  if (snapshot.empty) {
    console.log("ℹ️  Source collection is already empty.");
    return;
  }

  let processed = 0;
  for (const doc of snapshot.docs) {
    processed++;
    await deleteDocRecursive(doc.ref, batcher);
    if (!CONFIG.DRY_RUN && processed % 50 === 0) {
      console.log(`   …queued deletes for ${processed}/${snapshot.size} docs`);
    }
  }

  await batcher.flush();
  if (CONFIG.DRY_RUN) {
    console.log(`✅ (dry-run) Delete summary: would remove ${processed} top-level docs and all descendants.`);
  } else {
    console.log(`✅ Finished deleting '${collectionPath}'. Removed ${processed} top-level docs and all descendants.`);
  }
}

/** Main copy routine — uses CONFIG directly. */
async function copyCollection() {
  validateConfig();

  console.log(
    "CONFIG:",
    JSON.stringify(
      {
        SOURCE_COLLECTION: CONFIG.SOURCE_COLLECTION,
        DESTINATION_COLLECTION: CONFIG.DESTINATION_COLLECTION,
        INCLUDE_SUBCOLLECTIONS: CONFIG.INCLUDE_SUBCOLLECTIONS,
        IS_DESTRUCTIVE: CONFIG.IS_DESTRUCTIVE,
        BATCH_SIZE: CONFIG.BATCH_SIZE,
        DRY_RUN: CONFIG.DRY_RUN,
      },
      null,
      2
    )
  );

  console.log(
    `🚀 Starting copy from '${CONFIG.SOURCE_COLLECTION}' → '${CONFIG.DESTINATION_COLLECTION}'...`
  );

  let processedCount = 0;
  let copiedCount = 0;
  let errorCount = 0;

  try {
    const snapshot = await db.collection(CONFIG.SOURCE_COLLECTION).get();
    console.log(`📊 Found ${snapshot.size} document(s) to copy.`);

    if (snapshot.empty) {
      console.log("✅ Source collection is empty. Nothing to copy.");
      return;
    }

    const batcher = makeBatcher();

    for (const doc of snapshot.docs) {
      processedCount++;
      try {
        const destDocRef = db.collection(CONFIG.DESTINATION_COLLECTION).doc(doc.id);
        await copyDocRecursive(doc.ref, destDocRef, batcher);
        copiedCount++;
        if (processedCount % 25 === 0) {
          console.log(
            `   …processed ${processedCount}/${snapshot.size} docs (copied so far: ${copiedCount})`
          );
        }
      } catch (err) {
        console.error(`❌ Error copying doc '${doc.id}':`, err?.message || err);
        errorCount++;
      }
    }

    await batcher.flush();

    console.log("\n📊 Copy Summary:");
    console.log(`   Total docs processed: ${processedCount}`);
    console.log(`   Successfully copied:  ${copiedCount}`);
    console.log(`   Errors:               ${errorCount}`);
    if (CONFIG.DRY_RUN) console.log("   Mode:                 DRY_RUN (no writes/deletes performed)");

    if (!CONFIG.DRY_RUN && errorCount === 0 && processedCount > 0) {
      console.log(
        `🎉 Copy completed successfully: '${CONFIG.SOURCE_COLLECTION}' → '${CONFIG.DESTINATION_COLLECTION}'.`
      );
      if (CONFIG.IS_DESTRUCTIVE) {
        await deleteCollectionRecursive(CONFIG.SOURCE_COLLECTION);
      }
    } else if (errorCount > 0) {
      console.log(`⚠️ Copy completed with ${errorCount} error(s). Source will NOT be deleted.`);
    } else if (!CONFIG.DRY_RUN) {
      console.log("ℹ️ No documents were copied.");
    }
  } catch (error) {
    console.error("💥 Fatal error during copy:", error);
  } finally {
    console.log("🚪 Script finished. Exiting.");
    process.exit(0);
  }
}

// Run
(async () => {
  await copyCollection();
})();
