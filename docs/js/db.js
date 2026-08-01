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
    syncFromCloud, syncToCloud, importJSON, exportJSON,
    gistConfigured, setGist, getHeight, setHeight,
};
