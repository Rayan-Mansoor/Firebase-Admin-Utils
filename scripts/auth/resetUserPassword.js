// scripts/auth/resetUserPassword.js
// Give users a temporary password, by uid or email, so you can hand it to them
// (support requests, test accounts). Optionally sign them out everywhere, and
// optionally store the temporary password in a field of each user's document,
// for apps that show it or ask for a change at next sign-in.
//
// What it writes: each user's Auth password (and refresh tokens revoked with
// REVOKE_SESSIONS); with FIRESTORE_FIELD, that field on <collection>/<uid>.
//
// Why it's safe: the dry run (the default) lists the users it found and the uids or
// emails it didn't. A password can't be saved or put back, so check the list. With
// FIRESTORE_FIELD, each document it changes is saved into backups/ first.
//
// Usage: set CONFIG below, run `node scripts/auth/resetUserPassword.js`, read the
// list, then set DRY_RUN = false and run it again.

const { resolveUsers, validateUserLists, who } = require("../../lib/authUsers");
const { saveBeforeState } = require("../../lib/beforeState");
const { applyWrites, printFailures } = require("../../lib/writes");
const { banner, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - USER_IDS, EMAILS: the users (either or both)
 * - TEMP_PASSWORD: the password they get (at least 6 characters)
 * - REVOKE_SESSIONS: also sign them out on every device
 * - FIRESTORE_FIELD: null, or { collection: "users", field: "tempPassword" } to store the
 *   password on <collection>/<uid> too (the document must exist)
 * - DRY_RUN: list the users without changing anything
 */
const CONFIG = {
  USER_IDS: [],
  EMAILS: [],
  TEMP_PASSWORD: "",
  REVOKE_SESSIONS: false,
  FIRESTORE_FIELD: null,
  DRY_RUN: true,
};

function validateConfig(cfg = CONFIG) {
  validateUserLists(cfg);
  if (typeof cfg.TEMP_PASSWORD !== "string" || cfg.TEMP_PASSWORD.length < 6) {
    throw new Error("CONFIG.TEMP_PASSWORD must be at least 6 characters (Firebase's minimum).");
  }
  const f = cfg.FIRESTORE_FIELD;
  if (f !== null && (!f || typeof f.collection !== "string" || !f.collection || typeof f.field !== "string" || !f.field)) {
    throw new Error("CONFIG.FIRESTORE_FIELD must be null or { collection, field }.");
  }
  for (const k of ["REVOKE_SESSIONS", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

async function main() {
  const { auth, db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Temporary password for ${CONFIG.USER_IDS.length + CONFIG.EMAILS.length} users${CONFIG.REVOKE_SESSIONS ? ", signed out everywhere" : ""}${CONFIG.FIRESTORE_FIELD ? `, stored in ${CONFIG.FIRESTORE_FIELD.collection}/<uid>.${CONFIG.FIRESTORE_FIELD.field}` : ""}`);
  banner(CONFIG.DRY_RUN);

  const { users, missing } = await resolveUsers(auth, { uids: CONFIG.USER_IDS, emails: CONFIG.EMAILS });
  let docs = [];
  if (CONFIG.FIRESTORE_FIELD) {
    const col = db.collection(CONFIG.FIRESTORE_FIELD.collection);
    docs = users.length ? await db.getAll(...users.map((u) => col.doc(u.uid))) : [];
  }
  const noDoc = docs.filter((s) => !s.exists).map((s) => s.id);
  console.log(`📊 ${users.length} users found; ${missing.length} not found${CONFIG.FIRESTORE_FIELD ? `; ${noDoc.length} without a document` : ""}.`);
  for (const u of users) console.log(`   🔑 ${who(u)}`);
  for (const m of missing) console.log(`   🔴 not found: ${m}`);
  for (const id of noDoc) console.log(`   🟡 no document for ${id}: its field is skipped`);

  if (CONFIG.DRY_RUN || !users.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "No users to change"}.`);
    return;
  }

  const withDoc = docs.filter((s) => s.exists);
  if (withDoc.length) console.log(`💾 Before-state saved: ${await saveBeforeState(withDoc, { projectId, prefix: "reset-user-password" })}`);
  let done = 0;
  for (const u of users) {
    try {
      await auth.updateUser(u.uid, { password: CONFIG.TEMP_PASSWORD });
      if (CONFIG.REVOKE_SESSIONS) await auth.revokeRefreshTokens(u.uid);
      done++;
    } catch (err) {
      console.error(`   ❌ ${who(u)}: ${err.message}`);
    }
  }
  console.log(`✅ Password set for ${done} of ${users.length} users.`);
  if (withDoc.length) {
    const { done: written, failures } = await applyWrites(db, withDoc.map((s) => ({
      op: "update", path: s.ref.path, data: { [CONFIG.FIRESTORE_FIELD.field]: CONFIG.TEMP_PASSWORD }, lastUpdateTime: s.updateTime,
    })));
    printFailures(failures);
    console.log(`✅ Stored on ${written} of ${withDoc.length} documents.`);
  }
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig };
