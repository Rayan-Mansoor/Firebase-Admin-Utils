// test/firestore/restoreFirestore.test.js
//
// Reading and checking a backup file before a restore. No Firestore.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scanBackup, integrityProblem, backupRecords } = require("../../lib/backupFile");
const { inScope } = require("../../scripts/firestore/restoreFirestore");

function tmpFile(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fau-")), "b.ndjson");
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

const meta = { type: "meta", version: 1, projectId: "p", capturedAt: "x", full: false, roots: ["users"] };
const doc = (p) => ({ type: "doc", path: p, data: {} });

test("a whole file scans clean, counting docs in scope by root", async () => {
  const file = tmpFile([meta, doc("users/a"), doc("users/a/posts/1"), doc("teams/t"), { type: "end", docs: 3 }]);
  const scan = await scanBackup(file, (p) => inScope(p, ["users"]));
  assert.equal(scan.totalDocs, 3);
  assert.equal(scan.matchedDocs, 2);
  assert.deepEqual([...scan.perRoot], [["users", 2]]);
  assert.equal(integrityProblem(scan), null);
});

test("a truncated or miscounted file is flagged", async () => {
  assert.match(integrityProblem(await scanBackup(tmpFile([meta, doc("users/a")]))), /no end marker/);
  assert.match(integrityProblem(await scanBackup(tmpFile([meta, doc("users/a"), { type: "end", docs: 2 }]))), /says 2/);
});

test("a file that isn't a backup, or is corrupt, is refused", async () => {
  await assert.rejects(scanBackup(tmpFile([doc("users/a")])), /not a meta record/);
  await assert.rejects(scanBackup(tmpFile([{ ...meta, version: 9 }])), /version 9/);
  await assert.rejects(scanBackup(tmpFile([meta, "{not json"])), /not valid JSON/);
});

test("records stream in file order", async () => {
  const types = [];
  for await (const r of backupRecords(tmpFile([meta, doc("users/a"), { type: "end", docs: 1 }]))) types.push(r.type);
  assert.deepEqual(types, ["meta", "doc", "end"]);
});

test("scope: everything when empty, else the paths and what's under them", () => {
  assert.equal(inScope("a/b", []), true);
  assert.equal(inScope("users/a/posts/1", ["users/a"]), true);
  assert.equal(inScope("users/ab", ["users/a"]), false);
});
