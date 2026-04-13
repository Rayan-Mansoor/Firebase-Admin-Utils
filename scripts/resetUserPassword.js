// scripts/resetUserPassword.js
// Reset a user's Firebase Auth password and store the temp password in their Firestore document.
//
// Usage: set CONFIG below and run: `node scripts/resetUserPassword.js`

const { db, auth } = require("../firebaseAdmin");

/**
 * CONFIG
 * - USER_IDS: list of user UIDs to reset
 * - TEMP_PASSWORD: the temporary password to assign
 * - DRY_RUN: log what would happen without writing
 * - LOG_SAMPLES: show sample changes for up to N docs (0 disables)
 */
const CONFIG = {
  USER_IDS: ["oT7SP6aOBrWpds95gINaqQwaVu53"],
  TEMP_PASSWORD: "123456",

  DRY_RUN: false,
  LOG_SAMPLES: 10,
};

function validateConfig() {
  const { USER_IDS, TEMP_PASSWORD, DRY_RUN, LOG_SAMPLES } = CONFIG;

  if (!Array.isArray(USER_IDS) || USER_IDS.length === 0) {
    throw new Error("CONFIG.USER_IDS must be a non-empty array of UID strings.");
  }
  for (const uid of USER_IDS) {
    if (!uid || typeof uid !== "string") {
      throw new Error(`CONFIG.USER_IDS contains an invalid entry: ${JSON.stringify(uid)}`);
    }
  }
  if (!TEMP_PASSWORD || typeof TEMP_PASSWORD !== "string") {
    throw new Error("CONFIG.TEMP_PASSWORD must be a non-empty string.");
  }
  if (TEMP_PASSWORD.length < 6) {
    throw new Error("CONFIG.TEMP_PASSWORD must be at least 6 characters (Firebase minimum).");
  }
  if (typeof DRY_RUN !== "boolean") {
    throw new Error("CONFIG.DRY_RUN must be boolean.");
  }
  if (!Number.isInteger(LOG_SAMPLES) || LOG_SAMPLES < 0) {
    throw new Error("CONFIG.LOG_SAMPLES must be a non-negative integer.");
  }
}

async function resetUserPasswords() {
  validateConfig();

  console.log(
    "CONFIG:",
    JSON.stringify(
      {
        USER_IDS: CONFIG.USER_IDS.length,
        TEMP_PASSWORD: "***",
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
      // 1) Update Firebase Auth password
      await auth.updateUser(uid, { password: CONFIG.TEMP_PASSWORD });

      // 2) Store temp password in user's Firestore document
      await db.collection("users").doc(uid).update({
        "basicInfo.tempPassword": CONFIG.TEMP_PASSWORD,
      });

      updated++;

      if (CONFIG.LOG_SAMPLES && sampleLogged < CONFIG.LOG_SAMPLES) {
        sampleLogged++;
        console.log(`\n[Sample ${sampleLogged}] ${uid}`);
        console.log(` - Auth password updated`);
        console.log(` - basicInfo.tempPassword set`);
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
    const res = await resetUserPasswords();
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