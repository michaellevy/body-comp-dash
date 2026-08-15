// IndexedDB local store + GitHub Gist cloud backup

const DB_NAME = 'bodycomp';
const DB_VERSION = 2;
const STORE = 'measurements';
const TAPE_STORE = 'tape';
const GIST_FILE = 'bodycomp.json';
const TAPE_GIST_FILE = 'tape.json';

// ── Gist config (set via settings) ─────────────────────
let GH_TOKEN = localStorage.getItem('gh_token') || '';
let GH_GIST_ID = localStorage.getItem('gh_gist_id') || '';

function gistConfigured() {
    return GH_TOKEN && GH_GIST_ID;
}

function setGist(token, gistId) {
    GH_TOKEN = token;
    GH_GIST_ID = gistId;
    localStorage.setItem('gh_token', token);
    localStorage.setItem('gh_gist_id', gistId);
}

// Height in inches — needed only for the Navy estimate. Defaults to 5'9" so the
// estimate works on a fresh install without a settings trip; editable in Settings.
const DEFAULT_HEIGHT_IN = 69;

function getHeight() {
    const h = parseFloat(localStorage.getItem('height_in'));
    return isNaN(h) ? DEFAULT_HEIGHT_IN : h;
}

function setHeight(inches) {
    localStorage.setItem('height_in', String(inches));
}

// ── IndexedDB ──────────────────────────────────────────
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'date' });
                store.createIndex('date', 'date', { unique: true });
            }
            // v2: tape circumferences live in their own store so that saving a
            // weight-only entry can never overwrite that day's tape data.
            if (!db.objectStoreNames.contains(TAPE_STORE)) {
                db.createObjectStore(TAPE_STORE, { keyPath: 'date' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function localPut(row, storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName || STORE, 'readwrite');
        tx.objectStore(storeName || STORE).put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Merge into an existing row rather than replacing it. Tape sites are recorded
// on different cadences, so two writes can land on the same date — a plain put
// would drop whichever site was written first.
async function localMerge(row, storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const getReq = store.get(row.date);
        getReq.onsuccess = () => {
            const merged = { ...(getReq.result || {}), ...row };
            // Don't let an explicit null clobber a value already on record.
            for (const [k, v] of Object.entries(row)) {
                if (v == null && getReq.result && getReq.result[k] != null) {
                    merged[k] = getReq.result[k];
                }
            }
            store.put(merged);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function localGetAll(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName || STORE, 'readonly');
        const req = tx.objectStore(storeName || STORE).getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => a.date.localeCompare(b.date)));
        req.onerror = () => reject(req.error);
    });
}

async function localGetRecent(n) {
    const all = await localGetAll();
    return all.slice(-n);
}

// ── GitHub Gist sync ───────────────────────────────────
// Whole-file overwrite: each push writes the full local snapshot to the gist
// (bodycomp.json = weights, tape.json = circumferences); each pull reads them
// back and merges into local (cloud wins on date collision). Concurrent
// multi-device writes are not handled — last-writer-wins is acceptable for a
// single user with infrequent entry.

