// lib/run.js
// What every script does around its own work: the dry-run banner, short value
// previews for reports, and running main() when invoked directly.

const { Timestamp, GeoPoint, DocumentReference } = require("firebase-admin").firestore;

function banner(dryRun) {
  console.log(dryRun ? "🧪 DRY_RUN is ON — nothing will be written." : "🔥 ARMED — this run writes.");
}

/** A one-line, human-readable form of a Firestore value, cut at `max` characters. */
function preview(value, max = 120) {
  const s = JSON.stringify(value, (k, v) => {
    if (v instanceof Timestamp) return `Timestamp(${v.toDate().toISOString()})`;
    if (v instanceof GeoPoint) return `GeoPoint(${v.latitude}, ${v.longitude})`;
    if (v instanceof DocumentReference) return `ref(${v.path})`;
    if (v && v.type === "Buffer" && Array.isArray(v.data)) return `bytes(${v.data.length})`;
    if (typeof v === "number" && !Number.isFinite(v)) return String(v);
    if (v && typeof v === "object" && typeof v.methodName === "string") return v.methodName.replace("FieldValue.", "");
    return v;
  });
  if (s === undefined) return "undefined";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Run `main` and exit 0, or print the error and exit 1. */
function runMain(main) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error("💥", err?.message || err);
    process.exit(1);
  });
}

module.exports = { banner, preview, runMain };
