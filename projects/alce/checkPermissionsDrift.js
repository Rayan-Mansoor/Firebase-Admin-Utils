// projects/alce/checkPermissionsDrift.js
//
// Read-only. Compares the four places the permission vocabulary lives and
// reports where they disagree.
//
// The keys exist in three copies by necessity — Firestore rules cannot
// import JavaScript, and the panel is Dart — plus a fourth, informal copy in
// whatever is actually stored on `staff_members/{id}/private/access`. Nothing
// keeps them in step. Drift here fails closed and silently: a key the rules
// never heard of evaluates to level 0, so the staff member quietly loses a
// section and the first report is a person saying a screen went blank.
//
// It also checks the stored records hang together: every staff member has an
// access doc (the guards and rules deny without one), its `status` is one the
// guards know, and `staff_members/{id}.master` matches the access doc's
// `master` (syncStaffMaster keeps it so; pickers and Meet Us read the copy).
//
// Run it after changing any of:
//   • functions/src/domain/adminAccess.js   (the source of truth)
//   • firestore.rules                       (canView / canEdit / scopeOf)
//   • lib/models/staff/admin_access.dart    (AccessKeys)
// and after migrateStaff.js (before it, `staff_members` is empty).
//
// Writes nothing, so there is no DRY_RUN and nothing a released app build or
// the hosted panel could notice.

const fs = require("fs");
const path = require("path");

// Sibling checkouts. Override when the repos live elsewhere.
const FUNCTIONS_DIR =
  process.env.ALCE_FUNCTIONS_DIR ||
  path.resolve(__dirname, "../../../../Firebase-Cloud-Functions/ALCE-Cloud-Functions");
const PANEL_DIR =
  process.env.ALCE_PANEL_DIR ||
  path.resolve(__dirname, "../../../../Flutter-Projects/Flutter-ALCE-Admin");

const ACCESS_STATUSES = ["active", "disabled"];

/** Every file called `name` under `dir`, for saying where a file moved to. */
function findByName(dir, name, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findByName(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

function readOrDie(file, root, hint) {
  if (!fs.existsSync(file)) {
    console.error(`❌ Not found: ${file}`);
    const moved = findByName(root, path.basename(file));
    if (moved.length) console.error(`   It is now at: ${moved.join(", ")}. Update the path in this script.`);
    else console.error(`   ${hint}`);
    process.exit(1);
  }
  return fs.readFileSync(file, "utf8");
}

/** Every quoted key in a `const X = [ ... ]` array literal. */
function jsArrayLiteral(source, name) {
  const m = new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`).exec(source);
  if (!m) return null;
  return [...m[1].matchAll(/['"]([a-z][a-zA-Z.]*)['"]/g)].map((x) => x[1]);
}

function diff(a, b) {
  return [...a].filter((x) => !b.includes(x));
}

function report(label, missing) {
  if (missing.length === 0) return false;
  console.log(`   ⚠️  ${label}: ${missing.join(", ")}`);
  return true;
}

/**
 * The problems (drift) and notes (worth knowing) of every stored staff member.
 * `members` and `accessDocs` map a member id to its data; `accessDocs` has no
 * entry for a member without an access doc.
 */
function storedProblems(members, accessDocs, { keys, scopable, renamedKeys }) {
  const rows = [];
  for (const [id, member] of members) {
    const label = String(member?.displayName || "").trim() || String(member?.email || "") || id;
    const problems = [];
    const notes = [];
    const data = accessDocs.get(id);

    if (!data) {
      problems.push("no access doc (private/access): every guard and rule denies it");
      rows.push({ id, label, problems, notes });
      continue;
    }

    if (!ACCESS_STATUSES.includes(data.status)) {
      problems.push(`access status ${JSON.stringify(data.status ?? null)} (the guards allow only 'active')`);
    }
    if ((member?.master === true) !== (data.master === true)) {
      problems.push(`master ${member?.master === true} on the member but ${data.master === true} on its access doc (syncStaffMaster keeps them equal)`);
    }

    for (const k of Object.keys(data.access || {})) {
      if (k in renamedKeys) problems.push(`old key name '${k}' (run renamePermissionKeys.js)`);
      else if (!keys.includes(k)) problems.push(`unknown key '${k}'`);
      const lvl = data.access[k];
      if (![0, 1, 2].includes(lvl)) problems.push(`'${k}' has level ${lvl}`);
    }
    for (const [k, v] of Object.entries(data.scope || {})) {
      if (k in renamedKeys) continue; // reported with its access entry
      if (!scopable.includes(k)) problems.push(`'${k}' is scoped but not scopable`);
      if (v !== "own" && v !== "all") problems.push(`'${k}' has scope '${v}'`);
      if (v === "own" && !(data.access || {})[k]) {
        problems.push(`'${k}' is scoped but not granted`);
      }
    }

    // Not drift: staff scoped to their own students can't book rooms or set a
    // place's residents (the booking callables refuse them), so they manage a
    // place's details only. Worth knowing when that is not what the access
    // was meant to do.
    const studentScoped = Object.keys(data.scope || {}).some((k) =>
      k.startsWith("students.")
    );
    for (const key of ["accommodation.properties", "accommodation.bookings"]) {
      if (studentScoped && (data.access || {})[key]) {
        notes.push(`holds ${key} but is scoped to own students, so it can't book rooms or set residents`);
      }
    }

    if (data.master === true && Object.keys(data.access || {}).length > 0) {
      problems.push("master with an access map — it is ignored, and misleading to leave");
    }

    if (problems.length || notes.length) rows.push({ id, label, problems, notes });
  }
  return rows;
}

