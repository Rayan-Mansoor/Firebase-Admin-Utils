// test/firestore/changesSince.test.js
//
// How changesSince classifies each document. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const { changeOf, validateConfig } = require("../../scripts/firestore/changesSince");

const SINCE = 1000;

test("created, updated, deleted or unchanged since the backup", () => {
  assert.equal(changeOf(false, { createMs: 1500, updateMs: 1500 }, SINCE), "created");
  assert.equal(changeOf(true, { createMs: 500, updateMs: 1500 }, SINCE), "updated");
  assert.equal(changeOf(true, { createMs: 500, updateMs: 900 }, SINCE), null);
  assert.equal(changeOf(true, null, SINCE), "deleted");
  assert.equal(changeOf(false, null, SINCE), null);
});

test("a doc deleted and created again since counts as updated when the backup has it", () => {
  assert.equal(changeOf(true, { createMs: 1500, updateMs: 1500 }, SINCE), "updated");
});

test("without a backup, an old doc changed since is updated, a new one created", () => {
  assert.equal(changeOf(false, { createMs: 500, updateMs: 1500 }, SINCE), "updated");
  assert.equal(changeOf(false, { createMs: 500, updateMs: 500 }, SINCE), null);
});

test("a backup or SINCE, and ROOTS only with SINCE", () => {
  const cfg = (over) => ({ BACKUP_FILE: "", SINCE: "", ROOTS: [], ...over });
  assert.throws(() => validateConfig(cfg({})), /Give a backup/);
  assert.throws(() => validateConfig(cfg({ SINCE: "soon" })), /not a date-time/);
  assert.throws(() => validateConfig(cfg({ ROOTS: ["users"] }), "b.ndjson"), /ROOTS goes with SINCE/);
  assert.doesNotThrow(() => validateConfig(cfg({ SINCE: "2026-01-01T00:00:00Z", ROOTS: ["users"] })));
});
