// lib/writes.js
// Writing many documents at once without losing anyone else's update.
//
// Each write is { op, path, data?, lastUpdateTime? }:
//   update  merges `data` into the doc, refused if it changed since `lastUpdateTime`
//   delete  deletes the doc, refused if it changed since `lastUpdateTime`
//   create  creates the doc, refused if it already exists
//   set     writes the doc whole, unguarded (copies and restores)
// A BulkWriter retries what can be retried; everything else is listed, and the
// script can simply be run again.

const RETRYABLE = new Set([4, 8, 10, 13, 14]); // deadline, exhausted, aborted, internal, unavailable

function bulkWriterOf(db) {
  const writer = db.bulkWriter();
  const failures = [];
  writer.onWriteError((err) => {
    if (RETRYABLE.has(err.code) && err.failedAttempts < 5) return true;
    failures.push(`${err.documentRef.path}: ${err.message}`);
    return false;
  });
  return { writer, failures };
}

function queue(writer, db, w) {
  const ref = db.doc(w.path);
  const guard = w.lastUpdateTime ? { lastUpdateTime: w.lastUpdateTime } : undefined;
  switch (w.op) {
    case "update": return guard ? writer.update(ref, w.data, guard) : writer.update(ref, w.data);
    case "delete": return guard ? writer.delete(ref, guard) : writer.delete(ref);
    case "create": return writer.create(ref, w.data);
    case "set": return writer.set(ref, w.data);
    default: throw new Error(`Unknown write op "${w.op}" for ${w.path}`);
  }
}

/** Apply the writes. Returns { done, failures }: how many landed, and why the rest didn't. */
async function applyWrites(db, writes, { log = console.log } = {}) {
  const { writer, failures } = bulkWriterOf(db);
  let done = 0;
  const all = writes.map((w) => queue(writer, db, w).then(() => {
    done++;
    if (done % 500 === 0) log(`   …${done}/${writes.length} written`);
  }, () => {})); // counted in onWriteError
  await writer.close();
  await Promise.all(all);
  return { done, failures };
}

function printFailures(failures) {
  if (!failures.length) return;
  console.log(`❌ ${failures.length} writes failed (changed since the read, or refused); run again to pick them up:`);
  for (const f of failures.slice(0, 100)) console.log(`   ${f}`);
  if (failures.length > 100) console.log(`   … and ${failures.length - 100} more.`);
}

module.exports = { applyWrites, printFailures };
