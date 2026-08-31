// Chart builders using Plotly.js — ported from charts.py

const FONT = { family: 'Inter, -apple-system, sans-serif', color: '#1f2937', size: 12 };
const AXIS = { showgrid: false, zeroline: false, linecolor: '#e5e7eb', linewidth: 1 };

// A factory, not a shared constant. Plotly writes state back into the layout
// object it's handed — a zoom lands as `range`/`autorange` on the axis object
// itself — so a shallow `{...BASE_LAYOUT}` would have every chart sharing one
// xaxis, and a date range set on the weight chart would turn up on the path
// chart's muscle axis. Each call gets its own axes.
function baseLayout() {
    return {
        template: 'plotly_white',
        paper_bgcolor: 'white', plot_bgcolor: 'white',
        font: FONT,
        xaxis: { ...AXIS },
        yaxis: { ...AXIS },
        margin: { l: 48, r: 16, t: 8, b: 28 },
        showlegend: false,
    };
}
// Reversed Viridis — darker (purple) = higher fat%
const VIRIDIS_R = [
    [0, '#fde725'], [0.1, '#b5de2b'], [0.2, '#6ece58'],
    [0.3, '#35b779'], [0.4, '#1f9e89'], [0.5, '#26828e'],
    [0.6, '#31688e'], [0.7, '#3e4989'], [0.8, '#482878'],
    [0.9, '#440154'], [1, '#440154'],
];
const HOVERLABEL = { bgcolor: 'white', font: { size: 12, family: FONT.family } };
const CFG = { displayModeBar: false, responsive: true };

// ── Smoothing: kernel regression with density-adaptive bandwidth ──
// Weights the ACTUAL observations on a daily output grid. The previous version
// interpolated to daily first and smoothed that, which let a long gap between
// readings manufacture synthetic points that pulled the average.
//
// The bandwidth follows how often you've been measuring. Sigma is derived from
// the local spacing between readings, so daily weigh-ins get a tight kernel
// that resolves a real trend in ~2 weeks, while a sparse stretch widens it so
// the line doesn't chase individual readings. It's computed PER OUTPUT DAY, so
// a sparse history followed by daily weighing gets a wide kernel over the old
// data and a tight one over the recent data — not one compromise for both.
const SIGMA_MIN = 6;     // days — daily weighing; tighter than this tracks noise
const SIGMA_MAX = 28;    // days — very sparse; beyond this the line goes rigid
const SIGMA_SPAN = 6;    // sigma spans about this many typical gaps
const NEIGHBORS = 10;    // readings used to estimate local spacing
const SIGMA_BLEND = 21;  // days — sigma is itself smoothed over this half-width

// ── Confidence band ───────────────────────────────────────────────────────
// The band answers the only question the trend line is actually being asked:
// is today's line genuinely below last month's, or is that the noise talking?
//
// At each output day the fit is a weighted mean of nearby readings, so its
// standard error is the usual sigma/sqrt(n) with the kernel weights supplying
// both terms: n_eff = (Σw)²/Σw², and sigma² estimated from the SAME kernel
// applied to squared residuals (leverage-corrected — see pass 2). That makes
// the band widen exactly where it should — sparse stretches, noisy stretches,
// and the two ends of the series, where half the kernel hangs off the edge of
// the data.
//
// It is a band on the TREND, not on tomorrow's reading: it says where the
// underlying level sits, and individual readings are expected to fall outside
// it. It also can't see smoothing bias, so it understates the uncertainty
// wherever the true curve turns sharply relative to the bandwidth.
const Z95 = 1.959964;

// sigma is estimated, not known, so the multiplier is a t quantile and not z.
// The difference is the whole ballgame on a sparse series: weekly tape readings
// put only ~7 readings' worth of weight under the kernel, where t is 2.45 and
// using 1.96 costs about five points of coverage. Cornish-Fisher expansion of
// t_.975 in 1/df — within 0.001 of exact by df = 6, and df is floored at 3
// because the series where it would go lower has no trend worth banding.
function t95(df) {
    const v = Math.max(3, df), z = Z95, z3 = z * z * z, z5 = z3 * z * z, z7 = z5 * z * z;
    return z
        + (z3 + z) / (4 * v)
        + (5 * z5 + 16 * z3 + 3 * z) / (96 * v * v)
        + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * v * v * v);
}

