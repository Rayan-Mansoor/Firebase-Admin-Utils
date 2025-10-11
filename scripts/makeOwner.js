// scripts/makeOwner.js
require("../firebaseAdmin");

const CONFIG = {
  EMAIL: "alcebologna@gmail.com", // <- put your email here (or set UID instead)
  UID: "4B5NBgQQUfSgVwLMtbL2GhBeNl33",                  // optional: use UID if you prefer
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
