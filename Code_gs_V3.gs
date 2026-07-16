/**
 * ============================================================
 * Algo Tracker — Google Sheet two-way sync backend
 * ============================================================
 *
 * WHAT THIS DOES
 * The Algo Tracker web app keeps its data in the browser's
 * localStorage. This script turns a Google Sheet into a real
 * backing store with four tables (tabs):
 *   - "DSA", "LLD", "HLD"  one row per problem you're tracking,
 *                          split into its own tab per track, each
 *                          including a `revisionCount` column —
 *                          the number of times you've hit
 *                          "Nailed It" / "Struggled" on that problem
 *   - "Revision_log"       one row per individual revision event
 *                          (append-only history, across all tracks)
 *
 * The app POSTs its local data here on every change (debounced)
 * and on a timer. This script merges it with whatever is already
 * in the Sheet — last-write-wins per problem, based on an
 * `updatedAt` timestamp — and sends the merged result back, which
 * the app then adopts as its new local truth. That round trip is
 * what makes it "two-way": edits made directly in the Sheet, or
 * from a different device/browser, flow back into the app too.
 *
 * ------------------------------------------------------------
 * SETUP
 * ------------------------------------------------------------
 * 1. Create a new Google Sheet (or open an existing one you want
 *    to use as the database). Any tab layout is fine — this
 *    script creates/manages its own "DSA", "LLD", "HLD" and
 *    "Revision_log" tabs automatically.
 * 2. Extensions > Apps Script. Delete any boilerplate code and
 *    paste this entire file in as Code.gs.
 * 3. (Optional but recommended) Set SHARED_SECRET below to any
 *    password string. Put the same value into the app's Sync
 *    Settings modal ("Shared Secret" field) so random people
 *    can't write to your sheet even if they guess the URL.
 * 4. Click Deploy > New deployment.
 *      - Select type: "Web app"
 *      - Description: anything, e.g. "Algo Tracker sync"
 *      - Execute as: Me
 *      - Who has access: "Anyone" (needed so the browser app can
 *        reach it without a Google login prompt; your SHARED_SECRET
 *        is what actually protects it)
 *    Click Deploy, authorize the requested permissions, then copy
 *    the "Web app URL" — it looks like:
 *      https://script.google.com/macros/s/AKfycb.../exec
 * 5. Paste that URL into the app's Sync Settings modal (the
 *    refresh icon in the header) and hit "Sync Now".
 * 6. Whenever you edit this script and re-deploy, choose
 *    "Manage deployments" > pencil icon > "New version" so the
 *    existing /exec URL picks up your changes (a brand new
 *    deployment would otherwise generate a different URL).
 *
 * You can also run `setupSheets()` once from the Apps Script
 * editor (pick it from the function dropdown, click ▶ Run) to
 * pre-create all four tabs with headers, though the web app will
 * create them automatically on first request too.
 * ============================================================
 */

// ---- Configuration -----------------------------------------
const SHARED_SECRET = ''; // e.g. 'my-secret-123' — leave '' to disable the check

// Problems are split into one tab per track, instead of a single "Problems" tab.
const TRACKS = ['DSA', 'LLD', 'HLD'];
const TRACK_SHEET_NAMES = { DSA: 'DSA', LLD: 'LLD', HLD: 'HLD' };
const REVISION_SHEET_NAME = 'Revision_log';

const PROBLEM_COLUMNS = [
  'id', 'title', 'link', 'track', 'difficulty', 'category', 'company', 'notes',
  'description', 'intervalIndex', 'intervalDays', 'createdAt', 'lastRevised',
  'nextReview', 'revisionHistory', 'revisionCount', 'lastTimeMinutes', 'updatedAt', 'deletedAt'
];

const REVISION_COLUMNS = ['log_id', 'problem_id', 'date', 'outcome', 'minutes', 'timestamp'];

function trackSheetName(track) {
  return TRACK_SHEET_NAMES[track] || TRACK_SHEET_NAMES.DSA;
}