// Readings a day or two apart are not independent. Water, glycogen and gut
// content persist across days, so a high reading is usually followed by another
// high one; treating them as independent reports a band far tighter than the
// data supports — a factor of 2 at p = 0.6. The variance is inflated by the
// AR(1) effective-sample-size factor (1+p^h)/(1-p^h), evaluated at the LOCAL
// spacing h. Using p^h rather than p makes the correction self-limiting:
// readings a month apart get p^30 ≈ 0 and no inflation at all, so a sparse era
// is never penalised for a dense era's stickiness.
//
// p and the noise level both come from a VARIOGRAM on the raw readings, not
// from the fit's residuals. Residuals are the wrong instrument here, because
// the smoother absorbs exactly the low-frequency wiggle that autocorrelation
// creates: they recover p = 0.42 and sigma = 0.84 from a series built with
// p = 0.6 and sigma = 1.0, and the two errors compound into 82% coverage.
//
// The variogram is fitted with a NUGGET, which is what the measurements
// actually look like:
//
//     gamma(d) = nugget + sill·(1 - p^d)
//
// The nugget is per-session error — tape placement, scale variation, standing
// a little differently — which is independent every time and averages away
// like ordinary noise. The sill is the part that persists: water, glycogen,
// gut content, which are genuinely the same tomorrow as today and do NOT
// average away no matter how often you measure inside their memory. Only the
// sill gets the AR(1) inflation; the nugget is divided by n_eff as usual.
//
// Fitting the two as one AR(1) instead gets both badly wrong. On a waist
// series that is half tape error and half physiology with p = 0.7, the
// two-parameter fit reports p = 0.24 AND understates total variance by 26%,
// for 75% coverage on daily readings — worse than doing nothing.
//
// Trend leaks into gamma as (slope·d)²/2, growing quadratically, so only short
// lags are usable. The 12-day cap keeps that under a fifth of a typical waist
// variance, and what does leak biases the band wider rather than narrower.
//
// The cap has to clear the measurement cadence with room for several multiples
// of it, which is why it is not tighter. A site measured every three days
// yields pairs at lags 3, 6, 9 and 12 and nothing in between: cap at 8 and only
// two lags survive, three parameters go unidentified, and the correction
// silently switches off at the exact cadence chosen to make the band tighter.
const VARIO_MIN_PAIRS = 15;  // per lag; below this that lag is noise
const VARIO_MAX_LAG = 12;    // days; beyond this trend contaminates gamma
const VARIO_MIN_LAGS = 3;    // three parameters need three lags to pin down
// With plenty of lags the fit can be second-guessed: a persistent component is
// adopted only if it cuts residual error by this share against a flat,
// nugget-only variogram, which stops three parameters chasing the sampling
// noise in gamma. Below VARIO_JUDGE_LAGS there is no spare degrees of freedom
// to run that test on, and the fit stands unchallenged — deliberately, because
// the two ways of being wrong are not symmetric. Missing real persistence
// understates the band, which is the failure that misleads; imagining some
// only widens it. Nothing a body measures is truly independent day to day
// anyway, so the unchallenged case errs in the direction that is merely
// cautious.
const VARIO_JUDGE_LAGS = 6;
const VARIO_SHAPE_GAIN = 0.5;
const AR_RHO_MAX = 0.85;     // cap: beyond here the inflation runs away

// First index of ts at or after t. ts is sorted ascending.
function lowerBound(ts, t) {
    let lo = 0, hi = ts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
}

// Local spacing between readings, measured directly: expand outward from t
// until k readings are collected (they're always a contiguous run in the sorted
// series), then take the MEDIAN gap between them. Measuring the gaps beats
// dividing a radius by a count — no special case for the ends of the series,
// and a single outlying gap can't drag the estimate.
function localSpacingDays(ts, t, k) {
    const lo = lowerBound(ts, t);

    let i = lo - 1, j = lo, found = 0;
    while (found < k && (i >= 0 || j < ts.length)) {
        const dl = i >= 0 ? t - ts[i] : Infinity;
        const dr = j < ts.length ? ts[j] - t : Infinity;
        if (dl <= dr) i--; else j++;
        found++;
    }

    const near = ts.slice(i + 1, j);
    if (near.length < 2) return null;
    const gaps = [];
    for (let n = 1; n < near.length; n++) gaps.push((near[n] - near[n - 1]) / 86400000);
    gaps.sort((a, b) => a - b);
    const m = gaps.length >> 1;
    return gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
}

function sigmaFor(spacingDays) {
    if (spacingDays == null) return SIGMA_MAX;
    return Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, SIGMA_SPAN * spacingDays));
}

// Running mean over a series — used on the sigma track, not the data.
function movingAverage(arr, halfWidth) {
    return arr.map((_, i) => {
        let sum = 0, n = 0;
        for (let k = Math.max(0, i - halfWidth); k <= Math.min(arr.length - 1, i + halfWidth); k++) {
            sum += arr[k]; n++;
        }
        return sum / n;
    });
}

