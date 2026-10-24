// scripts/firestore/countDocuments.js
// Count documents without reading them: Firestore's count aggregation, billed as
// one read per 1,000 documents counted. Count every root collection, or chosen
// collections, collection groups and filtered queries.
//
// It only reads.
//
// Usage: set CONFIG below and run `node scripts/firestore/countDocuments.js`.

const { validateTarget, describeTarget, targetQuery } = require("../../lib/targets");
const { runMain } = require("../../lib/run");

/**
 * CONFIG
 * - TARGETS: [] = every root collection. Otherwise a list of
 *   { COLLECTION, USE_COLLECTION_GROUP?, WHERE? } (see lib/targets.js; DOC_IDS isn't used)
 */
const CONFIG = {
  TARGETS: [
    // { COLLECTION: "users" },
    // { COLLECTION: "users", WHERE: [["disabled", "==", true]] },
    // { COLLECTION: "posts", USE_COLLECTION_GROUP: true },
  ],
};

function validateConfig(cfg = CONFIG) {
  if (!Array.isArray(cfg.TARGETS)) throw new Error("CONFIG.TARGETS must be an array.");
  for (const t of cfg.TARGETS) {
    if (t?.DOC_IDS?.length) throw new Error("countDocuments counts queries; DOC_IDS isn't used.");
    validateTarget(t || {});
  }
}

/** A table of [label, count] rows, the counts right-aligned. */
function formatTable(rows) {
  const width = Math.max(...rows.map(([label]) => label.length), 5);
  const numWidth = Math.max(...rows.map(([, n]) => n.toLocaleString("en-US").length));
  return rows.map(([label, n]) => `   ${label.padEnd(width)}  ${n.toLocaleString("en-US").padStart(numWidth)}`).join("\n");
}

async function main() {
  const { db } = require("../../firebaseAdmin");
  validateConfig();
  const targets = CONFIG.TARGETS.length
    ? CONFIG.TARGETS
    : (await db.listCollections()).map((c) => ({ COLLECTION: c.id }));
  if (!targets.length) {
    console.log("The database has no root collections.");
    return;
  }
  const rows = await Promise.all(targets.map(async (t) => [describeTarget(t), (await targetQuery(db, t).count().get()).data().count]));
  console.log(`📊 Document counts${CONFIG.TARGETS.length ? "" : " (root collections)"}:`);
  console.log(formatTable(rows));
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, formatTable };
