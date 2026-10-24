// scripts/storage/auditStorageReferences.js
// Check that Storage files and the documents pointing at them agree:
//   - files no document points at (orphans: wasted storage, often from deleted records)
//   - documents pointing at files that don't exist (broken images and downloads)
//
// A reference can be an object path ("avatars/u1.png"), a gs:// URL or a download
// URL. Name the fields that hold them in each source's FIELDS ("items[].url" reads
// each object of an array), or leave FIELDS null to look at every string field:
// then only gs:// and download URLs, and strings that are exactly an object's name,
// count as references.
//
// It only reads. OUTPUT_FILE saves both lists as JSON; deleteStoragePrefix.js can
// delete the orphans straight from it.
//
// Usage: set CONFIG below and run `node scripts/storage/auditStorageReferences.js`.

const fs = require("fs");
const path = require("path");
const { validateTarget, describeTarget, targetDocs } = require("../../lib/targets");
const { getByPath, isMap } = require("../../lib/fieldPaths");
const { normalizePrefix, validatePrefix, storageRefOf } = require("../../lib/storage");
const { formatBytes } = require("../../lib/backupFile");
const { runMain } = require("../../lib/run");

/**
 * CONFIG
 * - PREFIXES: the Storage folders to check for orphans ([] = the whole bucket)
 * - SOURCES: the documents that point at files, each
 *     { COLLECTION, USE_COLLECTION_GROUP?, WHERE?, FIELDS: ["avatarPath", "items[].url"] | null }
 * - LOG_SAMPLES: how many of each finding to print
 * - OUTPUT_FILE: null, or a path to write { orphans, broken } to as JSON
 */
const CONFIG = {
  PREFIXES: [],
  SOURCES: [
    { COLLECTION: "users", FIELDS: null },
  ],
  LOG_SAMPLES: 25,
  OUTPUT_FILE: null,
};

function validateConfig(cfg = CONFIG) {
  if (!Array.isArray(cfg.PREFIXES)) throw new Error("CONFIG.PREFIXES must be an array.");
  cfg.PREFIXES.forEach((p, i) => validatePrefix(p, `PREFIXES[${i}]`));
  if (!Array.isArray(cfg.SOURCES) || !cfg.SOURCES.length) throw new Error("CONFIG.SOURCES must list at least one collection.");
  for (const s of cfg.SOURCES) {
    validateTarget(s || {});
    if (s.FIELDS !== null && s.FIELDS !== undefined && (!Array.isArray(s.FIELDS) || s.FIELDS.some((f) => typeof f !== "string" || !f))) {
      throw new Error(`SOURCES '${s.COLLECTION}': FIELDS must be null or a list of field paths.`);
    }
  }
}

/** Every value a field spec names: "a.b" or "items[].url" (each object of the array). */
function valuesAt(data, spec) {
  const [arrayPath, rest] = spec.split("[].");
  if (rest === undefined) return [].concat(getByPath(data, spec) ?? []).map((v) => ({ where: spec, value: v }));
  const arr = getByPath(data, arrayPath);
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((item, i) => [].concat(getByPath(item, rest) ?? []).map((v) => ({ where: `${arrayPath}[${i}].${rest}`, value: v })));
}

/** Every string anywhere in the document, with its field path. */
function allStrings(data, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(data || {})) {
    const where = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push({ where, value: v });
    else if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "string" ? out.push({ where: `${where}[${i}]`, value: x }) : isMap(x) && out.push(...allStrings(x, `${where}[${i}]`))));
    else if (isMap(v)) out.push(...allStrings(v, where));
  }
  return out;
}

/**
 * The references one document holds in this bucket: [{ where, name }].
 * With fields: every value there that names an object. Without: URLs, and bare
 * strings only when they are exactly an existing object's name.
 */
function referencesIn(data, fields, bucketName, objectNames) {
  const candidates = fields ? fields.flatMap((f) => valuesAt(data, f)) : allStrings(data);
  const refs = [];
  for (const { where, value } of candidates) {
    const ref = storageRefOf(value);
    if (!ref || (ref.bucket && ref.bucket !== bucketName)) continue;
    if (!fields && !ref.bucket && !objectNames.has(ref.name)) continue;
    refs.push({ where, name: ref.name });
  }
  return refs;
}

async function main() {
  const { bucket, db } = require("../../firebaseAdmin");
  validateConfig();
  const prefixes = CONFIG.PREFIXES.map(normalizePrefix);
  console.log(`🔍 gs://${bucket.name}/${prefixes.length ? `{${prefixes.join(", ")}}` : ""} against ${CONFIG.SOURCES.map(describeTarget).join(", ")}`);

  const objects = new Map(); // name → size
  for (const prefix of prefixes.length ? prefixes : [""]) {
    const [files] = await bucket.getFiles({ prefix });
    for (const f of files) if (!f.name.endsWith("/")) objects.set(f.name, Number(f.metadata?.size || 0));
  }
  const allNames = new Set(objects.keys());
  const referenced = new Set();
  const broken = [];
  let docs = 0;
  for (const source of CONFIG.SOURCES) {
    for await (const snap of targetDocs(db, source)) {
      docs++;
      for (const ref of referencesIn(snap.data(), source.FIELDS || null, bucket.name, allNames)) {
        referenced.add(ref.name);
        if (allNames.has(ref.name)) continue;
        const inScope = !prefixes.length || prefixes.some((p) => ref.name.startsWith(p));
        // A missing object outside the checked folders may exist; check it directly.
        if (inScope || !(await bucket.file(ref.name).exists())[0]) broken.push({ doc: snap.ref.path, where: ref.where, name: ref.name });
      }
    }
  }
  const orphans = [...objects].filter(([name]) => !referenced.has(name)).map(([name, size]) => ({ name, size }));
  const orphanBytes = orphans.reduce((n, o) => n + o.size, 0);

  console.log(`📊 ${objects.size} files, ${docs} documents, ${referenced.size} distinct files referenced: ${orphans.length} files unreferenced (${formatBytes(orphanBytes)}), ${broken.length} references to missing files.`);
  for (const o of orphans.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   🗂️  unreferenced: ${o.name} (${formatBytes(o.size)})`);
  if (orphans.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${orphans.length - CONFIG.LOG_SAMPLES} more unreferenced.`);
  for (const b of broken.slice(0, CONFIG.LOG_SAMPLES)) console.log(`   🔴 ${b.doc} ${b.where}: ${b.name} doesn't exist`);
  if (broken.length > CONFIG.LOG_SAMPLES) console.log(`   … and ${broken.length - CONFIG.LOG_SAMPLES} more broken.`);
  if (CONFIG.OUTPUT_FILE) {
    const out = path.resolve(CONFIG.OUTPUT_FILE);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ orphans, broken }, null, 2));
    console.log(`📄 Findings written to ${out}`);
  }
  if (!orphans.length && !broken.length) console.log("✅ Files and documents agree.");
}

if (require.main === module) runMain(main);

module.exports = { CONFIG, main, validateConfig, valuesAt, allStrings, referencesIn };