// Splits the noise into its independent and its persistent halves by fitting
// gamma(d) = nugget + sill·(1 - p^d) to the empirical variogram.
//
// Returns null when the series is too sparse to pin down three parameters from
// short lags — weekly tape readings, for instance, whose only lags are 7 and
// 14. That fallback is sound rather than merely safe: at 7-day spacing p^7 is
// already negligible, so there is nothing for the correction to do, and weekly
// series measure 94-96% coverage with it switched off.
function noiseFromVariogram(dayIdx, vals) {
    const by = new Map();
    dayIdx.forEach((d, i) => by.set(d, vals[i]));

    const lags = [], gamma = [];
    for (let lag = 1; lag <= VARIO_MAX_LAG; lag++) {
        let sum = 0, pairs = 0;
        for (let i = 0; i < dayIdx.length; i++) {
            const other = by.get(dayIdx[i] + lag);
            if (other === undefined) continue;
            const diff = other - vals[i];
            sum += diff * diff; pairs++;
        }
        if (pairs >= VARIO_MIN_PAIRS) { lags.push(lag); gamma.push(sum / (2 * pairs)); }
    }
    if (lags.length < VARIO_MIN_LAGS) return null;

    // Nonlinear in p but LINEAR in (nugget, sill) once p is fixed, so walk a
    // grid of p and solve the 2x2 normal equations at each. Negative variances
    // are refitted on the boundary rather than returned.
    let best = null;
    for (let k = 0; k <= 60; k++) {
        const rho = (k / 60) * AR_RHO_MAX;
        let s11 = 0, s12 = 0, s22 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < lags.length; i++) {
            const x = 1 - Math.pow(rho, lags[i]), y = gamma[i];
            s11 += 1; s12 += x; s22 += x * x; b1 += y; b2 += x * y;
        }
        const det = s11 * s22 - s12 * s12;
        if (Math.abs(det) < 1e-15) continue;
        let nugget = (s22 * b1 - s12 * b2) / det;
        let sill = (s11 * b2 - s12 * b1) / det;
        if (nugget < 0) { nugget = 0; sill = s22 > 0 ? b2 / s22 : 0; }
        if (sill < 0) { sill = 0; nugget = b1 / s11; }
        if (nugget < 0 || sill < 0) continue;

        let sse = 0;
        for (let i = 0; i < lags.length; i++) {
            const r = gamma[i] - (nugget + sill * (1 - Math.pow(rho, lags[i])));
            sse += r * r;
        }
        if (!best || sse < best.sse) best = { sse, rho, nugget, sill };
    }
    if (!best || best.nugget + best.sill <= 0) return null;

    let flat = 0;
    for (let i = 0; i < gamma.length; i++) flat += gamma[i];
    flat /= gamma.length;
    let sse0 = 0;
    for (let i = 0; i < gamma.length; i++) sse0 += (gamma[i] - flat) * (gamma[i] - flat);
    if (lags.length >= VARIO_JUDGE_LAGS && best.sse > sse0 * (1 - VARIO_SHAPE_GAIN)) {
        return flat > 0 ? { rho: 0, nugget: flat, sill: 0, variance: flat } : null;
    }

    return { rho: best.rho, nugget: best.nugget, sill: best.sill,
             variance: best.nugget + best.sill };
}

