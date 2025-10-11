// scripts/fillCurrentWeekRoster.js
const { db, FieldValue } = require("../firebaseAdmin");

const TZ = "Europe/Rome";

// ---------- Time helpers (Europe/Rome ISO-week semantics) ----------
/** Monday 00:00 (local Europe/Rome) of the ISO week containing `date` */
function mondayOfIsoWeek(date, tz = TZ) {
  const dStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const [dd, mm, yyyy] = dStr.split("/");
  const localMidnight = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
  const dayNum = (localMidnight.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const monday = new Date(localMidnight);
  monday.setUTCDate(localMidnight.getUTCDate() - dayNum); // back to Monday
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

/** "YYYY-MM-DD" for the given date in the provided TZ */
function ymdInTz(date, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date); // en-CA gives YYYY-MM-DD
}

/** Whole ISO weeks between the ISO-week Monday of `start` and `end` (Europe/Rome). */
function weeksBetweenIsoWeeks(start, end, tz = TZ) {
  const mStart = mondayOfIsoWeek(start, tz);
  const mEnd = mondayOfIsoWeek(end, tz);
  const diffMs = mEnd.getTime() - mStart.getTime();
  return Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
}

// ---------- Helpers ----------
function assessedKey(val) {
  // Accepts either a string ('a1') or an object { name: 'a1', label: 'A1' }
  if (!val) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object" && val.name) return String(val.name);
  return null;
}

(async () => {
  try {
    const now = new Date();
    const weekMonday = mondayOfIsoWeek(now, TZ);
    const weekMondayYmd = ymdInTz(weekMonday, TZ);
    console.log(`📅 Current ISO week Monday (Europe/Rome) = ${weekMondayYmd}`);

    // ---- 1) Load all users once, compute who is ACTIVE for THIS week, group by level/sublevel ----
    const usersSnap = await db.collection("users").get();
    console.log(`👥 Users fetched: ${usersSnap.size}`);

    // group key is "${levelKey}_${sublevelKey}"
    const grouped = new Map(); // key -> Set<uid>

    for (const uDoc of usersSnap.docs) {
      const u = uDoc.data() || {};
      const basic = u.basicInfo || {};
      const arrival = u.arrivalInfo || {};

      const levelKey = assessedKey(basic.assessedLevel);
      const subKey = assessedKey(basic.assessedSublevel);
      if (!levelKey || !subKey) continue;

      // Course window gating: include only students with a current active week
      const arrivalDate = typeof arrival.arrivalDate === "string" ? arrival.arrivalDate : null; // "YYYY-MM-DD"
      const totalWeeks = Number.isFinite(Number(arrival.noOfWeeks)) ? (Number(arrival.noOfWeeks) | 0) : null;
      if (!arrivalDate || totalWeeks === null) continue;

      const arr = new Date(`${arrivalDate}T00:00:00Z`);
      if (Number.isNaN(arr.getTime())) continue;

      // Arrival week counts as the first active week: weeksSinceArrival === 0 → active.
      const weeksSinceArrival = weeksBetweenIsoWeeks(arr, weekMonday, TZ);
      if (weeksSinceArrival < 0) continue;           // course not started yet
      if (weeksSinceArrival >= totalWeeks) continue; // course finished

      const key = `${levelKey}_${subKey}`;
      if (!grouped.has(key)) grouped.set(key, new Set());
      grouped.get(key).add(uDoc.id);
    }

    // ---- 2) Load all weekly_lesson docs and write (merge) the roster into this week's attendance doc ----
    const lessonsSnap = await db.collection("weekly_lessons").get();
    console.log(`📚 weekly_lessons fetched: ${lessonsSnap.size}`);

    let writes = 0;
    for (const lesson of lessonsSnap.docs) {
      const data = lesson.data() || {};
      const lvl = data.levelKey;
      const sub = data.sublevelKey;
      if (!lvl || !sub) continue;

      const key = `${lvl}_${sub}`;
      const roster = Array.from(grouped.get(key) || new Set());

      const weekRef = lesson.ref.collection("attendance").doc(weekMondayYmd);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(weekRef);
        if (!snap.exists) {
          tx.set(
            weekRef,
            {
              weekMondayYmd,
              rosterUserIds: roster,
              attendanceTree: {}, // initialize empty; UI will fill as the week goes on
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: false }
          );
        } else {
          // Only update roster + updatedAt; preserve any existing attendanceTree
          tx.update(weekRef, {
            rosterUserIds: roster,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      });

      writes += 1;
      console.log(`✅ Wrote roster for lesson ${lesson.id} (size=${roster.length})`);
    }

    console.log(`🎉 Completed. Wrote ${writes} lesson rosters for week ${weekMondayYmd}.`);
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();
