// scripts/auth/auditAuthUsers.js
// Check that Auth accounts and your user documents agree: accounts with no profile
// document (a sign-up that never got its document), documents with no account (a
// user deleted from Auth only), and, with EMAIL_FIELD, documents whose email isn't
// the account's.
//
// Anonymous accounts usually have no document, so they are left out unless
// INCLUDE_ANONYMOUS is on.
//
// It only reads. OUTPUT_FILE saves every finding as JSON, to feed a cleanup (such as
// deleteCollection.js) once you have checked.
//
// Usage: set CONFIG below and run `node scripts/auth/auditAuthUsers.js`.

const fs = require("fs");
const path = require("path");
const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath } = require("../../lib/fieldPaths");
const { listAllUsers, isAnonymous } = require("../../lib/authUsers");
const { runMain } = require("../../lib/run");

/**
 * CONFIG
 * - COLLECTION, USE_COLLECTION_GROUP, WHERE, DOC_IDS: the user documents (see lib/targets.js)
 * - UID_FIELD: null when the document id is the uid, or the field that holds it
 * - EMAIL_FIELD: null, or a field to compare with the account's email (case and spaces aside)
 * - INCLUDE_ANONYMOUS: also report anonymous accounts that have no document
 * - LOG_SAMPLES: how many findings of each kind to print
 * - OUTPUT_FILE: null, or a path to write every finding to as JSON
 */
const CONFIG = {
  COLLECTION: "users",
  USE_COLLECTION_GROUP: false,
  WHERE: [],
  DOC_IDS: [],
  UID_FIELD: null,
  EMAIL_FIELD: null,
  INCLUDE_ANONYMOUS: false,
  LOG_SAMPLES: 25,
  OUTPUT_FILE: null,
};

function validateConfig(cfg = CONFIG) {
  validateTarget(cfg);
  for (const k of ["UID_FIELD", "EMAIL_FIELD"]) {
    if (cfg[k] !== null && (typeof cfg[k] !== "string" || !cfg[k])) throw new Error(`CONFIG.${k} must be a field path or null.`);
  }
  if (typeof cfg.INCLUDE_ANONYMOUS !== "boolean") throw new Error("CONFIG.INCLUDE_ANONYMOUS must be boolean.");
}

const sameEmail = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * Pair accounts and documents.
 *   accounts: [{ uid, email, anonymous }]   docs: [{ uid, path, email }]
 * Returns { noDocument, noAccount, emailMismatch, anonymousSkipped }.
 */
function audit(accounts, docs, cfg) {
  const docsByUid = new Map(docs.map((d) => [d.uid, d]));
  const accountUids = new Set(accounts.map((a) => a.uid));
  const noDocument = [];
  let anonymousSkipped = 0;
  for (const a of accounts) {
    if (docsByUid.has(a.uid)) continue;
    if (a.anonymous && !cfg.INCLUDE_ANONYMOUS) anonymousSkipped++;
    else noDocument.push({ uid: a.uid, email: a.email ?? null });
  }
  const noAccount = docs.filter((d) => !accountUids.has(d.uid)).map((d) => ({ uid: d.uid, path: d.path }));
  const emailMismatch = cfg.EMAIL_FIELD
    ? accounts.filter((a) => docsByUid.has(a.uid) && !sameEmail(a.email, docsByUid.get(a.uid).email))
      .map((a) => ({ uid: a.uid, accountEmail: a.email ?? null, documentEmail: docsByUid.get(a.uid).email ?? null }))
    : [];
  return { noDocument, noAccount, emailMismatch, anonymousSkipped };
}

async function main() {
  const { auth, db } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🔍 Auth accounts against ${describeTarget(CONFIG)}`);

  const accounts = [];
  for await (const u of listAllUsers(auth)) accounts.push({ uid: u.uid, email: u.email, anonymous: isAnonymous(u) });
  const docs = [];
  for await (const snap of targetDocs(db, CONFIG)) {
    const data = snap.data();
    const uid = CONFIG.UID_FIELD ? getByPath(data, CONFIG.UID_FIELD) : snap.id;
    if (typeof uid === "string" && uid) docs.push({ uid, path: snap.ref.path, email: CONFIG.EMAIL_FIELD ? getByPath(data, CONFIG.EMAIL_FIELD) : undefined });
  }
  const r = audit(accounts, docs, CONFIG);

  console.log(`📊 ${accounts.length} accounts, ${docs.length} documents: ${r.noDocument.length} accounts without a document${r.anonymousSkipped ? ` (+${r.anonymousSkipped} anonymous, not counted)` : ""}, ${r.noAccount.length} documents without an account${CONFIG.EMAIL_FIELD ? `, ${r.emailMismatch.length} email mismatches` : ""}.`);
  const n = CONFIG.LOG_SAMPLES;
  for (const a of r.noDocument.slice(0, n)) console.log(`   👤 no document: ${a.uid}${a.email ? ` (${a.email})` : ""}`);
  for (const d of r.noAccount.slice(0, n)) console.log(`   📄 no account:  ${d.path}`);
  for (const m of r.emailMismatch.slice(0, n)) console.log(`   ✉️  ${m.uid}: account ${JSON.stringify(m.accountEmail)}, document ${JSON.stringify(m.documentEmail)}`);
  if (CONFIG.OUTPUT_FILE) {
    const out = path.resolve(CONFIG.OUTPUT_FILE);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r, null, 2));
    console.log(`📄 Findings written to ${out}`);
  }
  if (!r.noDocument.length && !r.noAccount.length && !r.emailMismatch.length) console.log("✅ Accounts and documents agree.");
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, audit };