// stdDays: pass a number to pin the bandwidth; omit it to adapt to density.
// Returns { x, y, lo, hi } — lo/hi are the 95% band, and null on any day whose
// kernel holds a single isolated reading, which has no residual to speak of and
// so supports no band at all.
function gaussianSmooth(dates, values, windowDays, stdDays) {
    const bare = { x: dates, y: values, lo: [], hi: [] };
    if (dates.length < 3) return bare;

    const pts = dates
        .map((d, i) => ({ t: new Date(d + 'T00:00:00').getTime(), v: values[i] }))
        .filter(p => !isNaN(p.t) && p.v != null)
        .sort((a, b) => a.t - b.t);
    if (pts.length < 3) return bare;

    const ts = pts.map(p => p.t);
    const dayMs = 86400000;
    const start = ts[0], end = ts[ts.length - 1];
    const nDays = Math.round((end - start) / dayMs) + 1;

    const grid = [];
    for (let i = 0; i < nDays; i++) grid.push(start + i * dayMs);

    // The median gap flips abruptly where a sparse stretch meets a dense one,
    // which would step sigma from 28 to 6 between adjacent days and put a
    // visible kink in the trend line. Smoothing the sigma track first makes the
    // bandwidth ease across the transition instead of snapping. The spacing
    // track gets the same treatment for the same reason — it drives the AR(1)
    // inflation, and an abrupt step there would kink the band edges.
    const rawSpacing = grid.map(t => localSpacingDays(ts, t, NEIGHBORS));
    const sigmas = stdDays
        ? grid.map(() => stdDays)
        : movingAverage(rawSpacing.map(sigmaFor), SIGMA_BLEND);
    const spacing = movingAverage(
        rawSpacing.map(s => s == null ? SIGMA_MAX : s), SIGMA_BLEND);

    // Pass 1 — the fit, plus the weight sums the standard error needs.
    const fit = new Float64Array(nDays);
    const sumW = new Float64Array(nDays);
    const sumW2 = new Float64Array(nDays);
    const lo = new Int32Array(nDays), hi = new Int32Array(nDays);
    const ok = new Uint8Array(nDays);
    for (let i = 0; i < nDays; i++) {
        const t = grid[i], sigma = sigmas[i], cutoff = sigma * 3 * dayMs;
        const a = lowerBound(ts, t - cutoff), b = lowerBound(ts, t + cutoff + 1);
        lo[i] = a; hi[i] = b;
        let sw = 0, sw2 = 0, sv = 0;
        for (let j = a; j < b; j++) {
            const w = Math.exp(-0.5 * (((ts[j] - t) / dayMs) / sigma) ** 2);
            sw += w; sw2 += w * w; sv += w * pts[j].v;
        }
        if (sw > 0) { fit[i] = sv / sw; sumW[i] = sw; sumW2[i] = sw2; ok[i] = 1; }
    }

    // Pass 2 — residuals about the fit. Every reading falls on a grid day
    // exactly (dates are calendar days), so no interpolation is needed.
    //
    // A residual is smaller than the noise that produced it, because the fit it
    // is measured against was itself pulled toward that reading. The shrinkage
    // is exactly 1 - 2·L_jj + Σ_k L_jk², the smoother's leverage at j: dividing
    // the weighted residual sum by Σ w·lev instead of by Σ w undoes it. This
    // matters most where it is easiest to get wrong — at the ends of the series
    // and in sparse stretches, where a reading dominates its own fit, residuals
    // collapse, and an uncorrected band would be at its most confident exactly
    // where it has the least right to be. The kernel is 1 at zero distance, so
    // L_jj is just 1/Σw.
    const resid = new Float64Array(pts.length);
    const lev = new Float64Array(pts.length);
    for (let j = 0; j < pts.length; j++) {
        const gi = Math.round((ts[j] - start) / dayMs);
        if (!ok[gi]) continue;
        resid[j] = pts[j].v - fit[gi];
        lev[j] = 1 - 2 / sumW[gi] + sumW2[gi] / (sumW[gi] * sumW[gi]);
    }

    // The residual track has the right SHAPE — it finds the noisy stretches —
    // but the fit has shrunk its overall level, and the leverage correction
    // above only undoes the part of that shrinkage attributable to independent
    // noise. Rescale the whole track to the variogram's level, which no fit has
    // touched. Only ever upward: residuals noisier than the variogram means the
    // trend line is missing real structure, and the wider band is the honest
    // reading of that.
    const dayIdx = [];
    for (let j = 0; j < pts.length; j++) dayIdx.push(Math.round((ts[j] - start) / dayMs));
    const noise = noiseFromVariogram(dayIdx, pts.map(p => p.v));
    const rho = noise ? noise.rho : 0;

    let scale = 1;
    if (noise) {
        let sr = 0, sl = 0;
        for (let j = 0; j < pts.length; j++) { sr += resid[j] * resid[j]; sl += lev[j]; }
        if (sr > 0 && sl > 0) scale = Math.max(1, noise.variance / (sr / sl));
    }

    // Pass 3 — local residual variance through the same kernel, then the band.
    const xs = [], ys = [], loBand = [], hiBand = [];
    for (let i = 0; i < nDays; i++) {
        if (!ok[i]) continue;
        const t = grid[i], sigma = sigmas[i];
        let sr = 0, sc = 0;
        for (let j = lo[i]; j < hi[i]; j++) {
            const w = Math.exp(-0.5 * (((ts[j] - t) / dayMs) / sigma) ** 2);
            sr += w * resid[j] * resid[j];
            sc += w * lev[j];
        }
        xs.push(tape.localDateStr(new Date(t)));
        ys.push(fit[i]);
        if (sc > 0) {
            // Only the persistent half of the noise is floored by
            // autocorrelation. The nugget averages down with n_eff like any
            // independent error, so the effective inflation is a blend of the
            // two — it collapses to 1 for pure tape error and to the full
            // AR(1) factor for pure physiology.
            const ph = Math.pow(rho, Math.max(1, spacing[i]));
            const arFactor = (1 + ph) / (1 - ph);
            const inflate = noise
                ? (noise.nugget + noise.sill * arFactor) / noise.variance
                : 1;
            // n_eff readings under the kernel, one of them spent on the local
            // mean the residuals are measured against.
            const nEff = sumW[i] * sumW[i] / sumW2[i];
            const half = t95(nEff - 1)
                       * Math.sqrt((sr / sc) * scale * inflate * sumW2[i]) / sumW[i];
            loBand.push(fit[i] - half);
            hiBand.push(fit[i] + half);
        } else {
            loBand.push(null);
            hiBand.push(null);
        }
    }
    return { x: xs, y: ys, lo: loBand, hi: hiBand };
}

