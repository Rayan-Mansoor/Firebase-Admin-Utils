// test/storage/setStorageCors.test.js
//
// How setStorageCors builds the bucket's rules. No Firebase.

const test = require("node:test");
const assert = require("node:assert/strict");
const { nextCors, validateConfig } = require("../../scripts/storage/setStorageCors");

const cfg = (over) => ({ MODE: "replace", ORIGINS: ["https://a.com"], METHODS: ["GET"], RESPONSE_HEADERS: ["Content-Type"], MAX_AGE_SECONDS: 60, DRY_RUN: true, ...over });
const rule = { origin: ["https://a.com"], method: ["GET"], responseHeader: ["Content-Type"], maxAgeSeconds: 60 };
const other = { origin: ["https://b.com"], method: ["GET"], responseHeader: [], maxAgeSeconds: 1 };

test("replace, add (once) and clear", () => {
  assert.deepEqual(nextCors([other], cfg()), [rule]);
  assert.deepEqual(nextCors([other], cfg({ MODE: "add" })), [other, rule]);
  assert.deepEqual(nextCors([other, rule], cfg({ MODE: "add" })), [other, rule]);
  assert.deepEqual(nextCors([other], cfg({ MODE: "clear" })), []);
  assert.deepEqual(nextCors(undefined, cfg({ MODE: "add" })), [rule]);
});

test("origins are scheme and host; methods are HTTP methods", () => {
  assert.doesNotThrow(() => validateConfig(cfg({ ORIGINS: ["*", "http://localhost:5173"] })));
  assert.throws(() => validateConfig(cfg({ ORIGINS: ["https://a.com/"] })), /no trailing slash/);
  assert.throws(() => validateConfig(cfg({ ORIGINS: ["a.com"] })), /scheme and host/);
  assert.throws(() => validateConfig(cfg({ METHODS: ["FETCH"] })), /isn't one of/);
  assert.doesNotThrow(() => validateConfig({ MODE: "clear", DRY_RUN: true }));
});
