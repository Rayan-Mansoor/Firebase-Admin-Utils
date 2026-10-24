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

#### `scrubFields.js`: remove fields and subcollections

Deletes fields (or sets them to `null` with `HARD_DELETE: false`), strips keys
from the objects inside array fields (`ARRAY_CLEANERS`), and can delete whole
subcollections under each chosen document (`SUBCOLLECTIONS_TO_DELETE`, always a
real delete). The dry run counts each subcollection's documents; the armed run
saves both the documents and the subcollections before touching them.

```js
FIELD_PATHS: ["legacyId", "profile.oldAvatar"],
SUBCOLLECTIONS_TO_DELETE: ["sessions"],
HARD_DELETE: true,
```

#### `copyCollection.js`: copy or move a collection

Copies every document to the same id under another collection, optionally with
all subcollections (`INCLUDE_SUBCOLLECTIONS`). With `IS_DESTRUCTIVE` it becomes a
move: once every copy has landed, the source is backed up and deleted.
Destination documents it overwrites are saved first. References inside the
documents are copied as they are.

```js
SOURCE_COLLECTION: "users",
DESTINATION_COLLECTION: "archive/2026/users",
INCLUDE_SUBCOLLECTIONS: true,
```

`TRANSFORM` reshapes each document on the way: a function given the data and
`{ id, path, destPath }` that returns the new data, or `null` to skip the
document. Fields it sets to `undefined` are dropped. A move that skipped
documents keeps its source.

```js
TRANSFORM: (data, { id }) => ({ name: `${data.first} ${data.last}`, migratedFrom: id }),
```

#### `deleteCollection.js`: delete safely, after a checked backup

Deletes collections or document subtrees (`PATHS`), or the documents a query
matches (`COLLECTION` with `WHERE` or `DOC_IDS`, with their subcollections unless
`INCLUDE_SUBCOLLECTIONS` is off). The armed run needs `CONFIRM_PROJECT_ID`, backs
everything up, re-reads what is there and deletes only if every document is in
the backup.

```js
PATHS: ["legacy_users"],               // or:
COLLECTION: "logs", WHERE: [["createdAt", "<", someTimestamp]],
```

#### `backfillTtl.js`: give old documents a TTL expiry

Writes `EXPIRY_FIELD = SOURCE_FIELD + TTL_DAYS` on documents that lack it, so a
[TTL policy](https://firebase.google.com/docs/firestore/ttl) clears the backlog
the same way it clears new documents. The dry run says how many would expire at
once; the script prints the `gcloud` command that turns the policy on.

```js
COLLECTION: "notifications", USE_COLLECTION_GROUP: true,
SOURCE_FIELD: "createdAt", EXPIRY_FIELD: "expiresAt", TTL_DAYS: 90,
```

#### `backfillTimestamps.js`: fill in missing created / updated times

Firestore records when every document was created and last written. This copies
those times into `createdAt` / `updatedAt` (names configurable, either can be
off) wherever the field is missing, as a Timestamp, an ISO string or epoch
milliseconds. Fields already set are never touched.

#### `linkByLabel.js`: turn stored names into links

For each document, finds the one document in `LOOKUP_COLLECTION` whose label
(`LOOKUP_LABEL_FIELDS`) matches its `LABEL_FIELD`, ignoring accents, spacing and
case, and writes its id, path or a reference into `ID_FIELD`. Works on a
top-level field or on each object of an array field (`ARRAY_PATH`). A name
matching several documents is reported, never guessed; one matching none is
reported with near misses.

```js
COLLECTION: "lessons", ARRAY_PATH: "slots",
LABEL_FIELD: "teacherName", ID_FIELD: "teacherId",
LOOKUP_COLLECTION: "teachers", LOOKUP_LABEL_FIELDS: ["displayName"],
```

#### `importCollection.js`: load JSON or CSV into a collection

Imports a JSON file (an array of objects, or `{ id: object }`; values may use the
backup format's type tags) or a CSV file (header row; `TYPES` turns cells into
numbers, booleans, timestamps or JSON; a header like `price.amount` builds a
nested map). Each document's id comes from `ID_FIELD`, or is generated.
`MODE: "create"` skips existing ids, `"merge"` updates only the fields given,
`"overwrite"` replaces documents whole. A bad row stops the import before
anything is written.

```bash
node scripts/firestore/importCollection.js data/products.csv
```
