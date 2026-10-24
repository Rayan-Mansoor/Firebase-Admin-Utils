// firebaseAdmin.js
// The one Firebase Admin init every script shares. It connects either to a real
// project, with a service account key, or to the local emulators, with none.
//
//   Real project:  GOOGLE_APPLICATION_CREDENTIALS = path to the key (in .env)
//                  FIREBASE_STORAGE_BUCKET        = optional; default <project-id>.appspot.com
//   Emulators:     FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST and/or
//                  FIREBASE_STORAGE_EMULATOR_HOST set, and GCLOUD_PROJECT a `demo-` project
//                  (default demo-firebase-admin-utils)
//
// In emulator mode the project must be a `demo-` one: Google refuses every call
// to a demo project, so a service the emulators don't cover fails instead of
// reaching a real project.
const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");

// Load .env next to this file so scripts run from any directory.
require("dotenv").config({ path: path.resolve(__dirname, ".env"), quiet: true });

const EMULATOR_VARS = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"];
const emulated = EMULATOR_VARS.some((v) => process.env[v]);

function emulatorProject() {
  const projectId = process.env.GCLOUD_PROJECT || "demo-firebase-admin-utils";
  if (!projectId.startsWith("demo-")) {
    throw new Error(`With the emulators, GCLOUD_PROJECT must be a demo- project (got "${projectId}").`);
  }
  return { projectId, options: { projectId } };
}

function keyProject() {
  const credEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credEnv) throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path, or use the emulators (see README).");
  const keyPath = path.isAbsolute(credEnv) ? credEnv : path.resolve(__dirname, credEnv);
  if (!fs.existsSync(keyPath)) throw new Error(`Service account file not found at: ${keyPath}`);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath; // ADC needs it absolute

  const projectId = JSON.parse(fs.readFileSync(keyPath, "utf8")).project_id || "unknown";
  return { projectId, options: { credential: admin.credential.applicationDefault(), projectId } };
}

const { projectId, options } = emulated ? emulatorProject() : keyProject();
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`;

if (!admin.apps.length) {
  admin.initializeApp({ ...options, storageBucket });
  try { admin.firestore().settings({ ignoreUndefinedProperties: true }); } catch {}
  console.log(`Using project: ${projectId}${emulated ? " (emulators)" : ""}`);
}

const db = admin.firestore();
const auth = admin.auth();
const bucket = admin.storage().bucket();

module.exports = {
  admin,
  db,
  auth,
  bucket,
  projectId,
  emulated,
  FieldValue: admin.firestore.FieldValue,
  Timestamp: admin.firestore.Timestamp,
  GeoPoint: admin.firestore.GeoPoint,
};