// ---- Web app entry points ------------------------------------
function doGet(e) {
  return jsonResponse({ ok: true, message: 'Algo Tracker sync API is running. This endpoint expects POST requests.' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // avoid two simultaneous syncs corrupting the sheet
  } catch (lockErr) {
    return jsonResponse({ ok: false, error: 'Server busy, please retry.' });
  }

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (SHARED_SECRET && (body.secret || '') !== SHARED_SECRET) {
      return jsonResponse({ ok: false, error: 'Unauthorized: shared secret does not match.' });
    }

    const action = body.action || 'sync';

    if (action === 'pull') {
      return jsonResponse({
        ok: true,
        problems: readAllProblems().filter(p => !p.deletedAt),
        revisionLog: readRevisionLog(),
      });
    }

    if (action === 'sync') {
      const merged = mergeSync(body.problems || [], body.revisionLog || [], body.deletedIds || []);
      return jsonResponse({
        ok: true,
        problems: merged.problems,
        revisionLog: merged.revisionLog,
        deletedIds: merged.deletedIds, // every id ever deleted (app or Sheet) — lets any client drop stale copies
        syncedAt: Date.now(),
      });
    }

    return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

// ---- Core merge logic ------------------------------------------
function mergeSync(incomingProblems, incomingRevisionLog, deletedIds) {
  const props = PropertiesService.getScriptProperties();

  // Read the current state of all three track sheets (active rows only —
  // deleted problems are never written here, see below).
  const existing = readAllProblemsRaw(); // id -> problem object

  // ---- Tombstones: the permanent memory of "this id is deleted" ----
  // We used to mark deletions by leaving the row in the Sheet with a
  // deletedAt cell filled in. That's why deleted problems kept showing up
  // in the Sheet — the row was never actually removed. Now we track deleted
  // ids separately in Script Properties, and simply never write their rows
  // at all, so a deletion in the app makes the row disappear from the
  // Sheet on the very next sync.
  const tombstonesRaw = props.getProperty('TOMBSTONES');
  const tombstones = new Set(tombstonesRaw ? JSON.parse(tombstonesRaw) : []);

  // Migrate any leftover rows from the old scheme, where a "deleted" row was
  // kept in the Sheet with its deletedAt cell filled in instead of being
  // removed. Fold those into the tombstone set now so they get purged below.
  Object.keys(existing).forEach(function (id) {
    if (existing[id].deletedAt) tombstones.add(id);
  });

  // ---- Detect rows deleted directly in the Sheet (not through the app) ----
  // We remember every id that was visible in the sheet as of the last sync.
  // If one of those ids is missing now and isn't already a known tombstone,
  // someone deleted that row by hand in Sheets — tombstone it too, so it
  // propagates to every client instead of getting silently recreated.
  const knownIdsRaw = props.getProperty('KNOWN_IDS');
  const knownIds = knownIdsRaw ? JSON.parse(knownIdsRaw) : null;
  const currentSheetIds = Object.keys(existing);
  if (knownIds) {
    knownIds.forEach(function (id) {
      if (currentSheetIds.indexOf(id) === -1) tombstones.add(id);
    });
  }

  // 1) Client-side deletions (from the app's delete button) become tombstones.
  (deletedIds || []).forEach(function (id) { tombstones.add(id); });

  // Make sure no tombstoned id lingers in `existing` (e.g. a leftover row
  // from before this fix, or a manual-delete just detected above).
  tombstones.forEach(function (id) { delete existing[id]; });

  // 2) Merge incoming problems using last-write-wins on updatedAt.
  //    A track change on an incoming problem simply means it will be written
  //    to a different sheet below — writeAllProblemsSheets() rewrites every
  //    track sheet fully each time, so it naturally "moves" the row.
  (incomingProblems || []).forEach(function (incoming) {
    if (!incoming || !incoming.id) return;
    // Deleted — by this client, another client, or by hand in the Sheet.
    // Don't let a stale local copy bring it back.
    if (tombstones.has(incoming.id)) return;

    const current = existing[incoming.id];
    const incomingUpdated = Number(incoming.updatedAt) || 0;

    if (!current) {
      existing[incoming.id] = normalizeProblem(incoming);
      return;
    }

    const currentUpdated = Number(current.updatedAt) || 0;
    if (incomingUpdated >= currentUpdated) {
      existing[incoming.id] = normalizeProblem(incoming);
    }
    // else: sheet's version is newer — keep it, client will receive it back.
  });

  writeAllProblemsSheets(existing);

  // Persist the updated tombstone list and the ids now visible in the Sheet,
  // for next time's comparisons.
  props.setProperty('TOMBSTONES', JSON.stringify(Array.from(tombstones)));
  props.setProperty('KNOWN_IDS', JSON.stringify(Object.keys(existing)));

  // 3) Revision log is append-only — dedupe by log_id.
  const revSheet = getOrCreateSheet(REVISION_SHEET_NAME, REVISION_COLUMNS);
  const existingLog = readRevisionLogRaw(revSheet);
  const existingIds = {};
  existingLog.forEach(function (r) { existingIds[r.log_id] = true; });

  const newEntries = (incomingRevisionLog || []).filter(function (r) {
    return r && r.log_id && !existingIds[r.log_id];
  });
  if (newEntries.length) {
    appendRevisionLog(revSheet, newEntries);
  }

  return {
    problems: Object.keys(existing).map(function (id) { return existing[id]; }),
    revisionLog: readRevisionLog(),
    deletedIds: Array.from(tombstones),
  };
}

function normalizeProblem(p) {
  const out = {};
  PROBLEM_COLUMNS.forEach(function (col) {
    out[col] = (p[col] === undefined || p[col] === null) ? '' : p[col];
  });
  // revisionHistory arrives as an array from the client; store as JSON string, always read back as array.
  out.revisionHistory = Array.isArray(p.revisionHistory) ? p.revisionHistory : (p.revisionHistory ? p.revisionHistory : []);
  out.revisionCount = Number(p.revisionCount) || 0;
  out.track = TRACKS.indexOf(p.track) !== -1 ? p.track : 'DSA';
  if (!out.updatedAt) out.updatedAt = Date.now();
  return out;
}

// ---- Sheet helpers ----------------------------------------------
function getOrCreateSheet(name, columns) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getTrackSheet(track) {
  return getOrCreateSheet(trackSheetName(track), PROBLEM_COLUMNS);
}

// Reads one track sheet into { id: problemObject }, INCLUDING soft-deleted tombstones.
function readProblemsRawFromSheet(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || PROBLEM_COLUMNS;
  const result = {};
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row[0]) continue; // skip blank rows
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    obj.revisionHistory = safeParseArray(obj.revisionHistory);
    obj.revisionCount = Number(obj.revisionCount) || 0;
    result[obj.id] = obj;
  }
  return result;
}

