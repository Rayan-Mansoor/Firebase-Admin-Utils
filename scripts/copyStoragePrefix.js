// scripts/copyStoragePrefix.js
// Copy all Cloud Storage objects from FROM_PREFIX to TO_PREFIX.
// Optional dry-run logging; no deletions unless you later add a destructive mode.
//
// Usage: set CONFIG below, then run: `node scripts/copyStoragePrefix.js`

const { bucket } = require("../firebaseAdmin");

/**
 * CONFIG
 * - FROM_PREFIX: source prefix to copy from
 * - TO_PREFIX:   destination prefix to copy to
 * - DRY_RUN:     true = log what would be done without copying
 * - SKIP_IF_EXISTS: if true, don't overwrite destination objects that already exist
 * - SAMPLE_PEEK: number of objects to list when showing a peek (used on empty results)
 */
const CONFIG = {
  FROM_PREFIX: "accommodationItems/",
  TO_PREFIX: "accommodations/",
  DRY_RUN: false,
  SKIP_IF_EXISTS: false,
  SAMPLE_PEEK: 200,
};

function validateConfig() {
  const { FROM_PREFIX, TO_PREFIX, DRY_RUN, SKIP_IF_EXISTS, SAMPLE_PEEK } = CONFIG;

  if (!FROM_PREFIX || typeof FROM_PREFIX !== "string") {
    throw new Error("CONFIG.FROM_PREFIX must be a non-empty string.");
  }
  if (!TO_PREFIX || typeof TO_PREFIX !== "string") {
    throw new Error("CONFIG.TO_PREFIX must be a non-empty string.");
  }
  if (normalizePrefix(FROM_PREFIX) === normalizePrefix(TO_PREFIX)) {
    throw new Error("FROM_PREFIX and TO_PREFIX cannot be identical.");
  }
  if (typeof DRY_RUN !== "boolean") {
    throw new Error("CONFIG.DRY_RUN must be boolean.");
  }
  if (typeof SKIP_IF_EXISTS !== "boolean") {
    throw new Error("CONFIG.SKIP_IF_EXISTS must be boolean.");
  }
  if (!Number.isInteger(SAMPLE_PEEK) || SAMPLE_PEEK <= 0) {
    throw new Error("CONFIG.SAMPLE_PEEK must be a positive integer.");
  }
}

const normalizePrefix = (p) => (p.endsWith("/") ? p : p + "/");

async function peekBucket(sample = CONFIG.SAMPLE_PEEK) {
  const [files] = await bucket.getFiles({ maxResults: sample });
  console.log(`\n👀 Peek (${files.length} sample objects):`);
  files.forEach((f) => console.log(" -", f.name));
  // Show "top-level folders" (first segment before '/')
  const tops = new Set(
    files
      .map((f) => f.name.split("/")[0])
      .filter((s) => s && !s.includes("."))
  );
  if (tops.size) {
    console.log("\n📂 Top-level prefixes seen:");
    [...tops].slice(0, 50).forEach((t) => console.log(" •", t + "/"));
    if (tops.size > 50) console.log(" • ...");
  }
  console.log();
}

/** Main routine — uses CONFIG directly (no positional args). */
async function copyStoragePrefix() {
  validateConfig();

  const from = normalizePrefix(CONFIG.FROM_PREFIX);
  const to = normalizePrefix(CONFIG.TO_PREFIX);

  console.log(
    "CONFIG:",
    JSON.stringify(
      {
        BUCKET: bucket.name,
        FROM_PREFIX: from,
        TO_PREFIX: to,
        DRY_RUN: CONFIG.DRY_RUN,
        SKIP_IF_EXISTS: CONFIG.SKIP_IF_EXISTS,
        SAMPLE_PEEK: CONFIG.SAMPLE_PEEK,
      },
      null,
      2
    )
  );

  console.log("📄 Fetching object list…");
  const [files] = await bucket.getFiles({ prefix: from }); // includes nested
  console.log(`📊 Found ${files.length} object(s) under '${from}'`);

  if (files.length === 0) {
    console.log("ℹ️  No objects matched that prefix. Dumping a quick peek so you can verify actual paths.");
    await peekBucket(CONFIG.SAMPLE_PEEK);
    return { copied: 0, errors: 0, dryRun: CONFIG.DRY_RUN };
  }

  let copied = 0;
  let errors = 0;

  for (const file of files) {
    const rel = file.name.slice(from.length);
    if (!rel) {
      // skip the prefix placeholder entry if any
      console.log(`⏭️  Skip placeholder object: ${file.name}`);
      continue;
    }

    const destName = to + rel;
    const destFile = bucket.file(destName);

    try {
      if (CONFIG.SKIP_IF_EXISTS) {
        const [exists] = await destFile.exists();
        if (exists) {
          console.log(`⏭️  Skip (exists): ${destName}`);
          continue;
        }
      }

      if (CONFIG.DRY_RUN) {
        console.log(`→ (dry-run) would copy: ${file.name} -> ${destName}`);
      } else {
        await file.copy(destFile); // copy only; keep originals
        console.log(`✅ Copied: ${file.name} -> ${destName}`);
        copied++;
      }
    } catch (e) {
      console.error(`❌ Failed: ${file.name} -> ${destName} | ${e?.message || e}`);
      errors++;
    }
  }

  console.log("\n📊 Summary");
  console.log(`   Copied:  ${copied}${CONFIG.DRY_RUN ? " (would copy in dry-run)" : ""}`);
  console.log(`   Errors:  ${errors}`);
  return { copied, errors, dryRun: CONFIG.DRY_RUN };
}

(async () => {
  try {
    const res = await copyStoragePrefix();
    if (res.dryRun) {
      console.log("✅ DRY RUN complete.");
    } else {
      console.log("✅ Done.");
    }
    process.exit(0);
  } catch (e) {
    console.error("💥 Fatal:", e?.message || e);
    process.exit(1);
  }
})();