async function gistFetch() {
    if (!gistConfigured()) return { measurements: [], tape: [] };
    const res = await fetch(`https://api.github.com/gists/${GH_GIST_ID}`, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${GH_TOKEN}`,
        },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const gist = await res.json();

    const readFile = async (name) => {
        const file = gist.files[name];
        if (!file) return [];
        const text = file.truncated
            ? await (await fetch(file.raw_url)).text()
            : file.content;
        if (!text || !text.trim()) return [];
        return JSON.parse(text);
    };

    return {
        measurements: await readFile(GIST_FILE),
        tape: await readFile(TAPE_GIST_FILE),
    };
}

async function gistPush() {
    if (!gistConfigured()) return;
    const all = await localGetAll();
    const tape = await localGetAll(TAPE_STORE);
    const body = {
        files: {
            [GIST_FILE]: { content: JSON.stringify(all, null, 2) },
            [TAPE_GIST_FILE]: { content: JSON.stringify(tape, null, 2) },
        },
    };
    const res = await fetch(`https://api.github.com/gists/${GH_GIST_ID}`, {
        method: 'PATCH',
        headers: {
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GH_TOKEN}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

// ── Public API ─────────────────────────────────────────
async function saveMeasurement(dateStr, weight, fatPercent) {
    const row = {
        date: dateStr,
        weight: parseFloat(weight),
        fat_percent: fatPercent != null && fatPercent !== '' ? parseFloat(fatPercent) : null,
    };
    await localPut(row);
    gistPush().catch(e => console.warn('Gist push failed (will retry on next save):', e.message));
}

// values: { waist?, neck?, bicep?, thigh? } — only the sites actually entered.
async function saveTape(dateStr, values) {
    const row = { date: dateStr };
    let any = false;
    for (const [k, v] of Object.entries(values)) {
        if (v == null || v === '') continue;
        const n = parseFloat(v);
        if (isNaN(n)) continue;
        row[k] = n;
        any = true;
    }
    if (!any) return false;
    await localMerge(row, TAPE_STORE);
    gistPush().catch(e => console.warn('Gist push failed (will retry on next save):', e.message));
    return true;
}

// ── One-time data fix: waist series restarts on morning readings ───────────
// The first two waist readings were taken in the evening. Waist girth swings
// more over a single day — meals, hydration, posture — than it moves in a week
// of real change, so mixing an evening reading into a morning series records a
// step that isn't there. Drop them and restart from the first morning value.
//
// The scrub runs on every load rather than once: another device still holding
// the old rows can push them back to the gist, and re-running is free when
// there's nothing to remove. The seed insert is guarded, since it's a real
// write that shouldn't reappear if the row is ever removed on purpose.
const MORNING_CUTOFF = '2026-08-14';
const FIRST_MORNING_WAIST = { date: '2026-08-14', waist: 36.625 };
const SEED_FLAG = 'fix_waist_morning_seeded';

async function stripField(dates, field) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(TAPE_STORE, 'readwrite');
        const store = tx.objectStore(TAPE_STORE);
        for (const date of dates) {
            const getReq = store.get(date);
            getReq.onsuccess = () => {
                const row = getReq.result;
                if (!row) return;
                delete row[field];
                // A row holding only a date is an empty record, not a measurement.
                if (Object.keys(row).length <= 1) store.delete(date);
                else store.put(row);
            };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function applyDataFixes() {
    const rows = await localGetAll(TAPE_STORE);
    const stale = rows.filter(r => r.date < MORNING_CUTOFF && r.waist != null);
    const seed = !localStorage.getItem(SEED_FLAG)
        && !rows.some(r => r.date === FIRST_MORNING_WAIST.date && r.waist != null);

    if (stale.length) await stripField(stale.map(r => r.date), 'waist');
    if (seed) {
        await localMerge({ ...FIRST_MORNING_WAIST }, TAPE_STORE);
        localStorage.setItem(SEED_FLAG, '1');
    }
    if (!stale.length && !seed) return 0;

    gistPush().catch(e => console.warn('Gist push failed (will retry on next save):', e.message));
    return stale.length + (seed ? 1 : 0);
}

async function getAllMeasurements() {
    return await localGetAll();
}

async function getAllTape() {
    return await localGetAll(TAPE_STORE);
}

async function getRecentMeasurements(n) {
    return await localGetRecent(n);
}

async function syncFromCloud() {
    if (!gistConfigured()) return 0;
    const cloud = await gistFetch();
    let count = 0;
    for (const row of cloud.measurements) {
        await localPut(row);
        count++;
    }
    for (const row of cloud.tape) {
        await localMerge(row, TAPE_STORE);
        count++;
    }
    return count;
}

async function syncToCloud() {
    if (!gistConfigured()) return 0;
    await gistPush();
    const all = await localGetAll();
    const tape = await localGetAll(TAPE_STORE);
    return all.length + tape.length;
}

// ── Data import/export ─────────────────────────────────
async function importJSON(jsonArray) {
    let count = 0;
    for (const row of jsonArray) {
        await localPut({
            date: row.date,
            weight: parseFloat(row.weight),
            fat_percent: row.fat_percent != null ? parseFloat(row.fat_percent) : null,
        });
        count++;
    }
    return count;
}

function exportJSON(rows) {
    return JSON.stringify(rows, null, 2);
}

window.db = {
    saveMeasurement, saveTape, getAllMeasurements, getAllTape, getRecentMeasurements,
    syncFromCloud, syncToCloud, importJSON, exportJSON, applyDataFixes,
    gistConfigured, setGist, getHeight, setHeight,
};