async function main() {
  let drifted = false;

  // ---- 1) The source of truth ----
  const domain = readOrDie(
    path.join(FUNCTIONS_DIR, "functions/src/domain/adminAccess.js"),
    FUNCTIONS_DIR,
    "Set ALCE_FUNCTIONS_DIR to the ALCE-Cloud-Functions checkout."
  );
  const keys = jsArrayLiteral(domain, "ACCESS_KEYS");
  const scopable = jsArrayLiteral(domain, "SCOPABLE_KEYS");
  if (!keys || !scopable) {
    console.error("❌ Could not parse ACCESS_KEYS / SCOPABLE_KEYS from adminAccess.js.");
    process.exit(1);
  }
  // Old names still accepted while a rename is in progress
  // (LEGACY(permission-key-renames) in adminAccess.js): old → new.
  const renamedBlock = /const RENAMED_KEYS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(domain);
  const renamedKeys = Object.fromEntries(
    renamedBlock
      ? [...renamedBlock[1].matchAll(/['"]?([a-zA-Z.]+)['"]?\s*:\s*['"]([a-z][a-zA-Z.]*)['"]/g)].map((m) => [m[1], m[2]])
      : []
  );
  console.log(`📖 adminAccess.js defines ${keys.length} keys, ${scopable.length} scopable.`);
  if (Object.keys(renamedKeys).length) {
    console.log(`   Being renamed: ${Object.entries(renamedKeys).map(([o, n]) => `${o} → ${n}`).join(", ")}`);
  }
  console.log("");

  // ---- 2) firestore.rules ----
  // Every key the rules actually ask about. A key defined but never checked is
  // not necessarily wrong — some are enforced only in a callable — so that
  // direction is reported as a note rather than as drift.
  const rules = readOrDie(
    path.join(FUNCTIONS_DIR, "firestore.rules"),
    FUNCTIONS_DIR,
    "Set ALCE_FUNCTIONS_DIR to the ALCE-Cloud-Functions checkout."
  );
  const inRules = [
    ...new Set(
      [...rules.matchAll(/can(?:View|Edit)\(\s*'([a-z][a-zA-Z.]*)'|scopeOf\(\s*'([a-z][a-zA-Z.]*)'|allRecords\(\s*'([a-z][a-zA-Z.]*)'|'(students\.[a-z]+)'/g)]
        .map((m) => m[1] || m[2] || m[3] || m[4])
        .filter(Boolean)
    ),
  ];
  console.log("🔒 firestore.rules");
  drifted = report("checks keys that do not exist", diff(inRules, [...keys, ...Object.keys(renamedKeys)])) || drifted;
  const oldInRules = inRules.filter((k) => k in renamedKeys);
  if (oldInRules.length) console.log(`   ℹ️  still accepts the old names: ${oldInRules.join(", ")}`);
  const unchecked = diff(keys, inRules);
  if (unchecked.length) {
    console.log(`   ℹ️  defined but never checked in rules: ${unchecked.join(", ")}`);
    console.log("      (expected for keys enforced only inside a callable)");
  }

  // ---- 3) The panel ----
  const dart = readOrDie(
    path.join(PANEL_DIR, "lib/models/staff/admin_access.dart"),
    path.join(PANEL_DIR, "lib"),
    "Set ALCE_PANEL_DIR to the Flutter-ALCE-Admin checkout."
  );
  // Only `static const name = 'key';` — matching every quoted string would
  // pick up 'own' and 'all' from the scope helpers.
  const byName = {};
  for (const m of dart.matchAll(/static const ([a-zA-Z]+) = '([a-z][a-zA-Z.]*)';/g)) {
    byName[m[1]] = m[2];
  }
  const inDart = Object.values(byName);
  console.log("\n📱 admin_access.dart");
  drifted = report("missing keys", diff(keys, inDart)) || drifted;
  drifted = report("keys that no longer exist", diff(inDart, keys)) || drifted;

  // The panel's scopable set decides whether the access editor offers an "Own"
  // switch at all, so a key missing here can never be scoped from the UI.
  const dartScopableBlock = /static const Set<String> scopable = \{([\s\S]*?)\};/.exec(dart);
  const dartStudentScopable = /static const List<String> studentScopable = \[([\s\S]*?)\];/.exec(dart);
  if (dartScopableBlock) {
    const body = dartScopableBlock[1];
    // Follow `...studentScopable` only when the set actually spreads it.
    // Reading that list unconditionally would hide the one drift most likely
    // to happen here: Tier B keys defined but never added to `scopable`, so
    // the access editor offers no "Own" switch and no student can be scoped.
    const spreadsStudents = /\.\.\.studentScopable/.test(body);
    const names = [
      ...body.matchAll(/^\s*([a-zA-Z]+)\s*,/gm),
      ...(spreadsStudents && dartStudentScopable
        ? dartStudentScopable[1].matchAll(/^\s*([a-zA-Z]+)\s*,/gm)
        : []),
    ].map((m) => m[1]);
    const dartScopable = names.map((n) => byName[n]).filter(Boolean);
    drifted = report("scopable: missing", diff(scopable, dartScopable)) || drifted;
    drifted = report("scopable: no longer scopable", diff(dartScopable, scopable)) || drifted;
  }

  // ---- 4) What is actually stored ----
  const { db } = require("../../firebaseAdmin");
  console.log("\n👥 staff_members/*/private/access");
  const snap = await db.collection("staff_members").get();
  const accessSnaps = snap.size
    ? await db.getAll(...snap.docs.map((d) => d.ref.collection("private").doc("access")))
    : [];
  const members = new Map(snap.docs.map((d) => [d.id, d.data() || {}]));
  const accessDocs = new Map(accessSnaps.filter((s) => s.exists).map((s) => [s.ref.parent.parent.id, s.data() || {}]));
  if (!members.size) console.log("   ⚠️  no staff members: run migrateStaff.js first.");

  for (const row of storedProblems(members, accessDocs, { keys, scopable, renamedKeys })) {
    if (row.problems.length) {
      drifted = true;
      console.log(`   ⚠️  ${row.label}: ${row.problems.join("; ")}`);
    }
    if (row.notes.length) console.log(`   ℹ️  ${row.label}: ${row.notes.join("; ")}`);
  }
  if (!drifted) console.log(`   ✅ all ${members.size} staff members have a valid access doc.`);

  console.log(
    drifted
      ? "\n❌ Drift found — see above."
      : "\n✅ No drift. All four copies of the vocabulary agree."
  );
  return drifted;
}

module.exports = { jsArrayLiteral, storedProblems };

if (require.main === module) {
  main().then((drifted) => process.exit(drifted ? 1 : 0)).catch((e) => {
    console.error("❌ Error:", e?.stack || e?.message || String(e));
    process.exit(1);
  });
}
