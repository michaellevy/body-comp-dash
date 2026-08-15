// Tape measurements — site definitions, due logic, Navy fat% estimate.
//
// Cadence rationale: waist is the only site precise enough to resolve change
// week to week. Bicep and thigh move a few mm per YEAR of real hypertrophy,
// which is smaller than session-to-session tape error — measuring them weekly
// would record noise, so they're monthly. Neck is monthly because it drifts
// slowly with weight; a one-time value would go stale.

// Cues are deliberately specific — a named landmark and a fixed side. Vague
// instructions ("mid-thigh") are the main source of tape error, and error at
// these sites is already close to the size of the signal.
// Time of day is not a detail here: waist swings more across a single day than
// it moves in a week of real change, so a reading taken at a different hour
// isn't comparable to the rest of the series. Morning, with the weigh-in.
const SHARED_CUE = 'Morning, right after the weigh-in and before eating. Tape snug but not compressing the skin.';

const TAPE_SITES = [
    { key: 'waist', label: 'Waist', intervalDays: 7,
      cue: 'Level with your navel, standing relaxed. Measure at the end of a normal exhale — don’t suck in or push out.' },
    { key: 'neck',  label: 'Neck',  intervalDays: 30,
      cue: 'Just below the Adam’s apple, tape sloping slightly downward at the front. Shoulders relaxed.' },
    { key: 'bicep', label: 'Bicep', intervalDays: 30,
      cue: 'Right arm, hanging relaxed at your side — not flexed. Halfway between shoulder bone and elbow.' },
    { key: 'thigh', label: 'Thigh', intervalDays: 30,
      cue: 'Right leg, 6 in above the top of the kneecap. Stand with weight even on both feet.' },
];

const DAY_MS = 86400000;

// Dates are calendar days in the user's own timezone, never UTC instants.
// toISOString() would roll over at 6pm local in MDT, filing an evening weigh-in
// under tomorrow and making sites come due a day early.
function localDateStr(d) {
    const dt = d || new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function todayStr() {
    return localDateStr();
}

function daysBetween(fromStr, toStr) {
    return Math.round((new Date(toStr + 'T00:00:00') - new Date(fromStr + 'T00:00:00')) / DAY_MS);
}

// Most recent row carrying a non-null value for `key`, or null if never recorded.
function lastRecorded(rows, key) {
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][key] != null) return rows[i];
    }
    return null;
}

// Days until a site comes due; <= 0 means due now, and never-measured is due.
function daysUntilDue(tapeRows, site, asOf) {
    const last = lastRecorded(tapeRows, site.key);
    if (!last) return 0;
    return site.intervalDays - daysBetween(last.date, asOf || todayStr());
}

// Which sites are due as of `asOf`. A site stays due until it's actually
// recorded — dueness is derived from the last recorded date, never from a
// dismissable flag, so the prompt can't be lost by reloading or ignoring it.
function dueSites(tapeRows, asOf) {
    return TAPE_SITES.filter(site => daysUntilDue(tapeRows, site, asOf) <= 0);
}

// The complement — sites measured recently enough that they aren't prompted
// for. They're still reachable on demand: the cadences are a floor on useful
// signal, not a lock, and an extra reading is never worse than no reading.
function restingSites(tapeRows, asOf) {
    return TAPE_SITES.filter(site => daysUntilDue(tapeRows, site, asOf) > 0);
}

// ── Navy body fat estimate (male formula, inches) ─────────────────────────────
// %BF = 86.010·log10(waist − neck) − 70.041·log10(height) + 36.76
//
// This overestimates fat in lean, muscular men — a thick abdominal wall reads
// as girth the formula attributes to fat. Treat it as a repeatable INDEX whose
// slope is meaningful, not as a competitor to the hydrostatic number.
function navyFatPercent(waist, neck, heightIn) {
    if (waist == null || neck == null || !heightIn) return null;
    if (waist <= neck) return null;
    return 86.010 * Math.log10(waist - neck)
         - 70.041 * Math.log10(heightIn)
         + 36.76;
}

// Pair each waist reading with the most recent neck on or before that date.
// Neck is measured monthly and drifts slowly, so carrying it forward is fair.
function navySeries(tapeRows, heightIn) {
    if (!heightIn) return [];
    const out = [];
    let neck = null;
    for (const row of tapeRows) {
        if (row.neck != null) neck = row.neck;
        if (row.waist == null || neck == null) continue;
        const pct = navyFatPercent(row.waist, neck, heightIn);
        if (pct != null) out.push({ date: row.date, fat_percent: pct });
    }
    return out;
}

window.tape = { TAPE_SITES, SHARED_CUE, dueSites, restingSites, daysUntilDue,
                lastRecorded, navyFatPercent, navySeries, todayStr, localDateStr,
                daysBetween };