// Band colours — the trend line's own hue, so on a panel carrying two series
// each band still reads as belonging to its line.
//
// The bands sit ABOVE the markers, which is the opposite of the usual advice
// and is forced by the data: on a year of near-daily weigh-ins the trend is
// pinned to well under half a pound, so the band is narrower than a single
// marker and a dense dot cloud hides it completely. Underneath the dots it was
// invisible on exactly the panel that has the most to say. So the fill is kept
// light enough to leave the markers legible through it — this matters most on
// the weight chart, where marker colour carries fat% and has to stay readable
// against the colourbar — and the ribbon is instead made unmistakable by
// drawing its two edges as hairlines.
const BAND_TREND = { fill: 'rgba(17, 24, 39, 0.10)', edge: 'rgba(17, 24, 39, 0.40)' };
const BAND_A = { fill: 'rgba(106, 90, 205, 0.13)', edge: 'rgba(106, 90, 205, 0.50)' };
const BAND_B = { fill: 'rgba(31, 158, 137, 0.13)', edge: 'rgba(31, 158, 137, 0.50)' };

// A 95% band as Plotly draws it: the lower edge, then the upper edge filling
// down to it. The two must stay ADJACENT in the trace array — `tonexty` fills
// to whatever trace immediately precedes it, so anything slipped between them
// becomes the fill target and the band lands somewhere else entirely.
function bandTraces(sm, colors, axes) {
    if (!sm.lo || sm.lo.length !== sm.x.length) return [];
    if (!sm.lo.some(v => v != null)) return [];
    const common = {
        ...(axes || {}), mode: 'lines', line: { width: 1, color: colors.edge },
        hoverinfo: 'skip', showlegend: false, connectgaps: false,
    };
    return [
        { ...common, x: sm.x, y: sm.lo },
        { ...common, x: sm.x, y: sm.hi, fill: 'tonexty', fillcolor: colors.fill },
    ];
}

// Finite band edges only — for folding a band into a manual axis range.
function bandExtent(sm) {
    if (!sm.lo) return [];
    return sm.lo.concat(sm.hi).filter(v => v != null && isFinite(v));
}

// ── 1. Weight chart ────────────────────────────────────
function renderWeightChart(el, data) {
    if (!data.length) { Plotly.purge(el); return; }

    const dates = data.map(r => r.date);
    const weights = data.map(r => r.weight);
    const fatPcts = data.map(r => r.fat_percent_cal != null ? r.fat_percent_cal : r.fat_percent);
    const nDays = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000;
    const ptSize = nDays < 500 ? 19 : 13;

    const validFat = fatPcts.filter(f => f != null);
    const cmin = validFat.length ? Math.min(...validFat) : 10;
    const cmax = validFat.length ? Math.max(...validFat) : 25;

    const sm = gaussianSmooth(dates, weights);

    const traces = [
        {
            x: dates, y: weights, mode: 'markers',
            marker: {
                size: ptSize, color: fatPcts,
                colorscale: VIRIDIS_R, cmin, cmax,
                colorbar: { title: { text: '% Fat', font: { size: 12 } }, thickness: 16, len: 0.6, tickfont: { size: 11 } },
                line: { width: 0.5, color: 'white' },
            },
            hovertemplate: '<b>%{x|%b %d, %Y}</b><br>%{y:.1f} pounds, %{marker.color:.1f}% fat<extra></extra>',
            hoverlabel: HOVERLABEL,
        },
        ...bandTraces(sm, BAND_TREND),
        {
            x: sm.x, y: sm.y, mode: 'lines',
            line: { color: 'black', width: 1.5 },
            hoverinfo: 'skip',
        },
    ];

    Plotly.newPlot(el, traces, { ...baseLayout(), height: 300 }, CFG);
}

