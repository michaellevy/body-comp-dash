// IndexedDB local store + GitHub Gist cloud backup

const DB_NAME = 'bodycomp';
const DB_VERSION = 1;
const STORE = 'measurements';
const GIST_FILE = 'bodycomp.json';

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
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function localPut(row) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function localGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => a.date.localeCompare(b.date)));
        req.onerror = () => reject(req.error);
    });
}

async function localGetRecent(n) {
    const all = await localGetAll();
    return all.slice(-n);
}

// ── GitHub Gist sync ───────────────────────────────────
// Whole-file overwrite: each push writes the full local snapshot to one
// file in one gist; each pull reads that file and merges into local (cloud
// wins on date collision). Concurrent multi-device writes are not handled
// — last-writer-wins is acceptable for a single user with infrequent entry.

async function gistFetch() {
    if (!gistConfigured()) return [];
    const res = await fetch(`https://api.github.com/gists/${GH_GIST_ID}`, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${GH_TOKEN}`,
        },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const gist = await res.json();
    const file = gist.files[GIST_FILE];
    if (!file) return [];
    const text = file.truncated
        ? await (await fetch(file.raw_url)).text()
        : file.content;
    if (!text || !text.trim()) return [];
    return JSON.parse(text);
}

async function gistPush() {
    if (!gistConfigured()) return;
    const all = await localGetAll();
    const body = {
        files: { [GIST_FILE]: { content: JSON.stringify(all, null, 2) } },
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

async function getAllMeasurements() {
    return await localGetAll();
}

async function getRecentMeasurements(n) {
    return await localGetRecent(n);
}

async function syncFromCloud() {
    if (!gistConfigured()) return 0;
    const cloud = await gistFetch();
    let count = 0;
    for (const row of cloud) {
        await localPut(row);
        count++;
    }
    return count;
}

async function syncToCloud() {
    if (!gistConfigured()) return 0;
    await gistPush();
    const all = await localGetAll();
    return all.length;
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
    saveMeasurement, getAllMeasurements, getRecentMeasurements,
    syncFromCloud, syncToCloud, importJSON, exportJSON,
    gistConfigured, setGist,
};
