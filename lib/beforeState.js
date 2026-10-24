// lib/beforeState.js
// The snapshot an armed run takes of exactly the documents it is about to change,
// written in the backup format so restoreFirestore.js can put them back.
//
// Its meta carries `kind: "before-state"` and the doc paths as `roots`. A
// restore of it rewrites those docs as they were; documents the run created
// are not in it (they didn't exist), so they stay.

const fs = require("fs");
const path = require("path");
const { once } = require("events");
const { FORMAT_VERSION, BACKUPS_DIR, encodeValue, defaultBackupFilename } = require("./backupFile");

/** Write `snaps` (existing doc snapshots) to backups/<prefix>-<project>-<time>.ndjson. Returns the path. */
async function saveBeforeState(snaps, { projectId, prefix, dir = BACKUPS_DIR }) {
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, defaultBackupFilename(projectId, { full: false, prefix }));
  const stream = fs.createWriteStream(outPath, { flags: "wx" });
  const writeLine = async (obj) => {
    if (!stream.write(JSON.stringify(obj) + "\n")) await once(stream, "drain");
  };
  const existing = snaps.filter((s) => s.exists);
  await writeLine({
    type: "meta",
    version: FORMAT_VERSION,
    kind: "before-state",
    projectId,
    capturedAt: new Date().toISOString(),
    full: false,
    roots: existing.map((s) => s.ref.path),
  });
  for (const s of existing) await writeLine({ type: "doc", path: s.ref.path, data: encodeValue(s.data(), s.ref.path) });
  await writeLine({ type: "end", docs: existing.length });
  stream.end();
  await once(stream, "close");
  return outPath;
}

module.exports = { saveBeforeState };
