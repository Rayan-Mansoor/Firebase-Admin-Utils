// lib/backupFile.js
// The backup format every script reads and writes: backupFirestore.js and
// restoreFirestore.js, and the snapshot each script takes before it writes.
//
// NDJSON, one JSON object per line:
//   line 1:  { "type": "meta", "version": 1, "projectId", "capturedAt", "full", "roots": [...] }
//   middle:  { "type": "doc",  "path": "users/abc", "data": { ...encoded fields... } }
//   last:    { "type": "end",  "docs": <total doc lines> }   ← integrity marker
// Firestore-only types are encoded as tagged objects keyed by "$fst" so they survive
// JSON: Timestamp, GeoPoint, DocumentReference, Bytes, NaN/±Infinity, vectors. A
// genuine map that happens to contain a "$fst" key is escaped as
// { "$fst": "map", "fields": {...} }. Files stay grep/jq-friendly.

const fs = require("fs");
const path = require("path");
const { once } = require("events");
const { Timestamp, GeoPoint, DocumentReference, FieldValue, VectorValue } = require("firebase-admin").firestore;
const { mapWithConcurrency } = require("./concurrency");

const FORMAT_VERSION = 1;
const TAG = "$fst";
const BACKUPS_DIR = path.resolve(__dirname, "../backups");
const READ_CHUNK = 300; // docs fetched per db.getAll()
const PROBE_CONCURRENCY = 25; // parallel listCollections() probes — sequential probing is latency-bound and unusably slow on large DBs
const SUBWALK_CONCURRENCY = 16; // parallel subcollection walks — same reason

/** Encode one Firestore field value into a JSON-safe form. `ctx` is only used in error messages. */
function encodeValue(value, ctx) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { [TAG]: "number", value: String(value) };
  }
  if (Array.isArray(value)) return value.map((v, i) => encodeValue(v, `${ctx}[${i}]`));
  if (value instanceof Timestamp) {
    // `iso` is informational only (loses sub-ms); decode uses seconds/nanoseconds.
    return {
      [TAG]: "timestamp",
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
      iso: value.toDate().toISOString(),
    };
  }
  if (value instanceof GeoPoint) {
    return { [TAG]: "geopoint", latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof DocumentReference) {
    return { [TAG]: "reference", path: value.path };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { [TAG]: "bytes", base64: Buffer.from(value).toString("base64") };
  }
  if (VectorValue && value instanceof VectorValue) {
    return { [TAG]: "vector", values: value.toArray() };
  }
  if (typeof value === "object" && (value.constructor === Object || value.constructor === undefined)) {
    const fields = {};
    for (const [k, v] of Object.entries(value)) fields[k] = encodeValue(v, `${ctx}.${k}`);
    return Object.prototype.hasOwnProperty.call(value, TAG)
      ? { [TAG]: "map", fields }
      : fields;
  }
  throw new Error(`Cannot encode value at ${ctx} (type: ${value.constructor?.name || typeof value})`);
}

/** Decode a value produced by encodeValue back into real Firestore types. `db` resolves references. */
function decodeValue(value, ctx, db) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v, i) => decodeValue(v, `${ctx}[${i}]`, db));
  const tag = value[TAG];
  if (tag === undefined) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v, `${ctx}.${k}`, db);
    return out;
  }
  switch (tag) {
    case "timestamp":
      return new Timestamp(value.seconds, value.nanoseconds);
    case "geopoint":
      return new GeoPoint(value.latitude, value.longitude);
    case "reference":
      if (!db) throw new Error(`Decoding the reference at ${ctx} needs a Firestore instance.`);
      return db.doc(value.path);
    case "bytes":
      return Buffer.from(value.base64, "base64");
    case "number":
      return Number(value.value); // "NaN" | "Infinity" | "-Infinity"
    case "vector":
      if (!FieldValue.vector) throw new Error(`Backup contains a vector value at ${ctx} but this firebase-admin version does not support vectors.`);
      return FieldValue.vector(value.values);
    case "map": {
      const out = {};
      for (const [k, v] of Object.entries(value.fields)) out[k] = decodeValue(v, `${ctx}.${k}`, db);
      return out;
    }
    default:
      throw new Error(`Unknown ${TAG} tag "${tag}" at ${ctx} — backup made by a newer tool version?`);
  }
}

