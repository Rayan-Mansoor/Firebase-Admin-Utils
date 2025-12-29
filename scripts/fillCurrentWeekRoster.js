// scripts/fillCurrentWeekRoster.js
const { db, FieldValue } = require("../firebaseAdmin");

const TZ = "Europe/Rome";

// ---------- Sublevel Configuration ----------
const SUBLEVEL_LIMITS = {
  absoluteBeginner: 0, // no sublevels
  a1: 4, // S1..S4
  a2: 5, // S1..S5
  b1: 7, // S1..S7
  b2: 9, // S1..S9
  c1: 12, // S1..S12
};

const LEVEL_ORDER = {
  absoluteBeginner: 0,
  a1: 1,
  a2: 2,
  b1: 3,
  b2: 4,
  c1: 5,
};

// ---------- Strict helpers ----------
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertTz(tz) {
  new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
}

function assertLowercaseOrCamelKey(str, fieldName, userId) {
  expect(typeof str === "string", `[fillCurrentWeekRoster] ${fieldName} must be string for user=${userId}`);
  expect(str.length > 0, `[fillCurrentWeekRoster] ${fieldName} empty for user=${userId}`);
  // Allow both lowercase (a1, a2) and camelCase (absoluteBeginner)
  const validFormat = /^[a-z][a-zA-Z0-9]*$/.test(str);
  expect(validFormat, `[fillCurrentWeekRoster] ${fieldName} invalid format (${str}) for user=${userId}`);
}

function assertValidLevel(levelKey, userId) {
  assertLowercaseOrCamelKey(levelKey, "assessedLevel", userId);
  expect(
    Object.prototype.hasOwnProperty.call(SUBLEVEL_LIMITS, levelKey),
    `[fillCurrentWeekRoster] Unknown assessedLevel=${levelKey} for user=${userId}`
  );
}

function assertValidSublevelForLevel(levelKey, sublevelKey, userId) {
  expect(typeof sublevelKey === "string", `[fillCurrentWeekRoster] assessedSublevel must be string for user=${userId}`);
  expect(sublevelKey.length > 0, `[fillCurrentWeekRoster] assessedSublevel empty for user=${userId}`);

  const limit = SUBLEVEL_LIMITS[levelKey];
  expect(limit !== undefined, `[fillCurrentWeekRoster] SUBLEVEL_LIMITS missing for level=${levelKey} user=${userId}`);
  expect(limit > 0, `[fillCurrentWeekRoster] Level ${levelKey} should not have sublevels (got ${sublevelKey}) user=${userId}`);

  const m = /^s([1-9]\d*)$/i.exec(sublevelKey);
  expect(!!m, `[fillCurrentWeekRoster] Invalid assessedSublevel format=${sublevelKey} user=${userId}`);

  const n = Number(m[1]);
  expect(n >= 1 && n <= limit, `[fillCurrentWeekRoster] Sublevel out of range: ${levelKey}_${sublevelKey} user=${userId}`);
  return n;
}

function assertPositiveInt(n, fieldName, userId) {
  expect(typeof n === "number" && Number.isFinite(n), `[fillCurrentWeekRoster] ${fieldName} must be number for user=${userId}`);
  expect(Number.isInteger(n), `[fillCurrentWeekRoster] ${fieldName} must be integer (got ${n}) for user=${userId}`);
  expect(n > 0, `[fillCurrentWeekRoster] ${fieldName} must be > 0 (got ${n}) for user=${userId}`);
}

function assertYmd(ymd, fieldName, userId) {
  expect(typeof ymd === "string", `[fillCurrentWeekRoster] ${fieldName} must be string for user=${userId}`);
  expect(/^(\d{4})-(\d{2})-(\d{2})$/.test(ymd), `[fillCurrentWeekRoster] ${fieldName} invalid format=${ymd} user=${userId}`);
}

function getLevelOrderStrict(levelKey) {
  const order = LEVEL_ORDER[levelKey];
  expect(order !== undefined, `[fillCurrentWeekRoster] LEVEL_ORDER missing for level=${levelKey}`);
  return order;
}