// ── 2. Muscle & Fat chart ──────────────────────────────
function renderMuscleFatChart(el, data) {
    data = data.filter(r => r.fat_lbs != null && r.muscle_lbs != null);
    if (!data.length) { Plotly.purge(el); return; }

    const dates = data.map(r => r.date);
    const muscle = data.map(r => r.muscle_lbs);
    const fat = data.map(r => r.fat_lbs);

    const smM = gaussianSmooth(dates, muscle);
    const smF = gaussianSmooth(dates, fat);

    const mkMarker = () => ({ size: 14, color: 'slateblue', opacity: 1, line: { width: 0.5, color: 'white' } });

    const traces = [
        { x: dates, y: muscle, mode: 'markers', marker: mkMarker(), xaxis: 'x', yaxis: 'y',
          hovertemplate: '<b>%{x|%b %d, %Y}</b><br>%{y:.1f} pounds<extra></extra>', hoverlabel: HOVERLABEL },
        ...bandTraces(smM, BAND_TREND, { xaxis: 'x', yaxis: 'y' }),
        { x: smM.x, y: smM.y, mode: 'lines', line: { color: 'black', width: 1.5 },
          xaxis: 'x', yaxis: 'y', hoverinfo: 'skip' },
        { x: dates, y: fat, mode: 'markers', marker: mkMarker(), xaxis: 'x2', yaxis: 'y2',
          hovertemplate: '<b>%{x|%b %d, %Y}</b><br>%{y:.1f} pounds<extra></extra>', hoverlabel: HOVERLABEL },
        ...bandTraces(smF, BAND_TREND, { xaxis: 'x2', yaxis: 'y2' }),
        { x: smF.x, y: smF.y, mode: 'lines', line: { color: 'black', width: 1.5 },
          xaxis: 'x2', yaxis: 'y2', hoverinfo: 'skip' },
    ];

    // ── Gold-standard scans over the fat series ──────────────────────────────
    // Only the fat panel gets them. The two InBody scans do report muscle mass,
    // but MUSCLE_OF_LEAN is deliberately built from their RATIO rather than
    // their absolute number, so predicted muscle sits 1.7–3.0 lbs above what
    // they printed by construction — plotting those would draw a permanent gap
    // that looks like drift and isn't.
    //
    // Anchors carry fat POUNDS on the densitometry level (see ANCHORS in
    // calibration.js), which is what makes all four comparable to this curve and
    // to each other. Restricted to the plotted window so a range preset doesn't
    // drag the axis back to 2015.
    //
    // The bound is asymmetric on purpose. On the left it is hard: an anchor
    // older than the window is out of scope, full stop. On the right it carries
    // a grace period, because the data extent is only a PROXY for the window —
    // a scan taken after the last weigh-in is still inside the range you asked
    // for, your readings just haven't caught up to it. Without the grace, a
    // fresh scan stays invisible until the next time you step on the scale,
    // which is exactly when you most want to see where it landed. 45 days is
    // past any normal weigh-in gap and costs at most a stub of empty axis.
    const ANCHOR_GRACE_DAYS = 45;
    const lo = dates[0], hi = dates[dates.length - 1];
    const hiGrace = tape.localDateStr(new Date(new Date(hi + 'T00:00:00').getTime()
                                               + ANCHOR_GRACE_DAYS * 86400000));
    const anchors = (window.ANCHORS || []).filter(a => a.date >= lo && a.date <= hiGrace);

    if (anchors.length) {
        traces.push({
            x: anchors.map(a => a.date), y: anchors.map(a => a.fat_lbs),
            mode: 'markers', xaxis: 'x2', yaxis: 'y2',
            marker: { size: 13, symbol: 'diamond-open', color: '#b45309', line: { width: 2.5 } },
            customdata: anchors.map(a => [a.method, a.fat, a.fat_densi]),
            hovertemplate: '<b>%{x|%b %d, %Y}</b><br>%{customdata[0]}<br>'
                         + '%{y:.1f} lbs fat<extra></extra>',
            hoverlabel: HOVERLABEL,
        });
    }

    const pad = (arr) => {
        const mn = Math.min(...arr), mx = Math.max(...arr), p = (mx - mn) * 0.08;
        return [mn - p, mx + p];
    };
    // Anchors join the fat axis range so a scan can never land off-screen — an
    // invisible anchor is worse than no anchor, since the panel would then look
    // like agreement it hasn't demonstrated.
    const fatSpan = fat.concat(anchors.map(a => a.fat_lbs), bandExtent(smF));

    const layout = {
        ...baseLayout(), height: 600, showlegend: false,
        margin: { l: 48, r: 16, t: 20, b: 28 },
        grid: { rows: 2, columns: 1, subplots: [['xy'], ['x2y2']], roworder: 'top to bottom' },
        xaxis: { ...AXIS },
        yaxis: { ...AXIS, range: pad(muscle.concat(bandExtent(smM))), title: { text: 'pounds', font: { size: 11 } } },
        xaxis2: { ...AXIS, matches: 'x' },
        yaxis2: { ...AXIS, range: pad(fatSpan), title: { text: 'pounds', font: { size: 11 } } },
        annotations: [
            { text: 'Muscle', xref: 'paper', yref: 'paper', x: 0.5, y: 1, showarrow: false,
              font: { size: 12, color: '#6b7280' }, xanchor: 'center', yanchor: 'bottom' },
            { text: 'Fat', xref: 'paper', yref: 'paper', x: 0.5, y: 0.45, showarrow: false,
              font: { size: 12, color: '#6b7280' }, xanchor: 'center', yanchor: 'bottom' },
        ],
    };

    Plotly.newPlot(el, traces, layout, CFG);
}

