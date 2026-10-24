# Firebase-Admin-Utils

Firebase Admin scripts for the jobs every Firebase project runs into: editing and
cleaning Firestore data, backing it up and restoring it, auditing Auth users and
Storage files, and a few Cloud Messaging and Stripe chores.

Each script is a single file with a `CONFIG` block at the top. You set it, read
a dry run, then run it for real.

---

## How every script behaves

- **Dry run first.** `DRY_RUN` is `true` by default: the script reads, prints
  what it would change and writes nothing.
- **A backup before every write.** An armed run first saves the documents it is
  about to change into `backups/`, in the same format as `backupFirestore.js`,
  so `restoreFirestore.js` can put them back.
- **No lost updates.** Each write is refused if the document changed after the
  script read it; the run lists those and can simply be run again.
- **One project, printed.** Every run starts with `Using project: <id>`.

---

## Quick start

1. **Install**

   ```bash
   npm i
   ```

2. **Choose what to connect to.** Copy the example env file:

   ```bash
   cp .env.example .env
   ```

   - **A real project:** put its service account key under `./secrets/` (git
     ignores it) and point `GOOGLE_APPLICATION_CREDENTIALS` at it. Set
     `FIREBASE_STORAGE_BUCKET` if your bucket isn't `<project-id>.appspot.com`
     (projects created since late 2024 use `<project-id>.firebasestorage.app`).
   - **The local emulators, to try things safely:** no key needed. Start them
     with `npm run emulators` (needs the
     [Firebase CLI](https://firebase.google.com/docs/cli) and Java), then
     uncomment the emulator lines in `.env`. The project must be a `demo-` one,
     so nothing can reach a real project by accident.

3. **Run a script**

   ```bash
   node scripts/<area>/<script>.js
   ```

   `firebaseAdmin.js` finds `.env` next to itself, so you can run scripts from
   any directory.

---

## Layout

| Path | What's there |
|---|---|
| `firebaseAdmin.js` | The shared Admin init. Exports `admin`, `db`, `auth`, `bucket`, `projectId`, `emulated`, `FieldValue`, `Timestamp`, `GeoPoint`. |
| `lib/` | Code the scripts share: the backup format, guarded writes, paging. |
| `scripts/<area>/` | The scripts, by area: `firestore`, `auth`, `storage`, `messaging`, `stripe`. |
| `test/` | Tests of the scripts' decisions: `npm test`, no Firebase needed. |
| `backups/` | Backups and before-write snapshots. Git ignores it. |

---

## Scripts

### Firestore

Most Firestore scripts choose their documents with the same four `CONFIG` keys:
`COLLECTION` (a collection path such as `users` or `users/abc/posts`),
`USE_COLLECTION_GROUP` (every collection with that id, at any depth), `WHERE`
(`[[field, op, value], ...]`) and `DOC_IDS` (only these ids). Documents are
read a page at a time, so large collections are fine.

Any script's before-write snapshot in `backups/` restores with
`restoreFirestore.js` in `overwrite` mode.

#### `backupFirestore.js`: back up the database to a file

Backs up the whole database, or chosen collections, subcollections or document
subtrees, into one NDJSON file under `backups/`. Subcollections at any depth
are included, even under documents that were deleted, and every Firestore type
(Timestamp, GeoPoint, reference, bytes, vector) survives exactly. It only reads.

```bash
node scripts/firestore/backupFirestore.js              # the whole database
node scripts/firestore/backupFirestore.js users posts  # these collections
node scripts/firestore/backupFirestore.js users/abc    # one doc and everything under it
```

#### `restoreFirestore.js`: restore a backup

Restores a backup file, all of it or only some paths (`TARGETS`). It checks the
whole file first, refuses a backup from another project unless you allow it,
and snapshots what it is about to overwrite into `backups/pre-restore-*.ndjson`.

| `MODE` | What happens |
|---|---|
| `overwrite` (default) | each backed-up doc becomes exactly its backup; newer docs stay |
| `merge` | backed-up fields are laid over what is there now |
| `wipe` | the restore scope is deleted first, then written: a true point-in-time restore. Needs `CONFIRM_PROJECT_ID` |

```bash
node scripts/firestore/restoreFirestore.js backups/firestore-<project>-<time>.ndjson
```

#### `alterFields.js`: change field values

Applies value rules, in order, to every chosen document: `set`, `copy`,
`move` (rename a field), `increment`, `replace` (regex, strings only), `coerce` (to string, number, int
or boolean) and `serverTimestamp`. Each rule can be limited with `onlyIf`
(`exists`, `missing`, or `equals` a value). `ARRAY_ALTERS` applies the same
rules to the objects inside an array field. A rule that would leave a value as
it is writes nothing, so running it twice is harmless.

```js
ALTERS: [
  { op: "set", path: "status", value: "active", onlyIf: "missing" },
  { op: "coerce", path: "age", type: "int" },
  { op: "move", from: "first_name", to: "firstName" },
],
```
