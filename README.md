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
| `scripts/<area>/` | The scripts, by area: `firestore`, `auth`, `storage`, `messaging`, `stripe`. |
| `backups/` | Backups and before-write snapshots. Git ignores it. |

---

## Scripts
