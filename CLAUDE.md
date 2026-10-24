# Firebase-Admin-Utils

A public, generic Firebase Admin toolkit. Generic scripts live in `scripts/<area>/`.
ALCE's reusable scripts live in `projects/alce/` (tracked, public by choice).
ALCE one-off scripts go in `projects/alce/one-off/`, which git ignores; write new
one-offs there, never in `scripts/`.

## Checks
- `npm test` must pass before every commit.
- Verify scripts against the emulators (`npm run emulators`, project
  `demo-firebase-admin-utils`), never against a real project unless asked.
- No running process to read logs from.

## Script conventions
- Header comment (what it does, what it writes, why it's safe, how to run it),
  then a `CONFIG` block with `DRY_RUN: true` and `validateConfig()`.
- An armed run snapshots what it will change with `lib/beforeState` (restorable by
  restoreFirestore) and guards every update with the update time it read.
- `firebaseAdmin` is required inside `main()`; pure decisions are exported for tests
  under `require.main === module`.
- A script's README section and its test land in the same commit as the script;
  `lib/` code lands with the first script that uses it.

## Git
- Subject line only: a plain imperative sentence naming what was gained, no
  trailer. Match the recent log.

## Decisions
- 2026-10-24: ALCE scripts stay in this repo; a narrow script covered by a generic
  one is deleted, other one-offs move to `projects/alce/one-off/`.
