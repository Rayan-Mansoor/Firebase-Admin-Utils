# Firebase-Admin-Utils
Collection of Firebase Admin utilities and scripts for **Firestore**, **Auth**, **Cloud Storage** (and a Stripe helper).  
Centralized Admin init lives in `firebaseAdmin.js` and prints the active project once.

---

## ✨ Quick Start

1. **Install deps**
   ```bash
   npm i
   ```

2. **Add secrets (not committed)**

   * Put your service account JSON under `./secrets/` (ignored by git).
   * Create `.env` from the example and set paths/keys:

     ```bash
     cp .env.example .env
     ```

     **.env**

     ```
     GOOGLE_APPLICATION_CREDENTIALS=./secrets/<your-service-account>.json
     STRIPE_API_KEY=sk_test_********************************
     ```

3. **Run any script**

   ```bash
   node scripts/<scriptName>.js
   ```

> The Admin bootstrap resolves `.env` **relative to repo root**, so you can run scripts from anywhere.

---

## 🧩 Centralized Admin Init

**`firebaseAdmin.js`**

* Uses only `GOOGLE_APPLICATION_CREDENTIALS` (env path).
* Derives `projectId` from the key and sets default Storage bucket to `<project-id>.appspot.com`.
* Exports: `admin`, `db`, `auth`, `bucket`, `FieldValue`, `Timestamp`, `GeoPoint`.
* On first load prints: `Using project: <id>`.

Scripts import it like:

```js
const { db, auth, bucket, FieldValue } = require("../firebaseAdmin");
```

---

## 📁 Scripts

| Script                                     | Purpose                                                                                                                | Key toggles (inside file)                                                             | Usage                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `copyCollection.js`                        | Copy a Firestore collection to another; optional recursive subcollections; optional destructive delete of source.      | `INCLUDE_SUBCOLLECTIONS`, `IS_DESTRUCTIVE`, `BATCH_SIZE`, `DRY_RUN`                   | `node scripts/copyCollection.js`                                                   |
| `copyStoragePrefix.js`                     | Copy Cloud Storage objects from one prefix to another (same bucket).                                                   | `DRY_RUN`, `SKIP_IF_EXISTS`, `SAMPLE_PEEK`                                            | `node scripts/copyStoragePrefix.js`                                                |
| `createStripeCustomersForExistingUsers.js` | Create (or link) Stripe customers for existing Firebase Auth users and persist under `stripe_customers/{uid}`.         | `DRY_RUN`, `SKIP_IF_EXISTS`, `ONLY_ENABLED_USERS`, `MAX_USERS`, `RATE_LIMIT_DELAY_MS` | `node scripts/createStripeCustomersForExistingUsers.js` *(needs `STRIPE_API_KEY`)* |
| `inferSchema.js`                           | Scan a Firestore collection and print an LLM-friendly **YAML** schema (with optional subcollection shapes & examples). | `COLLECTION_PATH`, `INCLUDE_SUBCOLLECTIONS`, `SAMPLE_LIMIT`, `INCLUDE_EXAMPLE`        | `node scripts/inferSchema.js`                                                      |
| `setAdminStatus.js`                        | Grant/revoke `admin` custom claim for a user by email. Also syncs `admins/<uid>` doc.                                  | `TARGET_EMAIL`, `MAKE_ADMIN`, `CALLER_UID`, `ALLOW_SELF_DEMOTE`, `SKIP_OWNER_CHECK`   | `node scripts/setAdminStatus.js`                                                   |
| `makeOwner.js`                             | (Owner bootstrap) Set `owner: true` custom claim for a specific user.                                                  | see script                                                                            | `node scripts/makeOwner.js`                                                        |
| `updateDisplayNames.js`                    | Sync Auth `displayName` from Firestore user profile fields (e.g., `basicInfo.firstName/lastName`).                     | paths/collection config at top                                                        | `node scripts/updateDisplayNames.js`                                               |
| `scrubFields.js`                           | Bulk remove/transform fields across a collection.                                                                      | target collection, field list, `DRY_RUN`                                              | `node scripts/scrubFields.js`                                                      |
| `fillCurrentWeekRoster.js`                 | ALCE-specific: populate/update current week roster docs.                                                               | see script                                                                            | `node scripts/fillCurrentWeekRoster.js`                                            |

> Tip: most scripts expose a `CONFIG` block at the top—review before running.

---

## ⚠️ Safety & Dry-Run

* Prefer **`DRY_RUN: true`** on first pass where available.
* `copyCollection.js`

  * `INCLUDE_SUBCOLLECTIONS: true` → copies all descendants.
  * `IS_DESTRUCTIVE: true` → **deletes the source** after a successful copy.
* `copyStoragePrefix.js` does **not** delete anything; it only copies.
  Use separate cleanup logic if needed.

---

## 🔑 Environment

* **Required**:
  `GOOGLE_APPLICATION_CREDENTIALS=./secrets/<key>.json`
* **Optional (for Stripe script)**:
  `STRIPE_API_KEY=sk_test_************************`

> `.env` and everything in `secrets/` are ignored by `.gitignore`.

---

## 🧪 One-liners to verify setup

```bash
# Show project & default bucket
node -e "const a=require('./firebaseAdmin'); console.log({project:a.admin.app().options.projectId, bucket:a.bucket.name})"

# Stripe key present?
node -e "require('dotenv').config(); console.log('stripe key starts with:', (process.env.STRIPE_API_KEY||'').slice(0,8))"
```

---

## 🛠️ Optional npm scripts

Add to `package.json` to shorten commands:

```json
{
  "scripts": {
    "copy:col": "node scripts/copyCollection.js",
    "copy:storage": "node scripts/copyStoragePrefix.js",
    "schema": "node scripts/inferSchema.js",
    "admin:set": "node scripts/setAdminStatus.js",
    "stripe:backfill": "node scripts/createStripeCustomersForExistingUsers.js"
  }
}
```

---

## 📦 Repo hygiene

* `.gitignore` excludes `.env`, `secrets/`, and common noise.
* Add a public-safe **.env.example** (already provided).

---

## License

MIT (or your preferred license).

---

> **Note:** If you want, I can tailor the short per-script descriptions to exactly what each script does as you finalize them—just paste any headers/configs you want reflected.
