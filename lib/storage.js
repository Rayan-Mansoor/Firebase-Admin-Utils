// lib/storage.js
// Cloud Storage "folders": object name prefixes, always ending in "/".

/** "a/b" and "a/b/" are the same folder. */
const normalizePrefix = (p) => (p.endsWith("/") ? p : p + "/");

/** Checks a folder prefix from CONFIG: a non-empty string, not starting with "/". */
function validatePrefix(p, name) {
  if (typeof p !== "string" || !p.trim()) throw new Error(`CONFIG.${name} must be a non-empty folder path ("uploads/").`);
  if (p.startsWith("/")) throw new Error(`CONFIG.${name} must not start with "/": object names have no leading slash.`);
}

/** When a prefix matches nothing, show what is there, so a typo is easy to spot. */
async function peekBucket(bucket, sample = 50) {
  const [files] = await bucket.getFiles({ maxResults: sample });
  console.log(`\n👀 ${files.length ? `First ${files.length} objects in ${bucket.name}:` : `${bucket.name} is empty.`}`);
  for (const f of files.slice(0, 20)) console.log(`   ${f.name}`);
  const tops = [...new Set(files.map((f) => f.name.split("/")[0] + "/").filter((t) => t !== "/"))];
  if (tops.length) console.log(`   Top-level folders seen: ${tops.slice(0, 30).join(", ")}`);
}

module.exports = { normalizePrefix, validatePrefix, peekBucket };
