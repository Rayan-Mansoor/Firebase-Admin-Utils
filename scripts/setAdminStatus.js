// scripts/setAdminStatus.js
const { auth, db, admin } = require("../firebaseAdmin");


// 2) Simple config block you can edit before running
const CONFIG = {
  TARGET_EMAIL: "rayanmansoor45@gmail.com", // <-- change this
  MAKE_ADMIN: false,                    // true => grant, false => revoke
  CALLER_UID: "4B5NBgQQUfSgVwLMtbL2GhBeNl33",           // uid of the admin performing this action
  ALLOW_SELF_DEMOTE: false,            // prevent an admin from revoking their own access
  SKIP_CALLER_CHECK: false,            // set true only for first-time bootstrap
  DRY_RUN: false,                      // true => preview only; no claims/Firestore writes
};

async function setAdminStatus() {
  console.log("🚀 Starting setAdminStatus...");

  const { TARGET_EMAIL, MAKE_ADMIN, CALLER_UID, ALLOW_SELF_DEMOTE, SKIP_CALLER_CHECK, DRY_RUN } = CONFIG;

  try {
    // --- Input validation (keep it simple & explicit) ---
    if (!TARGET_EMAIL || typeof TARGET_EMAIL !== "string" || !TARGET_EMAIL.includes("@")) {
      throw new Error("Valid TARGET_EMAIL is required (string with '@').");
    }
    if (typeof MAKE_ADMIN !== "boolean") {
      throw new Error("MAKE_ADMIN must be a boolean (true|false).");
    }

    // --- Caller authorization (mirrors requireAdmin in the CF guards) ---
    if (!SKIP_CALLER_CHECK) {
      if (!CALLER_UID) throw new Error("CALLER_UID is required for the caller check.");
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
      if (claims.admin !== true) {
        throw new Error("Action requires admin privileges (custom claim admin=true).");
      }
    }

    console.log(`🔎 Looking up target by email: ${TARGET_EMAIL}`);
    const userRecord = await auth.getUserByEmail(TARGET_EMAIL);
    const targetUid = userRecord.uid;
    const currentClaims = userRecord.customClaims || {};

    // Prevent self-demotion unless explicitly allowed: revoking your own
    // admin claim locks you out of the panel, and of this script.
    if (!ALLOW_SELF_DEMOTE && currentClaims.admin && !MAKE_ADMIN && targetUid === CALLER_UID) {
      console.log("⛔ Self-demotion is blocked by ALLOW_SELF_DEMOTE=false. Aborting.");
      return;
    }

    // `admin` is the whole account type; there are no other claims to keep.
    const newClaims = { ...currentClaims, admin: MAKE_ADMIN };

    if (DRY_RUN) {
      console.log("🧪 DRY_RUN is ON — no writes will be performed.");
      console.log(`→ (dry-run) would set custom claims for ${targetUid}: admin=${MAKE_ADMIN}`);
      console.log(`→ (dry-run) would ${MAKE_ADMIN ? `upsert admins/${targetUid}` : `delete admins/${targetUid}`}`);
      console.log("✅ DRY RUN complete.");
      return;
    }

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