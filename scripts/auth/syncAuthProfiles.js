// scripts/auth/syncAuthProfiles.js
// Copy profile details from your user documents into Firebase Auth: the display
// name, photo URL and phone number that Auth (and anything reading ID tokens or
// the Auth console) shows. A value can be one field or several joined, such as
// first and last name.
//
// What it writes: each Auth user whose mapped values differ from what Auth has.
// An empty value is skipped, never written over a set one. The documents are only read.
//
// Why it's safe: the dry run (the default) lists every change, old and new, and
// the documents with no Auth user. The armed run saves the Auth records it will
// change into backups/ first.
//
// Usage: set CONFIG below, run `node scripts/auth/syncAuthProfiles.js`, read the
// changes, then set DRY_RUN = false and run it again.

const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath } = require("../../lib/fieldPaths");
const { resolveUsers, who, saveUserRecords } = require("../../lib/authUsers");
const { banner, runMain } = require("../../lib/run");

const PROFILE_KEYS = ["displayName", "photoURL", "phoneNumber"];

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: the user documents (see lib/targets.js)
 * - UID_FIELD: null when the document id is the uid, or the field that holds it
 * - MAPPING: Auth profile key → a field path, or a list of paths joined with spaces
 *     displayName  e.g. ["profile.firstName", "profile.lastName"]
 *     photoURL     e.g. "avatarUrl"
 *     phoneNumber  e.g. "phone" (E.164, like "+390511234567")
 * - DRY_RUN: list the changes without writing
 * - LOG_SAMPLES: how many changes to print
 */
const CONFIG = {
  COLLECTION: "users",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],
  UID_FIELD: null,

  MAPPING: {
    displayName: ["firstName", "lastName"],
    // photoURL: "photoUrl",
    // phoneNumber: "phone",
  },

  DRY_RUN: true,
  LOG_SAMPLES: 25,
};

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  if (cfg.UID_FIELD !== null && (typeof cfg.UID_FIELD !== "string" || !cfg.UID_FIELD)) throw new Error("CONFIG.UID_FIELD must be a field path or null.");
  const keys = Object.keys(cfg.MAPPING || {});
  if (!keys.length) throw new Error("CONFIG.MAPPING must map at least one of displayName, photoURL, phoneNumber.");
  for (const k of keys) {
    if (!PROFILE_KEYS.includes(k)) throw new Error(`MAPPING.${k}: Auth profiles have ${PROFILE_KEYS.join(", ")}.`);
    const paths = [].concat(cfg.MAPPING[k]);
    if (!paths.length || paths.some((p) => typeof p !== "string" || !p)) throw new Error(`MAPPING.${k} must be a field path or a list of them.`);
  }
  if (typeof cfg.DRY_RUN !== "boolean") throw new Error("CONFIG.DRY_RUN must be boolean.");
}

/** The profile a document maps to: only keys with a non-empty value. */
function profileFrom(data, mapping) {
  const out = {};
  for (const [key, spec] of Object.entries(mapping)) {
    const value = [].concat(spec).map((p) => getByPath(data, p)).filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()).join(" ");
    if (value) out[key] = value;
  }
  return out;
}

/** What to send to auth.updateUser for this user: the keys whose value differs. */
function profileChanges(user, profile) {
  return Object.fromEntries(Object.entries(profile).filter(([k, v]) => (user[k] ?? null) !== v));
}

async function main() {
  const { auth, db, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Sync ${Object.keys(CONFIG.MAPPING).join(", ")} into Auth from ${describeTarget(CONFIG)}`);
  banner(CONFIG.DRY_RUN);

  const profiles = new Map(); // uid → profile
  let noUid = 0;
  for await (const snap of targetDocs(db, CONFIG)) {
    const uid = CONFIG.UID_FIELD ? getByPath(snap.data(), CONFIG.UID_FIELD) : snap.id;
    if (typeof uid !== "string" || !uid) {
      noUid++;
      continue;
    }
    profiles.set(uid, profileFrom(snap.data(), CONFIG.MAPPING));
  }
  const { users, missing } = await resolveUsers(auth, { uids: [...profiles.keys()] });
  const plans = users.map((u) => ({ user: u, changes: profileChanges(u, profiles.get(u.uid)) })).filter((p) => Object.keys(p.changes).length);

  console.log(`📊 ${profiles.size} documents; ${users.length} with an Auth user; ${plans.length} to update; ${missing.length} without an Auth user${noUid ? `; ${noUid} without a uid` : ""}.`);
  for (const p of plans.slice(0, CONFIG.LOG_SAMPLES)) {
    console.log(`   ✏️  ${who(p.user)}: ${Object.entries(p.changes).map(([k, v]) => `${k} ${JSON.stringify(p.user[k] ?? null)} → ${JSON.stringify(v)}`).join("; ")}`);
  }
  if (plans.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${plans.length - CONFIG.LOG_SAMPLES} more.`);
  for (const m of missing.slice(0, 10)) console.log(`   🟡 no Auth user: ${m}`);

  if (CONFIG.DRY_RUN || !plans.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to update"}.`);
    return;
  }

  console.log(`💾 Auth records saved: ${saveUserRecords(plans.map((p) => p.user), { projectId, prefix: "sync-auth-profiles" })}`);
  let done = 0;
  for (const p of plans) {
    try {
      await auth.updateUser(p.user.uid, p.changes);
      done++;
    } catch (err) {
      console.error(`   ❌ ${who(p.user)}: ${err.message}`);
    }
  }
  console.log(`\n✅ Updated ${done} of ${plans.length} Auth users.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, profileFrom, profileChanges };
