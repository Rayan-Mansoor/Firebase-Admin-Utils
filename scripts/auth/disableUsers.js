// scripts/auth/disableUsers.js
// Disable accounts, so they can't sign in, or enable them again, by uid or email.
// Disabling keeps the account and its data, unlike deleteAuthUsers.js.
//
// A disabled account can't refresh its token, but a token it already holds stays
// valid for up to an hour; REVOKE_SESSIONS (on by default when disabling) revokes
// it, for backends that verify tokens with checkRevoked.
//
// What it writes: each account not already in the wanted state.
//
// Why it's safe: the dry run (the default) lists the accounts and their state.
// The armed run saves their Auth records into backups/ first, and running it with
// DISABLE: false undoes it.
//
// Usage: set CONFIG below, run `node scripts/auth/disableUsers.js`, read the list,
// then set DRY_RUN = false and run it again.

const { resolveUsers, validateUserLists, who, saveUserRecords } = require("../../lib/authUsers");
const { banner, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - USER_IDS, EMAILS: the accounts (either or both)
 * - DISABLE: true = disable, false = enable again
 * - REVOKE_SESSIONS: also revoke their sessions (only applies when disabling)
 * - DRY_RUN: list without changing anything
 */
const CONFIG = {
  USER_IDS: [],
  EMAILS: [],
  DISABLE: true,
  REVOKE_SESSIONS: true,
  DRY_RUN: true,
};

function validateConfig(cfg = CONFIG) {
  validateUserLists(cfg);
  for (const k of ["DISABLE", "REVOKE_SESSIONS", "DRY_RUN"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(`CONFIG.${k} must be boolean.`);
  }
}

/** The accounts that need changing: those whose `disabled` isn't the wanted state. */
const toChange = (users, disable) => users.filter((u) => Boolean(u.disabled) !== disable);

async function main() {
  const { auth, projectId } = require("../../firebaseAdmin");
  validateConfig();
  const verb = CONFIG.DISABLE ? "Disable" : "Enable";
  console.log(`🚀 ${verb} accounts${CONFIG.DISABLE && CONFIG.REVOKE_SESSIONS ? " and revoke their sessions" : ""}`);
  banner(CONFIG.DRY_RUN);

  const { users, missing } = await resolveUsers(auth, { uids: CONFIG.USER_IDS, emails: CONFIG.EMAILS });
  const changes = toChange(users, CONFIG.DISABLE);
  console.log(`📊 ${users.length} accounts found, ${missing.length} not found; ${changes.length} to ${verb.toLowerCase()}, ${users.length - changes.length} already ${CONFIG.DISABLE ? "disabled" : "enabled"}.`);
  for (const u of changes) console.log(`   ${CONFIG.DISABLE ? "⛔" : "✅"} ${who(u)}`);
  for (const m of missing) console.log(`   🔴 not found: ${m}`);

  if (CONFIG.DRY_RUN || !changes.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to change"}.`);
    return;
  }

  console.log(`💾 Auth records saved: ${saveUserRecords(changes, { projectId, prefix: CONFIG.DISABLE ? "disable-users" : "enable-users" })}`);
  let done = 0;
  for (const u of changes) {
    try {
      await auth.updateUser(u.uid, { disabled: CONFIG.DISABLE });
      if (CONFIG.DISABLE && CONFIG.REVOKE_SESSIONS) await auth.revokeRefreshTokens(u.uid);
      done++;
    } catch (err) {
      console.error(`   ❌ ${who(u)}: ${err.message}`);
    }
  }
  console.log(`\n✅ ${CONFIG.DISABLE ? "Disabled" : "Enabled"} ${done} of ${changes.length} accounts.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, toChange };
