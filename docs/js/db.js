// IndexedDB local store + Supabase cloud backup

const DB_NAME = 'bodycomp';
const DB_VERSION = 1;
const STORE = 'measurements';

// ── Supabase config (set via settings) ─────────────────
let SUPA_URL = localStorage.getItem('supa_url') || '';
let SUPA_KEY = localStorage.getItem('supa_key') || '';

function supaConfigured() {
    return SUPA_URL && SUPA_KEY;
}

function setSupa(url, key) {
    SUPA_URL = url;
    SUPA_KEY = key;
    localStorage.setItem('supa_url', url);
    localStorage.setItem('supa_key', key);
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

// ── Supabase sync ──────────────────────────────────────
async function supaUpsert(row) {
    if (!supaConfigured()) return;
    try {
        await fetch(`${SUPA_URL}/rest/v1/measurements`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPA_KEY,
                'Authorization': `Bearer ${SUPA_KEY}`,
                'Prefer': 'resolution=merge-duplicates',
            },
            body: JSON.stringify({
                date: row.date,
                weight: row.weight,
                fat_percent: row.fat_percent,
            }),
        });
    } catch (e) {
        console.warn('Supabase upsert failed (will retry on next sync):', e.message);
    }
}

async function supaFetchAll() {
    if (!supaConfigured()) return [];
    try {
        const res = await fetch(
            `${SUPA_URL}/rest/v1/measurements?select=date,weight,fat_percent&order=date`,
            {
                headers: {
                    'apikey': SUPA_KEY,
                    'Authorization': `Bearer ${SUPA_KEY}`,
                },
            }
        );
        if (!res.ok) throw new Error(res.statusText);
        return await res.json();
    } catch (e) {
        console.warn('Supabase fetch failed:', e.message);
        return [];
    }
}

// ── Public API ─────────────────────────────────────────
async function saveMeasurement(dateStr, weight, fatPercent) {
    const row = {
        date: dateStr,
        weight: parseFloat(weight),
        fat_percent: fatPercent != null && fatPercent !== '' ? parseFloat(fatPercent) : null,
    };
    await localPut(row);
    supaUpsert(row); // fire-and-forget
}

async function getAllMeasurements() {
    return await localGetAll();
}

async function getRecentMeasurements(n) {
    return await localGetRecent(n);
}

async function syncFromCloud() {
    // Pull all cloud data into local DB (cloud wins on conflict)
    if (!supaConfigured()) return 0;
    const cloud = await supaFetchAll();
    let count = 0;
    for (const row of cloud) {
        await localPut(row);
        count++;
    }
    return count;
}

async function syncToCloud() {
    // Push all local data to cloud
    if (!supaConfigured()) return 0;
    const local = await localGetAll();
    let count = 0;
    for (const row of local) {
        await supaUpsert(row);
        count++;
    }
    return count;
}

// ── Data import ────────────────────────────────────────
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
    supaConfigured, setSupa,
};
