// projects/alce/setAdminStatus.js
//
// Grant or revoke panel access, and grant or revoke the master flag.
//
// `admin` is the account type and lives in the custom claim. What the person
// may do lives on `staff_members/{uid}/private/access`: `master`, `access`,
// `scope`, and `status`, which every guard and rule requires to be 'active'.
// `master` is never in the claim, because a claim is up to an hour stale and
// the whole point of the master flag is that changes to who can manage
// accounts take effect now.
//
// This is also the bootstrap: setStaffAccess and setStaffLoginEnabled refuse a
// caller who is not already a master, so the first master cannot be created
// through the panel.
//
// ── What it writes ──────────────────────────────────────────────────────────
// Grant: the admin claim, and
//   • staff_members/{uid}, if missing: display name and email from Auth, a
//     login, active, not listed on Meet Us. An existing member only gets
//     `master` (when SET_MASTER is set), as syncStaffMaster would;
//   • its access doc, if missing: `status: 'active'` (granting is meant to
//     give a working login) and `master`. An existing access doc only gets
//     `master` (when SET_MASTER is set): its status is never changed, so this
//     never silently re-enables a disabled login.
// Revoke: the admin claim off, and the access doc `status: 'disabled'`,
//   `master: false`. The member stays: staff are archived, never deleted
//   (archive them from the panel). The Auth user is left as it is; without
//   the claim and an active access doc nothing lets it in.
//
// ── Why it is safe ──────────────────────────────────────────────────────────
// Released app builds never read staff records. It writes no `admins` doc, so
// a panel hosted from before the staff-members panel does not list a member
// granted here; the deployed functions and rules (which read only the access
// doc) let them in all the same.
//
// ── Order ───────────────────────────────────────────────────────────────────
// Only after migrateStaff.js and the functions + rules deploy. Before that the
// guards read `admins/{uid}`, which this no longer writes.
//
// ── Running it ───────────────────────────────────────────────────────────────
//   1. Edit CONFIG. Leave DRY_RUN = true. Run it. Read what it would write.
//   2. Set DRY_RUN = false, run once, set it back to true.

const CONFIG = {
  TARGET_EMAIL: "",                     // <-- change this
  MAKE_ADMIN: true,                     // true => grant, false => revoke
  SET_MASTER: true,                     // true => grant, false => revoke, null => leave as-is
  CALLER_UID: "",                       // uid of the staff member performing this action
  ALLOW_SELF_DEMOTE: false,            // prevent a staff member from revoking their own access
  SKIP_CALLER_CHECK: false,            // set true only for first-time bootstrap
  DRY_RUN: true,                       // true => preview only; no claims/Firestore writes
};

/**
 * The Firestore writes for a grant or revoke, or none. `member` and `access`
 * are the stored docs (null when missing); `stamp` is the server-timestamp
 * sentinel; `by` is the who-field of the person acting.
 *
 * → { member: { data, merge } | null, access: { data, merge } | null }
 */
function writesFor({ MAKE_ADMIN, SET_MASTER }, { member, access, user, by, stamp }) {
  const created = { createdAt: stamp, createdBy: by, updatedAt: stamp, updatedBy: by };
  const updated = { updatedAt: stamp, updatedBy: by };

  if (!MAKE_ADMIN) {
    return {
      // A synced copy (syncStaffMaster): no audit fields.
      member: member && member.master === true ? { data: { master: false }, merge: true } : null,
      access: access ? { data: { status: "disabled", master: false, ...updated }, merge: true } : null,
    };
  }

  const email = String(user.email || "").trim().toLowerCase();
  const memberWrite = member
    ? (SET_MASTER !== null && member.master !== SET_MASTER ? { data: { master: SET_MASTER }, merge: true } : null)
    : {
      data: {
        displayName: String(user.displayName || "").trim() || email,
        email,
        master: SET_MASTER === true,
        publicProfile: { listed: false },
        account: { hasAccount: true, grantedAt: stamp, grantedBy: by },
        status: "active",
        ...created,
      },
      merge: false,
    };
  const accessWrite = access
    ? (SET_MASTER !== null && access.master !== SET_MASTER ? { data: { master: SET_MASTER, ...updated }, merge: true } : null)
    : { data: { master: SET_MASTER === true, status: "active", ...created }, merge: false };
  return { member: memberWrite, access: accessWrite };
}

