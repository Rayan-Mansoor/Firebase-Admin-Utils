// scripts/auth/setCustomClaims.js
// Set custom claims on users, by uid or email: the roles and flags your security
// rules and backend read from ID tokens (request.auth.token.role).
//
// SET merges into each user's existing claims, REMOVE takes claims away, and
// REPLACE_ALL makes the claims exactly SET. Claims reach a user's ID token at its
// next refresh (within an hour); REVOKE_SESSIONS signs them out so the next
// sign-in carries the new claims at once.
//
// What it writes: each user whose claims change. Firebase's limits are checked
// first: no reserved names, at most 1,000 bytes of JSON.
//
// Why it's safe: the dry run (the default) shows each user's claims before and
// after. The armed run saves the Auth records it will change into backups/ first.
//
// Usage: set CONFIG below, run `node scripts/auth/setCustomClaims.js`, read the
// changes, then set DRY_RUN = false and run it again.

const { resolveUsers, validateUserLists, who, saveUserRecords } = require("../../lib/authUsers");
const { isMap, sameValue } = require("../../lib/fieldPaths");
const { banner, runMain } = require("../../lib/run");

// Names Firebase keeps for itself in ID tokens.
const RESERVED = ["acr", "amr", "at_hash", "aud", "auth_time", "azp", "cnf", "c_hash", "exp", "firebase", "iat", "iss", "jti", "nbf", "nonce", "sub"];
const MAX_BYTES = 1000;

/**
 * CONFIG
 * - USER_IDS, EMAILS: the users (either or both)
 * - SET: claims to add or change, e.g. { role: "admin" }
 * - REMOVE: claim names to take away
 * - REPLACE_ALL: true = the claims become exactly SET (REMOVE is then not needed)
 * - REVOKE_SESSIONS: sign the changed users out so new claims apply at once
 * - DRY_RUN: show the changes without writing
 */
const CONFIG = {
  USER_IDS: [],
  EMAILS: [],
  SET: {},
  REMOVE: [],
  REPLACE_ALL: false,
  REVOKE_SESSIONS: false,
  DRY_RUN: true,
};

function validateConfig(cfg = CONFIG) {
  validateUserLists(cfg);
  if (!isMap(cfg.SET)) throw new Error("CONFIG.SET must be an object.");
  if (!Array.isArray(cfg.REMOVE) || cfg.REMOVE.some((k) => typeof k !== "string" || !k)) throw new Error("CONFIG.REMOVE must list claim names.");
  if (!Object.keys(cfg.SET).length && !cfg.REMOVE.length && !cfg.REPLACE_ALL) throw new Error("Nothing to do: SET and REMOVE are empty.");
  const reserved = Object.keys(cfg.SET).find((k) => RESERVED.includes(k));
  if (reserved) throw new Error(`"${reserved}" is a name Firebase reserves; pick another claim name.`);
  const both = cfg.REMOVE.find((k) => k in cfg.SET);
  if (both) throw new Error(`"${both}" is in both SET and REMOVE.`);
  for (const k of ["REPLACE_ALL", "REVOKE_SESSIONS", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** A user's claims after the change, or an error when they'd break Firebase's size limit. */
function nextClaims(current, cfg) {
  const next = cfg.REPLACE_ALL ? { ...cfg.SET } : { ...(current || {}), ...cfg.SET };
  for (const k of cfg.REMOVE) delete next[k];
  const bytes = Buffer.byteLength(JSON.stringify(next));
  if (bytes > MAX_BYTES) return { error: `claims would be ${bytes} bytes; Firebase allows ${MAX_BYTES}` };
  return { claims: next };
}

async function main() {
  const { auth, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 Custom claims${CONFIG.REPLACE_ALL ? " replaced by" : ""} ${JSON.stringify(CONFIG.SET)}${CONFIG.REMOVE.length ? `, removing ${CONFIG.REMOVE.join(", ")}` : ""}`);
  banner(CONFIG.DRY_RUN);

  const { users, missing } = await resolveUsers(auth, { uids: CONFIG.USER_IDS, emails: CONFIG.EMAILS });
  const plans = [];
  for (const u of users) {
    const before = u.customClaims || {};
    const r = nextClaims(before, CONFIG);
    if (r.error) console.log(`   🔴 ${who(u)}: ${r.error}`);
    else if (!sameValue(before, r.claims)) plans.push({ user: u, before, after: r.claims });
  }
  console.log(`📊 ${users.length} users found, ${missing.length} not found; ${plans.length} would change.`);
  for (const p of plans) console.log(`   ✏️  ${who(p.user)}: ${JSON.stringify(p.before)} → ${JSON.stringify(p.after)}`);
  for (const m of missing) console.log(`   🔴 not found: ${m}`);

  if (CONFIG.DRY_RUN || !plans.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to change"}.`);
    return;
  }

  console.log(`💾 Auth records saved: ${saveUserRecords(plans.map((p) => p.user), { projectId, prefix: "set-custom-claims" })}`);
  let done = 0;
  for (const p of plans) {
    try {
      await auth.setCustomUserClaims(p.user.uid, Object.keys(p.after).length ? p.after : null);
      if (CONFIG.REVOKE_SESSIONS) await auth.revokeRefreshTokens(p.user.uid);
      done++;
    } catch (err) {
      console.error(`   ❌ ${who(p.user)}: ${err.message}`);
    }
  }
  console.log(`\n✅ Claims changed for ${done} of ${plans.length} users.${CONFIG.REVOKE_SESSIONS ? "" : " They apply at each user's next token refresh (within an hour)."}`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, nextClaims };
