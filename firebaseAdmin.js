// firebaseAdmin.js
const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");

// Load .env next to this file so running from /scripts works fine.
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

// 1) Read and normalize the key path from env
const credEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credEnv) throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path.");
const keyPath = path.isAbsolute(credEnv) ? credEnv : path.resolve(__dirname, credEnv);
if (!fs.existsSync(keyPath)) throw new Error(`Service account file not found at: ${keyPath}`);

// Ensure ADC sees an absolute path
process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;

// 2) Get project id from the key (for logging + default bucket)
const sa = JSON.parse(fs.readFileSync(keyPath, "utf8"));
const projectId = sa.project_id || "unknown";
const storageBucket = `${projectId}.appspot.com`; // default Firebase bucket

// 3) Initialize Admin (idempotent)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,            // keep admin.app().options.projectId populated
    storageBucket,        // so admin.storage().bucket() uses default
  });
  try { admin.firestore().settings({ ignoreUndefinedProperties: true }); } catch {}
  console.log(`Using project: ${projectId}`);
}

// 4) Exports
const db = admin.firestore();
const auth = admin.auth();
const bucket = admin.storage().bucket();

module.exports = {
  admin,
  db,
  auth,
  bucket,
  FieldValue: admin.firestore.FieldValue,
  Timestamp: admin.firestore.Timestamp,
  GeoPoint: admin.firestore.GeoPoint,
};