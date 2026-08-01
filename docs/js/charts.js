// Chart builders using Plotly.js — ported from charts.py

const FONT = { family: 'Inter, -apple-system, sans-serif', color: '#1f2937', size: 12 };
const BASE_LAYOUT = {
    template: 'plotly_white',
    paper_bgcolor: 'white', plot_bgcolor: 'white',
    font: FONT,
    xaxis: { showgrid: false, zeroline: false, linecolor: '#e5e7eb', linewidth: 1 },
    yaxis: { showgrid: false, zeroline: false, linecolor: '#e5e7eb', linewidth: 1 },
    margin: { l: 48, r: 16, t: 8, b: 28 },
    showlegend: false,
};
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

// Local spacing between readings, measured directly: expand outward from t
// until k readings are collected (they're always a contiguous run in the sorted
// series), then take the MEDIAN gap between them. Measuring the gaps beats
// dividing a radius by a count — no special case for the ends of the series,
// and a single outlying gap can't drag the estimate.
function localSpacingDays(ts, t, k) {
    let lo = 0, hi = ts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] < t) lo = mid + 1; else hi = mid; }

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

function adaptiveSigma(ts, t) {
    const spacing = localSpacingDays(ts, t, NEIGHBORS);
    if (!spacing) return SIGMA_MAX;
    return Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, SIGMA_SPAN * spacing));
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