async function main() {
  const { auth, db, FieldValue } = require("../../firebaseAdmin");
  const {
    TARGET_EMAIL, MAKE_ADMIN, SET_MASTER, CALLER_UID,
    ALLOW_SELF_DEMOTE, SKIP_CALLER_CHECK, DRY_RUN,
  } = CONFIG;
  const memberRef = (uid) => db.collection("staff_members").doc(uid);
  const accessRef = (uid) => memberRef(uid).collection("private").doc("access");

  console.log("🚀 Starting setAdminStatus...");

  // --- Input validation (keep it simple & explicit) ---
  if (!TARGET_EMAIL || typeof TARGET_EMAIL !== "string" || !TARGET_EMAIL.includes("@")) {
    throw new Error("Valid TARGET_EMAIL is required (string with '@').");
  }
  if (typeof MAKE_ADMIN !== "boolean") {
    throw new Error("MAKE_ADMIN must be a boolean (true|false).");
  }
  if (SET_MASTER !== true && SET_MASTER !== false && SET_MASTER !== null) {
    throw new Error("SET_MASTER must be true, false or null.");
  }
  if (SET_MASTER === true && !MAKE_ADMIN) {
    throw new Error("SET_MASTER=true requires MAKE_ADMIN=true: master is a capability of a staff login.");
  }

  // --- Caller authorization (mirrors requireStaff in the CF guards) ---
  if (!SKIP_CALLER_CHECK) {
    if (!CALLER_UID) throw new Error("CALLER_UID is required for the caller check.");
    let caller;
    try {
      caller = await auth.getUser(CALLER_UID);
    } catch (e) {
      if (e && e.code === "auth/user-not-found") throw new Error("Caller not found in Auth.");
      throw new Error(`Failed to fetch caller: ${e.message}`);
    }
    if ((caller.customClaims || {}).admin !== true) {
      throw new Error("Action requires admin privileges (custom claim admin=true).");
    }
    const callerAccess = await accessRef(CALLER_UID).get();
    if (callerAccess.data()?.status !== "active") {
      throw new Error("The caller has no active staff_members access doc.");
    }
  }
  const by = CALLER_UID ? { type: "staff", uid: CALLER_UID } : { type: "system" };

  console.log(`🔎 Looking up target by email: ${TARGET_EMAIL}`);
  const user = await auth.getUserByEmail(TARGET_EMAIL);
  const uid = user.uid;
  const currentClaims = user.customClaims || {};

  const [memberSnap, accessSnap, studentSnap, sameEmail] = await Promise.all([
    memberRef(uid).get(),
    accessRef(uid).get(),
    db.collection("users").doc(uid).get(),
    db.collection("staff_members").where("email", "==", String(user.email || "").trim().toLowerCase()).get(),
  ]);
  const member = memberSnap.exists ? memberSnap.data() : null;
  const access = accessSnap.exists ? accessSnap.data() : null;

  const show = (v) => (v === undefined ? "(absent)" : String(v));
  console.log(`   uid            : ${uid}`);
  console.log(`   admin claim    : ${currentClaims.admin === true}  ->  ${MAKE_ADMIN}`);
  console.log(`   staff member   : ${member ? `exists, ${show(member.status)}` : "missing"}`);
  console.log(`   access doc     : ${access ? "exists" : "missing"}`);
  console.log(`   master         : ${show(access?.master)}  ->  ${SET_MASTER === null ? "(unchanged)" : MAKE_ADMIN ? SET_MASTER : false}`);
  console.log(`   access status  : ${show(access?.status)}`);

  if (MAKE_ADMIN) {
    // A uid is staff or student, never both (accounts.js).
    if (studentSnap.exists) {
      console.log("⛔ This login belongs to a student (users/ doc). Aborting.");
      return;
    }
    const other = sameEmail.docs.find((d) => d.id !== uid);
    if (other) {
      console.log(`⛔ staff_members/${other.id} already holds this email, without this login. Give that record the login from the panel (grant login) instead. Aborting.`);
      return;
    }
    if (member?.status === "archived") {
      console.log("⛔ This staff member is archived. Restore them from the panel first. Aborting.");
      return;
    }
  }

  // Prevent self-demotion unless explicitly allowed: revoking your own admin
  // claim locks you out of the panel, and of this script.
  if (!ALLOW_SELF_DEMOTE && currentClaims.admin && !MAKE_ADMIN && uid === CALLER_UID) {
    console.log("⛔ Self-demotion is blocked by ALLOW_SELF_DEMOTE=false. Aborting.");
    return;
  }

  // The last active master cannot be demoted, or nobody can ever manage
  // accounts again. Mirrors setStaffLoginEnabled / setStaffArchived.
  const losesMaster = access?.master === true && (SET_MASTER === false || !MAKE_ADMIN);
  if (losesMaster) {
    const all = await db.collection("staff_members").get();
    const docs = all.size ? await db.getAll(...all.docs.map((d) => accessRef(d.id))) : [];
    const others = docs.filter((s) => s.exists && s.ref.parent.parent.id !== uid &&
      s.data().master === true && s.data().status === "active").length;
    if (others === 0) {
      console.log("⛔ This is the last active master. Demoting it would leave nobody able to manage accounts. Aborting.");
      return;
    }
  }

  // `admin` is the whole account type; there are no other claims to keep.
  const newClaims = { ...currentClaims, admin: MAKE_ADMIN };
  const writes = writesFor({ MAKE_ADMIN, SET_MASTER }, {
    member, access, user, by, stamp: FieldValue.serverTimestamp(),
  });

  if (DRY_RUN) {
    const describe = (w) => (w ? `${w.merge ? "merge" : "create"} { ${Object.keys(w.data).join(", ")} }` : "nothing");
    console.log("🧪 DRY_RUN is ON — no writes will be performed.");
    console.log(`→ (dry-run) would set custom claims for ${uid}: admin=${MAKE_ADMIN}`);
    console.log(`→ (dry-run) staff_members/${uid}: ${describe(writes.member)}`);
    console.log(`→ (dry-run) staff_members/${uid}/private/access: ${describe(writes.access)}`);
    console.log("✅ DRY RUN complete.");
    return;
  }

  await auth.setCustomUserClaims(uid, newClaims);
  console.log(`✔️  Updated custom claims for ${uid}: admin=${MAKE_ADMIN}`);

  const batch = db.batch();
  if (writes.member) batch.set(memberRef(uid), writes.member.data, { merge: writes.member.merge });
  if (writes.access) batch.set(accessRef(uid), writes.access.data, { merge: writes.access.merge });
  await batch.commit();
  if (writes.member) console.log(`✔️  ${writes.member.merge ? "Updated" : "Created"} staff_members/${uid}`);
  if (writes.access) console.log(`✔️  ${writes.access.merge ? "Updated" : "Created"} its access doc`);

  if (MAKE_ADMIN) {
    console.log(`🎉 ${TARGET_EMAIL} is now staff${SET_MASTER === true ? " and a master" : ""}.`);
    if (access && access.status !== "active") {
      console.log("ℹ️  Their access doc is disabled: enable the login from the panel.");
    }
  } else {
    console.log(`ℹ️  Panel access revoked for ${TARGET_EMAIL}.`);
  }
  console.log("✅ Done. Note: target must refresh their ID token for new claims to take effect.");
}

module.exports = { writesFor };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error("❌ setAdminStatus failed:", e?.message || String(e));
    process.exit(1);
  });
}
