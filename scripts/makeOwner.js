// scripts/makeOwner.js
const { admin } = require("../firebaseAdmin");

const CONFIG = {
  EMAIL: "alcebologna@gmail.com", // <- put your email here (or set UID instead)
  UID: "4B5NBgQQUfSgVwLMtbL2GhBeNl33",                  // optional: use UID if you prefer
  DRY_RUN: false,                 // true => preview only; no claim is written
};

(async () => {
  try {
    let uid = CONFIG.UID;
    if (!uid) {
      if (!CONFIG.EMAIL) throw new Error("Set CONFIG.EMAIL or CONFIG.UID");
      const u = await admin.auth().getUserByEmail(CONFIG.EMAIL);
      uid = u.uid;
    }

    const u = await admin.auth().getUser(uid);
    const claims = u.customClaims || {};

    if (CONFIG.DRY_RUN) {
      console.log("🧪 DRY_RUN is ON — no writes will be performed.");
      console.log(`→ (dry-run) would set owner=true on ${uid}`);
      console.log("✅ DRY RUN complete.");
      return;
    }

    await admin.auth().setCustomUserClaims(uid, { ...claims, owner: true });
    console.log(`✅ Set owner=true on ${uid}`);
    console.log("ℹ️ Now sign out/in (or force token refresh) in the client for it to take effect.");
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();