// Combines DSA + LLD + HLD sheets into one { id: obj } map.
function readAllProblemsRaw() {
  let combined = {};
  TRACKS.forEach(function (track) {
    const sheet = getTrackSheet(track);
    const rows = readProblemsRawFromSheet(sheet);
    combined = Object.assign(combined, rows);
  });
  return combined;
}

// Public read used by action=pull.
function readAllProblems() {
  const map = readAllProblemsRaw();
  return Object.keys(map).map(function (id) { return map[id]; });
}

// Rewrites all three track sheets from a combined { id: obj } map, routing
// each problem to the sheet matching its (possibly just-updated) track.
function writeAllProblemsSheets(map) {
  const byTrack = { DSA: {}, LLD: {}, HLD: {} };
  Object.keys(map).forEach(function (id) {
    const obj = map[id];
    const track = TRACKS.indexOf(obj.track) !== -1 ? obj.track : 'DSA';
    byTrack[track][id] = obj;
  });
  TRACKS.forEach(function (track) {
    const sheet = getTrackSheet(track);
    writeProblemsSheet(sheet, byTrack[track]);
  });
}

function writeProblemsSheet(sheet, map) {
  // Self-heal the header row to the current schema every time we write.
  // Without this, a sheet created by an older version of this script (e.g.
  // one without a "revisionCount" column) would keep stale headers forever,
  // causing reads/writes to silently drift out of alignment.
  sheet.getRange(1, 1, 1, PROBLEM_COLUMNS.length).setValues([PROBLEM_COLUMNS]);
  sheet.setFrozenRows(1);

  const rows = Object.keys(map).map(function (id) {
    const obj = map[id];
    return PROBLEM_COLUMNS.map(function (col) {
      if (col === 'revisionHistory') return JSON.stringify(obj.revisionHistory || []);
      return (obj[col] === undefined || obj[col] === null) ? '' : obj[col];
    });
  });

  // Clear existing data rows (keep header) then write fresh.
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, PROBLEM_COLUMNS.length).clearContent();
  }
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, PROBLEM_COLUMNS.length).setValues(rows);
  }
}

function readRevisionLogRaw(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || REVISION_COLUMNS;
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row[0]) continue;
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    out.push(obj);
  }
  return out;
}

function readRevisionLog() {
  const sheet = getOrCreateSheet(REVISION_SHEET_NAME, REVISION_COLUMNS);
  return readRevisionLogRaw(sheet);
}

function appendRevisionLog(sheet, entries) {
  const rows = entries.map(function (e) {
    return REVISION_COLUMNS.map(function (col) {
      return (e[col] === undefined || e[col] === null) ? '' : e[col];
    });
  });
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, REVISION_COLUMNS.length).setValues(rows);
}

// ---- Small utils -------------------------------------------------
function nowISO() {
  const d = new Date();
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

function safeParseArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.trim().startsWith('[')) {
    try { return JSON.parse(val); } catch (e) { return []; }
  }
  return [];
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- One-time manual setup (optional) -----------------------------
function setupSheets() {
  TRACKS.forEach(function (track) { getTrackSheet(track); });
  getOrCreateSheet(REVISION_SHEET_NAME, REVISION_COLUMNS);
  Logger.log('DSA, LLD, HLD and Revision_log sheets are ready.');
}
