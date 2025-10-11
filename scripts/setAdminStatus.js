// scripts/setAdminStatus.js
const { auth, db } = require("../firebaseAdmin");


// 2) Simple config block you can edit before running
const CONFIG = {
  TARGET_EMAIL: "rayanmansoor45@gmail.com", // <-- change this
  MAKE_ADMIN: false,                    // true => grant, false => revoke
  CALLER_UID: "4B5NBgQQUfSgVwLMtbL2GhBeNl33",           // uid of the owner performing this action
  ALLOW_SELF_DEMOTE: false,            // prevent owner from revoking their own admin
  SKIP_OWNER_CHECK: false,             // set true only for first-time bootstrap
};

async function setAdminStatus() {
  console.log("🚀 Starting setAdminStatus...");

  const { TARGET_EMAIL, MAKE_ADMIN, CALLER_UID, ALLOW_SELF_DEMOTE, SKIP_OWNER_CHECK } = CONFIG;

  try {
    // --- Input validation (keep it simple & explicit) ---
    if (!TARGET_EMAIL || typeof TARGET_EMAIL !== "string" || !TARGET_EMAIL.includes("@")) {
      throw new Error("Valid TARGET_EMAIL is required (string with '@').");
    }
    if (typeof MAKE_ADMIN !== "boolean") {
      throw new Error("MAKE_ADMIN must be a boolean (true|false).");
    }

    // --- Owner authorization (mirrors your CF logic, but simple) ---
    if (!SKIP_OWNER_CHECK) {
      if (!CALLER_UID) throw new Error("CALLER_UID is required for owner check.");
      let caller;
      try {
        caller = await auth.getUser(CALLER_UID);
      } catch (e) {
        if (e && e.code === "auth/user-not-found") {
          throw new Error("Caller not found in Auth.");
        }
        throw new Error(`Failed to fetch caller: ${e.message}`);
      }
      const claims = caller.customClaims || {};
      if (claims.owner !== true) {
        throw new Error("Action requires owner privileges (custom claim owner=true).");
      }
    }

    console.log(`🔎 Looking up target by email: ${TARGET_EMAIL}`);
    const userRecord = await auth.getUserByEmail(TARGET_EMAIL);
    const targetUid = userRecord.uid;
    const currentClaims = userRecord.customClaims || {};

    // Prevent owner self-demotion unless explicitly allowed
    if (!ALLOW_SELF_DEMOTE && currentClaims.owner && !MAKE_ADMIN && targetUid === CALLER_UID) {
      console.log("⛔ Owner self-demotion is blocked by ALLOW_SELF_DEMOTE=false. Aborting.");
      return;
    }

    // Merge custom claims (preserve unrelated claims like 'owner')
    const newClaims = { ...currentClaims, admin: MAKE_ADMIN };
    await auth.setCustomUserClaims(targetUid, newClaims);
    console.log(`✔️  Updated custom claims for ${targetUid}: admin=${MAKE_ADMIN}`);

    // Sync Firestore 'admins' collection
    const adminDocRef = db.collection("admins").doc(targetUid);
    if (MAKE_ADMIN) {
      await adminDocRef.set(
        {
          email: userRecord.email,
          displayName: userRecord.displayName || null,
          addedBy: CALLER_UID || null,
          addedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.log(`✔️  Upserted Firestore admins/${targetUid}`);
      console.log(`🎉 ${TARGET_EMAIL} is now an admin.`);
    } else {
      await adminDocRef.delete().catch((e) => {
        // Ignore not-found (code 5 in Firestore gRPC or string "not-found")
        if (!(e && (e.code === 5 || e.code === "not-found"))) throw e;
      });
      console.log(`✔️  Removed Firestore admins/${targetUid}`);
      console.log(`ℹ️  Admin status revoked for ${TARGET_EMAIL}.`);
    }

    console.log("✅ Done. Note: target must refresh their ID token for new claims to take effect.");

  } catch (error) {
    console.error("❌ setAdminStatus failed:", error.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

setAdminStatus();