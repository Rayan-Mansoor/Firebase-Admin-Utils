// lib/fieldPaths.js
// Dotted field paths ("profile.name") over plain data, and value equality that
// understands Firestore types. Paths walk maps only: no array indexing, and a
// segment can't itself contain a dot.

const { Timestamp, GeoPoint, DocumentReference } = require("firebase-admin").firestore;

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && (v.constructor === Object || v.constructor === undefined);

function getByPath(obj, path) {
  return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!isMap(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetByPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
}

/** True when one path is the other or lies inside it ("a" and "a.b"). */
function pathsOverlap(a, b) {
  return a === b || a.startsWith(b + ".") || b.startsWith(a + ".");
}

/** Deep equality for Firestore values: Timestamps, GeoPoints, references and bytes by value. */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  for (const T of [Timestamp, GeoPoint, DocumentReference]) {
    if (a instanceof T || b instanceof T) return a instanceof T && b instanceof T && a.isEqual(b);
  }
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
}

module.exports = { isMap, getByPath, setByPath, unsetByPath, pathsOverlap, sameValue };
