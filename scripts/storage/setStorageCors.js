// scripts/storage/setStorageCors.js
// Set the bucket's CORS rules, so a web app on your domains can fetch files from
// Storage directly (fetch(), <canvas>, fonts) without installing gsutil or gcloud.
//
// MODE "replace" makes the rules exactly the one built from CONFIG; "add" appends
// it to the rules already there; "clear" removes every rule.
//
// What it writes: the bucket's CORS configuration, nothing else.
//
// Why it's safe: the dry run (the default) prints the current rules and the new
// ones. The armed run saves the current rules into backups/ first; setting them
// back is one run of this script.
//
// Usage: set CONFIG below, run `node scripts/storage/setStorageCors.js`, read the
// rules, then set DRY_RUN = false and run it again.

const fs = require("fs");
const path = require("path");
const { BACKUPS_DIR, defaultBackupFilename } = require("../../lib/backupFile");
const { sameValue } = require("../../lib/fieldPaths");
const { banner, runMain } = require("../../lib/run");

/**
 * CONFIG
 * - MODE: "replace" | "add" | "clear"
 * - ORIGINS: the sites allowed ("https://myapp.com", "http://localhost:5173"; "*" = any)
 * - METHODS: the HTTP methods allowed (["GET", "HEAD"] for downloads)
 * - RESPONSE_HEADERS: headers the browser may read (["Content-Type"])
 * - MAX_AGE_SECONDS: how long browsers cache the answer to their preflight check
 * - DRY_RUN: print the rules without changing them
 */
const CONFIG = {
  MODE: "replace",
  ORIGINS: ["https://example.com"],
  METHODS: ["GET", "HEAD"],
  RESPONSE_HEADERS: ["Content-Type"],
  MAX_AGE_SECONDS: 3600,
  DRY_RUN: true,
};

const METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE", "OPTIONS", "PATCH"];

function validateConfig(cfg = CONFIG) {
  if (!["replace", "add", "clear"].includes(cfg.MODE)) throw new Error('CONFIG.MODE must be "replace", "add" or "clear".');
  if (typeof cfg.DRY_RUN !== "boolean") throw new Error("CONFIG.DRY_RUN must be boolean.");
  if (cfg.MODE === "clear") return;
  if (!Array.isArray(cfg.ORIGINS) || !cfg.ORIGINS.length) throw new Error("CONFIG.ORIGINS must list at least one origin.");
  for (const o of cfg.ORIGINS) {
    if (o !== "*" && !/^https?:\/\/[^/\s]+$/.test(o)) throw new Error(`Origin "${o}" must be a scheme and host, like https://myapp.com (no path, no trailing slash), or "*".`);
  }
  if (!Array.isArray(cfg.METHODS) || !cfg.METHODS.length) throw new Error("CONFIG.METHODS must list at least one method.");
  const bad = cfg.METHODS.find((m) => !METHODS.includes(m));
  if (bad) throw new Error(`Method "${bad}" isn't one of ${METHODS.join(", ")}.`);
  if (!Array.isArray(cfg.RESPONSE_HEADERS)) throw new Error("CONFIG.RESPONSE_HEADERS must be an array.");
  if (!Number.isInteger(cfg.MAX_AGE_SECONDS) || cfg.MAX_AGE_SECONDS < 0) throw new Error("CONFIG.MAX_AGE_SECONDS must be a whole number ≥ 0.");
}

/** The bucket's rules after this run, from the rules it has now. */
function nextCors(current, cfg) {
  if (cfg.MODE === "clear") return [];
  const rule = { origin: cfg.ORIGINS, method: cfg.METHODS, responseHeader: cfg.RESPONSE_HEADERS, maxAgeSeconds: cfg.MAX_AGE_SECONDS };
  if (cfg.MODE === "replace") return [rule];
  return (current || []).some((r) => sameValue(r, rule)) ? current : [...(current || []), rule];
}

const showRules = (rules) => (rules.length ? rules.map((r) => `   ${JSON.stringify(r)}`).join("\n") : "   (none)");

async function main() {
  const { bucket, projectId } = require("../../firebaseAdmin");
  validateConfig();
  console.log(`🚀 CORS rules of gs://${bucket.name} (${CONFIG.MODE})`);
  banner(CONFIG.DRY_RUN);

  const [meta] = await bucket.getMetadata();
  const current = meta.cors || [];
  const next = nextCors(current, CONFIG);
  console.log(`📋 Now:\n${showRules(current)}\n📋 After:\n${showRules(next)}`);

  if (sameValue(current, next)) {
    console.log("\n✅ Already set; nothing to change.");
    return;
  }
  if (CONFIG.DRY_RUN) {
    console.log("\n🧪 Dry run complete.");
    return;
  }

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const saved = path.join(BACKUPS_DIR, defaultBackupFilename(projectId, { full: false, prefix: "storage-cors" }).replace(/\.ndjson$/, ".json"));
  fs.writeFileSync(saved, JSON.stringify({ bucket: bucket.name, capturedAt: new Date().toISOString(), cors: current }, null, 2), { flag: "wx" });
  console.log(`💾 Current rules saved: ${saved}`);
  await bucket.setCorsConfiguration(next);
  console.log("✅ CORS rules set. Browsers pick them up within the max age of their cached preflight answers.");
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, nextCors };