// ---------- Time helpers (Absolute Neutral Logic) ----------
function getNormalizedToday(tz = TZ) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const d = Number(parts.find((p) => p.type === "day")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const y = Number(parts.find((p) => p.type === "year")?.value);

  expect(!!y && !!m && !!d, `[fillCurrentWeekRoster] Failed to extract Y/M/D in tz=${tz}`);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

function parseYmdToUtcMidnight(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  expect(!!m, `[fillCurrentWeekRoster] Invalid YMD=${ymd}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  expect(!!y && !!mo && !!d, `[fillCurrentWeekRoster] Invalid YMD parts=${ymd}`);
  return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0));
}

function mondayOfIsoWeek(normalizedDate) {
  const day = normalizedDate.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;

  const monday = new Date(normalizedDate);
  monday.setUTCDate(normalizedDate.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

function ymdFromUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function weeksBetweenIsoWeeks(startMonday, endMonday) {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  return Math.trunc((endMonday.getTime() - startMonday.getTime()) / weekMs);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function programStartMondayFromArrivalYmd(arrivalYmd) {
  const arr = parseYmdToUtcMidnight(arrivalYmd);
  const weekMon = mondayOfIsoWeek(arr);
  const isMonday = arr.getUTCDay() === 1;
  return isMonday ? weekMon : addDays(weekMon, 7);
}

// ---------- Main Execution ----------
(async () => {
  try {
    assertTz(TZ);

    const todayNormalized = getNormalizedToday(TZ);
    const weekMonday = mondayOfIsoWeek(todayNormalized);
    const weekMondayYmd = ymdFromUtc(weekMonday);

    console.log(`📅 Current ISO week Monday (for ${TZ}) = ${weekMondayYmd}`);

    const usersSnap = await db.collection("users").get();
    console.log(`👥 Users fetched: ${usersSnap.size}`);

    const grouped = new Map(); // key -> Set<uid>
    let activeUserCount = 0;

    let skippedInactiveNoArrivalInfo = 0;
    let skippedInactiveNoAssessment = 0;

    for (const uDoc of usersSnap.docs) {
      const userId = uDoc.id;
      const u = uDoc.data();
      expect(!!u, `[fillCurrentWeekRoster] Missing user doc data user=${userId}`);

      // Inactive if no arrivalInfo
      const arrival = u.arrivalInfo;
      if (!arrival) {
        skippedInactiveNoArrivalInfo++;
        continue;
      }

      // Inactive if no basicInfo
      const basic = u.basicInfo;
      // Inactive if missing assessment fields (level/sublevel)
      const levelKey = basic.assessedLevel;
      const subKey = basic.assessedSublevel;
      if (!levelKey || !subKey) {
        skippedInactiveNoAssessment++;
        continue;
      }

      // From here onward => strict validation
      assertValidLevel(levelKey, userId);
      const sublevelNumber = assertValidSublevelForLevel(levelKey, subKey, userId);

      const arrivalDate = arrival.arrivalDate;
      assertYmd(arrivalDate, "arrivalDate", userId);

      const totalWeeks = arrival.noOfWeeks;
      assertPositiveInt(totalWeeks, "noOfWeeks", userId);

      const programStartMonday = programStartMondayFromArrivalYmd(arrivalDate);
      const weeksSinceStart = weeksBetweenIsoWeeks(programStartMonday, weekMonday);

      if (weeksSinceStart < 0) continue;
      if (weeksSinceStart >= totalWeeks) continue;

      const key = `${levelKey}_${subKey}`;
      if (!grouped.has(key)) grouped.set(key, new Set());
      grouped.get(key).add(userId);
      activeUserCount++;

      void sublevelNumber;
    }

    console.log(`🚫 Skipped inactive (missing arrivalInfo): ${skippedInactiveNoArrivalInfo}`);
    console.log(`🚫 Skipped inactive (missing assessedLevel/assessedSublevel): ${skippedInactiveNoAssessment}`);

    console.log(`✨ Active students (in-week): ${activeUserCount}`);
    console.log(`📊 Active students grouped by level/sublevel:`);
    for (const [key, uids] of grouped.entries()) {
      console.log(`   ${key}: ${uids.size} students`);
    }

    // ---- Ensure weekly_lessons docs exist + are consistent (STRICT) ----
    for (const key of grouped.keys()) {
      const [levelKey, sublevelKey] = key.split("_");
      expect(!!levelKey && !!sublevelKey, `[fillCurrentWeekRoster] Invalid lesson key=${key}`);

      assertValidLevel(levelKey, "weekly_lessons");
      const sublevelNumber = assertValidSublevelForLevel(levelKey, sublevelKey, "weekly_lessons");
      const levelOrder = getLevelOrderStrict(levelKey);

      const lessonRef = db.collection("weekly_lessons").doc(key);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(lessonRef);

        if (!snap.exists) {
          console.log(`🆕 Creating weekly_lessons document for ${key}...`);
          tx.set(lessonRef, {
            levelKey,
            sublevelKey,
            levelOrder,
            sublevelNumber,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return;
        }

        const data = snap.data() || {};
        expect(data.levelKey === levelKey, `[fillCurrentWeekRoster] weekly_lessons/${key} levelKey mismatch (${data.levelKey} != ${levelKey})`);
        expect(data.sublevelKey === sublevelKey, `[fillCurrentWeekRoster] weekly_lessons/${key} sublevelKey mismatch (${data.sublevelKey} != ${sublevelKey})`);
        expect(data.levelOrder === levelOrder, `[fillCurrentWeekRoster] weekly_lessons/${key} levelOrder mismatch (${data.levelOrder} != ${levelOrder})`);
        expect(
          data.sublevelNumber === sublevelNumber,
          `[fillCurrentWeekRoster] weekly_lessons/${key} sublevelNumber mismatch (${data.sublevelNumber} != ${sublevelNumber})`
        );

        tx.update(lessonRef, { updatedAt: FieldValue.serverTimestamp() });
      });
    }

    // ---- Update current week roster ----
    let writes = 0;

    for (const [key, uids] of grouped.entries()) {
      const roster = Array.from(uids).sort();
      const lessonRef = db.collection("weekly_lessons").doc(key);
      const weekRef = lessonRef.collection("attendance").doc(weekMondayYmd);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(weekRef);

        if (!snap.exists) {
          tx.set(weekRef, {
            weekMondayYmd,
            rosterUserIds: roster,
            attendanceTree: {},
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(weekRef, {
            rosterUserIds: roster,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      });

      writes += 1;
      console.log(`✅ Updated: ${key} (roster=${roster.length})`);
    }

    console.log(`🎉 Completed. Wrote ${writes} rosters for week ${weekMondayYmd}.`);
  } catch (e) {
    console.error("❌ Error:", e?.stack || e?.message || String(e));
    process.exit(1);
  } finally {
    process.exit(0);
  }
})();