// stdDays: pass a number to pin the bandwidth; omit it to adapt to density.
function gaussianSmooth(dates, values, windowDays, stdDays) {
    if (dates.length < 3) return { x: dates, y: values };

    const pts = dates
        .map((d, i) => ({ t: new Date(d + 'T00:00:00').getTime(), v: values[i] }))
        .filter(p => !isNaN(p.t) && p.v != null)
        .sort((a, b) => a.t - b.t);
    if (pts.length < 3) return { x: dates, y: values };

    const ts = pts.map(p => p.t);
    const dayMs = 86400000;
    const start = ts[0], end = ts[ts.length - 1];
    const nDays = Math.round((end - start) / dayMs) + 1;

    const grid = [];
    for (let i = 0; i < nDays; i++) grid.push(start + i * dayMs);

    // The median gap flips abruptly where a sparse stretch meets a dense one,
    // which would step sigma from 28 to 6 between adjacent days and put a
    // visible kink in the trend line. Smoothing the sigma track first makes the
    // bandwidth ease across the transition instead of snapping.
    const sigmas = stdDays
        ? grid.map(() => stdDays)
        : movingAverage(grid.map(t => adaptiveSigma(ts, t)), SIGMA_BLEND);

    const x = [], y = [];
    for (let i = 0; i < nDays; i++) {
        const t = grid[i], sigma = sigmas[i];
        const cutoff = sigma * 3 * dayMs;
        let wsum = 0, wval = 0;
        for (let j = 0; j < pts.length; j++) {
            const dist = Math.abs(pts[j].t - t);
            if (dist > cutoff) continue;
            const w = Math.exp(-0.5 * ((dist / dayMs) / sigma) ** 2);
            wsum += w;
            wval += w * pts[j].v;
        }
        if (wsum > 0) {
            x.push(tape.localDateStr(new Date(t)));
            y.push(wval / wsum);
        }
    }
    return { x, y };
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
        {
            x: sm.x, y: sm.y, mode: 'lines',
            line: { color: 'black', width: 1.5 },
            hoverinfo: 'skip',
        },
    ];

    Plotly.newPlot(el, traces, { ...BASE_LAYOUT, height: 300 }, CFG);
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
        { x: smM.x, y: smM.y, mode: 'lines', line: { color: 'black', width: 1.5 },
          xaxis: 'x', yaxis: 'y', hoverinfo: 'skip' },
        { x: dates, y: fat, mode: 'markers', marker: mkMarker(), xaxis: 'x2', yaxis: 'y2',
          hovertemplate: '<b>%{x|%b %d, %Y}</b><br>%{y:.1f} pounds<extra></extra>', hoverlabel: HOVERLABEL },
        { x: smF.x, y: smF.y, mode: 'lines', line: { color: 'black', width: 1.5 },
          xaxis: 'x2', yaxis: 'y2', hoverinfo: 'skip' },
    ];

    const pad = (arr) => {
        const mn = Math.min(...arr), mx = Math.max(...arr), p = (mx - mn) * 0.08;
        return [mn - p, mx + p];
    };

    const layout = {
        ...BASE_LAYOUT, height: 600, showlegend: false,
        margin: { l: 48, r: 16, t: 20, b: 28 },
        grid: { rows: 2, columns: 1, subplots: [['xy'], ['x2y2']], roworder: 'top to bottom' },
        xaxis: { ...BASE_LAYOUT.xaxis },
        yaxis: { ...BASE_LAYOUT.yaxis, range: pad(muscle), title: { text: 'pounds', font: { size: 11 } } },
        xaxis2: { ...BASE_LAYOUT.xaxis, matches: 'x' },
        yaxis2: { ...BASE_LAYOUT.yaxis, range: pad(fat), title: { text: 'pounds', font: { size: 11 } } },
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
        ...BASE_LAYOUT, height: 400,
        xaxis: { ...BASE_LAYOUT.xaxis, title: 'Muscle (pounds)', type: 'linear' },
        yaxis: { ...BASE_LAYOUT.yaxis, title: 'Fat (pounds)', scaleanchor: 'x', scaleratio: 1, type: 'linear' },
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

// dense: weekly data, worth a Gaussian trend line. Sparse monthly sites get a
// plain connector instead — smoothing 6 points invents a curve that isn't there.
function renderCircumferenceChart(el, tapeRows, key, label, dense) {
    const rows = tapeRows.filter(r => r[key] != null);
    if (!rows.length) { Plotly.purge(el); return; }

    const x = rows.map(r => r.date);
    const y = rows.map(r => r[key]);

    const traces = [{
        x, y, mode: dense ? 'markers' : 'lines+markers',
        line: { color: SERIES_A, width: 2 },
        marker: { size: dense ? 12 : 10, color: SERIES_A, line: { width: 2, color: 'white' } },
        hovertemplate: `<b>%{x|%b %d, %Y}</b><br>%{y:.2f} in ${label.toLowerCase()}<extra></extra>`,
        hoverlabel: HOVERLABEL, showlegend: false,
    }];

    if (dense && rows.length >= 3) {
        // Tighter than the weight smoother: waist is weekly and low-noise, so a
        // 90/20 kernel would flatten exactly the change we're looking for.
        const sm = gaussianSmooth(x, y, 60, 14);
        traces.push({
            x: sm.x, y: sm.y, mode: 'lines',
            line: { color: 'black', width: 2 },
            hoverinfo: 'skip', showlegend: false,
        });
    }

    const layout = {
        ...BASE_LAYOUT, height: 250, showlegend: false,
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
// The drift check: the calibrated BIA curve rests on 3 gold-standard anchors and
// extrapolates linearly past the heaviest one. The Navy estimate is biased high
// for lean muscular builds, so the two lines are NOT expected to coincide —
// what matters is whether the gap between them stays constant. A widening gap
// means the BIA extrapolation is going off.
function renderNavyChart(el, navyRows, calibrated) {
    if (!navyRows.length) { Plotly.purge(el); return; }

    const bia = calibrated.filter(r => r.fat_percent_cal != null);
    const smNavy = gaussianSmooth(navyRows.map(r => r.date),
                                  navyRows.map(r => r.fat_percent), 60, 14);

    const traces = [
        {
            x: navyRows.map(r => r.date), y: navyRows.map(r => r.fat_percent),
            mode: 'markers', name: 'Navy (tape)',
            marker: { size: 10, color: SERIES_B, line: { width: 2, color: 'white' } },
            hovertemplate: '<b>%{x|%b %d, %Y}</b><br>%{y:.1f}% (tape)<extra></extra>',
            hoverlabel: HOVERLABEL,
        },
        {
            x: smNavy.x, y: smNavy.y, mode: 'lines', showlegend: false,
            line: { color: SERIES_B, width: 2 }, hoverinfo: 'skip',
        },
    ];

    if (bia.length) {
        const sm = gaussianSmooth(bia.map(r => r.date), bia.map(r => r.fat_percent_cal));
        traces.push({
            x: sm.x, y: sm.y, mode: 'lines', name: 'Calibrated scale',
            line: { color: SERIES_A, width: 2 },
            hovertemplate: '<b>%{x|%b %d, %Y}</b><br>%{y:.1f}% (scale)<extra></extra>',
            hoverlabel: HOVERLABEL,
        });
    }

    const layout = {
        ...BASE_LAYOUT, height: 320,
        showlegend: true,
        legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: 1.02, yanchor: 'bottom',
                  font: { size: 11 } },
        margin: { l: 48, r: 16, t: 34, b: 28 },
        yaxis: { ...BASE_LAYOUT.yaxis, title: { text: '% fat', font: { size: 11 } } },
    };

    Plotly.newPlot(el, traces, layout, CFG);
}

window.charts = { renderWeightChart, renderMuscleFatChart, renderPathChart,
                  renderCircumferenceChart, renderNavyChart };