// ── 3. Path chart (quarterly arrows) ───────────────────
function renderPathChart(el, data) {
    data = data.filter(r => r.fat_lbs != null && r.muscle_lbs != null);
    if (!data.length) { Plotly.purge(el); return; }

    // Aggregate to quarters
    const qMap = {};
    data.forEach(r => {
        const d = new Date(r.date);
        const q = `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
        if (!qMap[q]) qMap[q] = { muscle: [], fat: [] };
        qMap[q].muscle.push(r.muscle_lbs);
        qMap[q].fat.push(r.fat_lbs);
    });

    const quarters = Object.keys(qMap).sort().map(q => ({
        label: q,
        muscle: qMap[q].muscle.reduce((a, b) => a + b, 0) / qMap[q].muscle.length,
        fat: qMap[q].fat.reduce((a, b) => a + b, 0) / qMap[q].fat.length,
    }));

    const annotations = [];
    const hoverTraces = [];

    for (let i = 0; i < quarters.length - 1; i++) {
        const q0 = quarters[i], q1 = quarters[i + 1];
        const dx = q1.muscle - q0.muscle, dy = q1.fat - q0.fat;
        if (Math.sqrt(dx * dx + dy * dy) < 0.01) continue;

        annotations.push({
            x: q1.muscle, y: q1.fat,
            ax: q0.muscle, ay: q0.fat,
            xref: 'x', yref: 'y', axref: 'x', ayref: 'y',
            showarrow: true, arrowhead: 2, arrowsize: 0.7, arrowwidth: 1.5,
            arrowcolor: 'black',
        });

        const signM = dx >= 0 ? '+' : '', signF = dy >= 0 ? '+' : '';
        hoverTraces.push({
            x: [((q0.muscle + q1.muscle) / 2).toFixed(4)],
            y: [((q0.fat + q1.fat) / 2).toFixed(4)],
            mode: 'markers',
            marker: { size: 14, opacity: 0 },
            hovertemplate: `<b>${q1.label}</b><br>Muscle: ${signM}${dx.toFixed(1)} lbs<br>Fat: ${signF}${dy.toFixed(1)} lbs<extra></extra>`,
            hoverlabel: HOVERLABEL,
            showlegend: false,
        });
    }

    const layout = {
        ...baseLayout(), height: 400,
        xaxis: { ...AXIS, title: 'Muscle (pounds)', type: 'linear' },
        yaxis: { ...AXIS, title: 'Fat (pounds)', scaleanchor: 'x', scaleratio: 1, type: 'linear' },
        annotations,
    };

    Plotly.newPlot(el, hoverTraces, layout, CFG);
}

// ── 4. Circumference charts ────────────────────────────
// One chart per site, all in absolute inches on their own axis. Each site gets
// its own y-range, so a 0.3 in change reads clearly even though thigh sits ~8
// inches above bicep — no shared axis to flatten anything, and no mixing of
// absolute and relative scales across the dashboard.
const SERIES_A = '#6A5ACD';  // slateblue
const SERIES_B = '#1f9e89';  // teal — validated ΔE 19.6 (deutan) vs SERIES_A

// dense: measured every few days, worth a Gaussian trend line. Sparse monthly
// sites get a plain connector instead — smoothing 6 points invents a curve that
// isn't there.
function renderCircumferenceChart(el, tapeRows, key, label, dense) {
    const rows = tapeRows.filter(r => r[key] != null);
    if (!rows.length) { Plotly.purge(el); return; }

    const x = rows.map(r => r.date);
    const y = rows.map(r => r[key]);

    const traces = [{
        x, y, mode: dense ? 'markers' : 'lines+markers',
        line: { color: SERIES_A, width: 2 },
        marker: { size: dense ? 12 : 10, color: SERIES_A, line: { width: 2, color: 'white' } },
        // ~f trims trailing zeros, so an eighth-inch reading (36.625) survives
        // intact while a round 37 doesn't render as 37.000.
        hovertemplate: `<b>%{x|%b %d, %Y}</b><br>%{y:.3~f} in ${label.toLowerCase()}<extra></extra>`,
        hoverlabel: HOVERLABEL, showlegend: false,
    }];

    if (dense && rows.length >= 3) {
        // Tighter than the weight smoother: waist is low-noise, so a 90/20
        // kernel would flatten exactly the change we're looking for.
        //
        // Pinned rather than adaptive, and left at 14 days as the cadence went
        // from weekly to every three days. Widening it would buy a narrower
        // band — it is the only lever on the physiological half of the noise —
        // but at the cost of a staler line, and the point of measuring more
        // often was to see change sooner, not to average over more of it.
        const sm = gaussianSmooth(x, y, 60, 14);
        traces.push(...bandTraces(sm, BAND_TREND));
        traces.push({
            x: sm.x, y: sm.y, mode: 'lines',
            line: { color: 'black', width: 2 },
            hoverinfo: 'skip', showlegend: false,
        });
    }

    const layout = {
        ...baseLayout(), height: 250, showlegend: false,
        margin: { l: 48, r: 16, t: 22, b: 28 },
        annotations: [
            { text: `${label} (inches)`, xref: 'paper', yref: 'paper', x: 0.5, y: 1,
              showarrow: false, font: { size: 12, color: '#6b7280' },
              xanchor: 'center', yanchor: 'bottom' },
        ],
    };

    Plotly.newPlot(el, traces, layout, CFG);
}

// ── 5. Navy vs BIA chart ───────────────────────────────
// The drift check for the tape era. The calibrated BIA curve rests on 4 gold-
// standard anchors (drawn on the fat chart, not here — this panel's x-range is
// tape-era only and the earliest anchor is 2015) and extrapolates past the
// heaviest one. The Navy estimate is biased high
// for lean muscular builds, so the two lines are NOT expected to coincide —
// what matters is whether the gap between them stays constant. A widening gap
// means the BIA extrapolation is going off.
function renderNavyChart(el, navyRows, calibrated) {
    if (!navyRows.length) { Plotly.purge(el); return; }

    const bia = calibrated.filter(r => r.fat_percent_cal != null);
    const smNavy = gaussianSmooth(navyRows.map(r => r.date),
                                  navyRows.map(r => r.fat_percent), 60, 14);
    // Scatter in the readings only. The calibration itself rests on four anchors
    // and is extrapolating past the heaviest of them; that uncertainty is not in
    // this band, which says how well the scale agrees with itself, not how close
    // it is to a dunk tank. Read the two bands for whether the GAP between the
    // lines is holding steady — overlapping bands here would mean the gap is
    // within noise, not that the two methods agree.
    const smBia = bia.length
        ? gaussianSmooth(bia.map(r => r.date), bia.map(r => r.fat_percent_cal))
        : null;

    const traces = [
        {
            x: navyRows.map(r => r.date), y: navyRows.map(r => r.fat_percent),
            mode: 'markers', name: 'Navy (tape)',
            marker: { size: 10, color: SERIES_B, line: { width: 2, color: 'white' } },
            hovertemplate: '<b>%{x|%b %d, %Y}</b><br>%{y:.1f}% (tape)<extra></extra>',
            hoverlabel: HOVERLABEL,
        },
        ...bandTraces(smNavy, BAND_B),
        ...(smBia ? bandTraces(smBia, BAND_A) : []),
        {
            x: smNavy.x, y: smNavy.y, mode: 'lines', showlegend: false,
            line: { color: SERIES_B, width: 2 }, hoverinfo: 'skip',
        },
    ];

    if (smBia) {
        traces.push({
            x: smBia.x, y: smBia.y, mode: 'lines', name: 'Calibrated scale',
            line: { color: SERIES_A, width: 2 },
            hovertemplate: '<b>%{x|%b %d, %Y}</b><br>%{y:.1f}% (scale)<extra></extra>',
            hoverlabel: HOVERLABEL,
        });
    }

    const layout = {
        ...baseLayout(), height: 320,
        showlegend: true,
        legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: 1.02, yanchor: 'bottom',
                  font: { size: 11 } },
        margin: { l: 48, r: 16, t: 34, b: 28 },
        yaxis: { ...AXIS, title: { text: '% fat', font: { size: 11 } } },
    };

    Plotly.newPlot(el, traces, layout, CFG);
}

window.charts = { renderWeightChart, renderMuscleFatChart, renderPathChart,
                  renderCircumferenceChart, renderNavyChart };
