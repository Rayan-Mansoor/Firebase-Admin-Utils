// lib/authUsers.js
// Finding Auth users the way the Auth scripts take them: by uid or by email.

const LOOKUP_BATCH = 100; // auth.getUsers() takes at most 100 identifiers

/**
 * The users these uids and emails name: { users: UserRecord[], missing: string[] }.
 * A user named twice (by uid and by email) is listed once.
 */
async function resolveUsers(auth, { uids = [], emails = [] }) {
  const ids = [...uids.map((uid) => ({ uid })), ...emails.map((email) => ({ email }))];
  const byUid = new Map();
  const missing = [];
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const res = await auth.getUsers(ids.slice(i, i + LOOKUP_BATCH));
    for (const u of res.users) byUid.set(u.uid, u);
    for (const n of res.notFound) missing.push(n.uid || n.email);
  }
  return { users: [...byUid.values()], missing };
}

/** Checks USER_IDS / EMAILS config lists: arrays of non-empty strings, at least one entry in all. */
function validateUserLists(cfg) {
  for (const k of ["USER_IDS", "EMAILS"]) {
    if (!Array.isArray(cfg[k])) throw new Error(`CONFIG.${k} must be an array.`);
    for (const v of cfg[k]) if (typeof v !== "string" || !v.trim()) throw new Error(`CONFIG.${k} has an invalid entry: ${JSON.stringify(v)}`);
  }
  if (!cfg.USER_IDS.length && !cfg.EMAILS.length) throw new Error("Name the users in USER_IDS or EMAILS.");
}

/** "uid (email)" for reports. */
const who = (u) => `${u.uid}${u.email ? ` (${u.email})` : ""}`;

/**
 * Save Auth user records as they are now, before a script changes or deletes
 * them, to backups/<prefix>-<project>-<time>.json. Returns the path. The file is
 * for reference and by-hand repair: Auth has no restore of its own.
 */
function saveUserRecords(users, { projectId, prefix }) {
  const fs = require("fs");
  const path = require("path");
  const { BACKUPS_DIR, defaultBackupFilename } = require("./backupFile");
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const outPath = path.join(BACKUPS_DIR, defaultBackupFilename(projectId, { full: false, prefix }).replace(/\.ndjson$/, ".json"));
  const records = users.map((u) => (typeof u.toJSON === "function" ? u.toJSON() : u));
  fs.writeFileSync(outPath, JSON.stringify({ projectId, capturedAt: new Date().toISOString(), users: records }, null, 2), { flag: "wx" });
  return outPath;
}

module.exports = { resolveUsers, validateUserLists, who, saveUserRecords };
