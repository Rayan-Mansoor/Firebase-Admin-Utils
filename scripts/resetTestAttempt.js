// scripts/resetTestAttempt.js
// Reset a user's test attempt. Supports two modes:
//   - "initial": clears progress flags, looks up the initial test ID from app_config, and deletes the attempt
//   - "specific": deletes the attempt doc for a given test ID
//
// Usage: set CONFIG below and run: `node scripts/resetTestAttempt.js`

const { db } = require("../firebaseAdmin");

/**
 * CONFIG
 * - MODE: "initial" | "specific"
 * - USER_IDS: list of user UIDs to reset
 * - TEST_ID: required when MODE is "specific" (ignored for "initial")
 * - DRY_RUN: log what would happen without writing
 * - LOG_SAMPLES: show sample changes for up to N docs (0 disables)
 */
const CONFIG = {
  MODE: "initial",
  USER_IDS: ["bRTinDWP4qbVb5ZRaHXF8wJgCZu2"],
  TEST_ID: "",

  DRY_RUN: false,
  LOG_SAMPLES: 10,
};

function validateConfig() {
  const { MODE, USER_IDS, TEST_ID, DRY_RUN, LOG_SAMPLES } = CONFIG;

  const allowedModes = new Set(["initial", "specific"]);
  if (!allowedModes.has(MODE)) {
    throw new Error(`CONFIG.MODE must be one of: ${[...allowedModes].join(", ")}`);
  }
  if (!Array.isArray(USER_IDS) || USER_IDS.length === 0) {
    throw new Error("CONFIG.USER_IDS must be a non-empty array of UID strings.");
  }
  for (const uid of USER_IDS) {
    if (!uid || typeof uid !== "string") {
      throw new Error(`CONFIG.USER_IDS contains an invalid entry: ${JSON.stringify(uid)}`);
    }
  }
  if (MODE === "specific") {
    if (!TEST_ID || typeof TEST_ID !== "string") {
      throw new Error('CONFIG.TEST_ID must be a non-empty string when MODE is "specific".');
    }
  }
  if (typeof DRY_RUN !== "boolean") {
    throw new Error("CONFIG.DRY_RUN must be boolean.");
  }
  if (!Number.isInteger(LOG_SAMPLES) || LOG_SAMPLES < 0) {
    throw new Error("CONFIG.LOG_SAMPLES must be a non-negative integer.");
  }
}

async function getInitialTestId() {
  const doc = await db.collection("app_config").doc("test-settings").get();
  if (!doc.exists) {
    throw new Error('app_config/test-settings document not found.');
  }
  const id = doc.data()?.initialTestId;
  if (!id || typeof id !== "string") {
    throw new Error('initialTestId is missing or invalid in app_config/test-settings.');
  }
  return id;
}

async function resetTestAttempts() {
  validateConfig();

  const testId = CONFIG.MODE === "initial"
    ? await getInitialTestId()
    : CONFIG.TEST_ID;

  console.log(
    "CONFIG:",
    JSON.stringify(
      {
        MODE: CONFIG.MODE,
        USER_IDS: CONFIG.USER_IDS.length,
        TEST_ID: testId,
        DRY_RUN: CONFIG.DRY_RUN,
        LOG_SAMPLES: CONFIG.LOG_SAMPLES,
      },
      null,
      2
    )
  );

  if (CONFIG.DRY_RUN) {
    const sampleCount = Math.min(CONFIG.LOG_SAMPLES || 0, CONFIG.USER_IDS.length);
    console.log(`DRY_RUN is ON — showing up to ${sampleCount} sample UIDs:`);
    for (let i = 0; i < sampleCount; i++) console.log(` - ${CONFIG.USER_IDS[i]}`);
    console.log("No writes performed.");
    return { updated: 0, errors: 0, dryRun: true };
  }

  let updated = 0;
  let errors = 0;
  let sampleLogged = 0;

  for (const uid of CONFIG.USER_IDS) {
    try {
      const changes = [];

      // 1) For initial mode, reset progress flags
      if (CONFIG.MODE === "initial") {
        await db.collection("users").doc(uid).update({
          "progress.firstTestCompleted": false,
          "progress.firstTestCompletedAt": null,
        });
        changes.push("progress.firstTestCompleted → false");
        changes.push("progress.firstTestCompletedAt → null");
      }

      // 2) Delete the attempt doc
      const attemptRef = db
        .collection("tests")
        .doc(testId)
        .collection("attempts")
        .doc(uid);

      const attemptSnap = await attemptRef.get();
      if (attemptSnap.exists) {
        await attemptRef.delete();
        changes.push(`tests/${testId}/attempts/${uid} deleted`);
      } else {
        changes.push(`tests/${testId}/attempts/${uid} not found (skipped)`);
      }

      updated++;

      if (CONFIG.LOG_SAMPLES && sampleLogged < CONFIG.LOG_SAMPLES) {
        sampleLogged++;
        console.log(`\n[Sample ${sampleLogged}] ${uid}`);
        for (const c of changes) console.log(` - ${c}`);
      }
    } catch (e) {
      console.error(`❌ Failed for ${uid}: ${e?.message || e}`);
      errors++;
    }
  }

  console.log("\n📊 Summary");
  console.log(`   Updated: ${updated}`);
  console.log(`   Errors:  ${errors}`);
  return { updated, errors, dryRun: false };
}

(async () => {
  try {
    const res = await resetTestAttempts();
    if (res.dryRun) {
      console.log("✅ DRY RUN complete.");
    } else {
      console.log(`✅ Done. Updated ${res.updated} user(s).`);
    }
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();