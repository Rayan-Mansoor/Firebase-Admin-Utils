// scripts/auth/deleteAuthUsers.js
// Delete Auth accounts: the ones you name by uid or email, or every account a
// filter matches, such as anonymous accounts that piled up, or accounts nobody has
// signed in to for a year.
//
// FILTER picks accounts by being anonymous, inactive for INACTIVE_DAYS (last
// sign-in, or creation for an account never signed in to) and/or disabled; every
// filter set must hold. Firestore documents are not touched: auditAuthUsers.js and
// deleteCollection.js deal with those.
//
// What it writes: account deletions, 1,000 per request.
//
// Why it's safe: the dry run (the default) counts and lists the accounts. The
// armed run needs CONFIRM_PROJECT_ID and saves every account's record into
// backups/ first (for reference: a deleted account can't simply be restored).
//
// Usage: set CONFIG below, run `node scripts/auth/deleteAuthUsers.js`, read the
// list, then set DRY_RUN = false and CONFIRM_PROJECT_ID and run it again.

const { resolveUsers, listAllUsers, isAnonymous, who, saveUserRecords } = require("../../lib/authUsers");
const { banner, runMain } = require("../../lib/run");

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETE_BATCH = 1000;

/**
 * CONFIG
 * - USER_IDS, EMAILS: delete these accounts. When either is set, FILTER is ignored.
 * - FILTER: or delete every account matching all of the filters set
 *     ANONYMOUS: true          anonymous accounts only
 *     INACTIVE_DAYS: 365       no sign-in for this many days (or never, since creation)
 *     DISABLED: true           disabled accounts only
 * - CONFIRM_PROJECT_ID: the project id, typed in, for an armed run
 * - DRY_RUN: list without deleting
 * - LOG_SAMPLES: how many accounts to print
 */
const CONFIG = {
  USER_IDS: [],
  EMAILS: [],
  FILTER: {
    ANONYMOUS: false,
    INACTIVE_DAYS: null,
    DISABLED: false,
  },
  CONFIRM_PROJECT_ID: "",
  DRY_RUN: true,
  LOG_SAMPLES: 25,
};

function validateConfig(cfg = CONFIG) {
  for (const k of ["USER_IDS", "EMAILS"]) {
    if (!Array.isArray(cfg[k]) || cfg[k].some((v) => typeof v !== "string" || !v.trim())) throw new Error(`CONFIG.${k} must be a list of non-empty strings.`);
  }
  const f = cfg.FILTER || {};
  if (f.INACTIVE_DAYS !== null && f.INACTIVE_DAYS !== undefined && !(Number.isFinite(f.INACTIVE_DAYS) && f.INACTIVE_DAYS > 0)) {
    throw new Error("FILTER.INACTIVE_DAYS must be a positive number or null.");
  }
  const byList = cfg.USER_IDS.length || cfg.EMAILS.length;
  if (!byList && !f.ANONYMOUS && !f.DISABLED && !f.INACTIVE_DAYS) {
    throw new Error("Name accounts in USER_IDS / EMAILS, or set at least one FILTER.");
  }
  if (typeof cfg.DRY_RUN !== "boolean") throw new Error("CONFIG.DRY_RUN must be boolean.");
}

/** Whether an account matches every filter set. */
function matchesFilter(user, filter, nowMs) {
  if (filter.ANONYMOUS && !isAnonymous(user)) return false;
  if (filter.DISABLED && !user.disabled) return false;
  if (filter.INACTIVE_DAYS) {
    const last = Date.parse(user.metadata?.lastSignInTime || user.metadata?.creationTime || "");
    if (Number.isNaN(last) || nowMs - last < filter.INACTIVE_DAYS * DAY_MS) return false;
  }
  return true;
}

async function main() {
  const { auth, projectId } = require("../../firebaseAdmin");
  validateConfig();
  const byList = CONFIG.USER_IDS.length > 0 || CONFIG.EMAILS.length > 0;
  const f = CONFIG.FILTER;
  console.log(`🚀 Delete Auth accounts ${byList ? "named in USER_IDS / EMAILS" : `that are ${[f.ANONYMOUS && "anonymous", f.DISABLED && "disabled", f.INACTIVE_DAYS && `inactive ${f.INACTIVE_DAYS}+ days`].filter(Boolean).join(" and ")}`}`);
  banner(CONFIG.DRY_RUN);

  let users;
  if (byList) {
    const r = await resolveUsers(auth, { uids: CONFIG.USER_IDS, emails: CONFIG.EMAILS });
    users = r.users;
    for (const m of r.missing) console.log(`   🔴 not found: ${m}`);
  } else {
    const nowMs = Date.now();
    users = [];
    let total = 0;
    for await (const u of listAllUsers(auth)) {
      total++;
      if (matchesFilter(u, f, nowMs)) users.push(u);
    }
    console.log(`   ${total} accounts looked at.`);
  }
  console.log(`📊 ${users.length} accounts would be deleted.`);
  for (const u of users.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   🗑️  ${who(u)}, last sign-in ${u.metadata?.lastSignInTime || "never"}`);
  if (users.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${users.length - CONFIG.LOG_SAMPLES} more.`);

  if (CONFIG.DRY_RUN || !users.length) {
    console.log(`\n🧪 ${CONFIG.DRY_RUN ? "Dry run complete" : "Nothing to delete"}.`);
    return;
  }
  if (CONFIG.CONFIRM_PROJECT_ID !== projectId) {
    throw new Error(`This deletes accounts. Type the project id into CONFIG.CONFIRM_PROJECT_ID ("${projectId}") to confirm.`);
  }

  console.log(`💾 Account records saved: ${saveUserRecords(users, { projectId, prefix: "delete-auth-users" })}`);
  let deleted = 0;
  for (let i = 0; i < users.length; i += DELETE_BATCH) {
    const batch = users.slice(i, i + DELETE_BATCH);
    const res = await auth.deleteUsers(batch.map((u) => u.uid));
    deleted += res.successCount;
    for (const e of res.errors) console.error(`   ❌ ${batch[e.index].uid}: ${e.error.message}`);
  }
  console.log(`\n✅ Deleted ${deleted} of ${users.length} accounts.`);
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, matchesFilter };