function assertValidPath(p) {
  if (typeof p !== "string" || p.length === 0) throw new Error("Path must be a non-empty string.");
  if (p.split("/").some((s) => s.length === 0)) throw new Error(`Invalid path "${p}" (empty segment).`);
  return p;
}

/** Odd number of segments = collection path, even = document path. */
function isCollectionPath(p) {
  return p.split("/").length % 2 === 1;
}

/** True if docPath is the prefix itself or lies underneath it (segment-aware). */
function pathIsUnder(docPath, prefix) {
  return docPath === prefix || docPath.startsWith(prefix + "/");
}

/**
 * Stream a backup of `targets` (or the whole DB when empty) into `outPath` as NDJSON.
 * Enumerates with listDocuments() so subcollections whose parent doc was deleted
 * ("ghost" parents) are still discovered and their descendants backed up.
 * Refuses to overwrite an existing file. Returns stats.
 */
async function backupToFile(db, { targets = [], outPath, projectId, log = console.log }) {
  targets.forEach(assertValidPath);
  const full = targets.length === 0;

  const roots = full ? (await db.listCollections()).map((c) => c.id) : targets.slice();
  if (roots.length === 0) throw new Error("Nothing to back up: the database has no root collections.");

  const stream = fs.createWriteStream(outPath, { flags: "wx" });
  const stats = { docs: 0, collections: 0, ghostParents: 0 };

  const writeLine = async (obj) => {
    if (!stream.write(JSON.stringify(obj) + "\n")) await once(stream, "drain");
  };

  async function writeSnap(snap) {
    await writeLine({ type: "doc", path: snap.ref.path, data: encodeValue(snap.data(), snap.ref.path) });
    stats.docs++;
    if (stats.docs % 250 === 0) log(`   …${stats.docs} docs (at ${snap.ref.path})`);
  }

  // Concurrent branches may interleave doc lines in the file — that's fine, since
  // each writeLine emits one complete line and doc records are order-independent
  // (meta stays first, end stays last).
  async function walkDoc(ref, snap) {
    if (snap.exists) await writeSnap(snap);
    const subs = await ref.listCollections();
    if (!snap.exists && subs.length > 0) stats.ghostParents++;
    await mapWithConcurrency(subs, SUBWALK_CONCURRENCY, walkCollection);
  }

  async function walkCollection(colRef) {
    stats.collections++;
    const refs = await colRef.listDocuments();
    for (let i = 0; i < refs.length; i += READ_CHUNK) {
      const snaps = await db.getAll(...refs.slice(i, i + READ_CHUNK));
      // The traversal is latency-bound, so the subcollection probes and the walks
      // into whatever they find both run with bounded parallelism.
      const subLists = await mapWithConcurrency(snaps, PROBE_CONCURRENCY, (s) => s.ref.listCollections());
      const subs = [];
      for (let j = 0; j < snaps.length; j++) {
        const snap = snaps[j];
        if (snap.exists) await writeSnap(snap);
        if (!snap.exists && subLists[j].length > 0) stats.ghostParents++;
        subs.push(...subLists[j]);
      }
      await mapWithConcurrency(subs, SUBWALK_CONCURRENCY, walkCollection);
    }
  }

  await writeLine({
    type: "meta",
    version: FORMAT_VERSION,
    projectId,
    capturedAt: new Date().toISOString(),
    full,
    roots,
  });

  for (const root of roots) {
    log(`📚 Backing up ${isCollectionPath(root) ? "collection" : "document subtree"} '${root}'…`);
    if (isCollectionPath(root)) {
      await walkCollection(db.collection(root));
    } else {
      const ref = db.doc(root);
      await walkDoc(ref, await ref.get());
    }
  }

  await writeLine({ type: "end", docs: stats.docs });
  stream.end();
  await once(stream, "close");

  stats.bytes = fs.statSync(outPath).size;
  return { ...stats, outPath, projectId, roots, full };
}

function defaultBackupFilename(pid, { full = true, prefix = "firestore" } = {}) {
  // Milliseconds included, so two runs in the same second never collide (files are created with "wx").
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23); // 2026-08-25T12-30-00-123
  return `${prefix}-${pid}${full ? "" : "-partial"}-${ts}.ndjson`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(1)} ${units[u]}`;
}

module.exports = {
  FORMAT_VERSION,
  TAG,
  BACKUPS_DIR,
  encodeValue,
  decodeValue,
  assertValidPath,
  isCollectionPath,
  pathIsUnder,
  backupToFile,
  defaultBackupFilename,
  formatBytes,
};
