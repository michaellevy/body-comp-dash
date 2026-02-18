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

// ── Smoothing: resample daily + Gaussian rolling mean ──
function gaussianSmooth(dates, values, windowDays, stdDays) {
    windowDays = windowDays || 90;
    stdDays = stdDays || 20;
    if (dates.length < 3) return { x: dates, y: values };

    const ts = dates.map(d => new Date(d).getTime());
    const dayMs = 86400000;
    const start = ts[0], end = ts[ts.length - 1];
    const nDays = Math.round((end - start) / dayMs) + 1;
    const dailyX = [], dailyY = [];

    let j = 0;
    for (let i = 0; i < nDays; i++) {
        const t = start + i * dayMs;
        while (j < ts.length - 1 && ts[j + 1] < t) j++;
        if (j >= ts.length - 1) {
            dailyX.push(new Date(t));
            dailyY.push(values[values.length - 1]);
        } else {
            const frac = (t - ts[j]) / (ts[j + 1] - ts[j] || 1);
            dailyX.push(new Date(t));
            dailyY.push(values[j] + frac * (values[j + 1] - values[j]));
        }
    }

    const half = Math.floor(windowDays / 2);
    const smoothed = [];
    for (let i = 0; i < dailyY.length; i++) {
        let wsum = 0, wval = 0;
        for (let k = Math.max(0, i - half); k <= Math.min(dailyY.length - 1, i + half); k++) {
            const dist = k - i;
            const w = Math.exp(-0.5 * (dist / stdDays) ** 2);
            wsum += w;
            wval += w * dailyY[k];
        }
        smoothed.push(wval / wsum);
    }
    return { x: dailyX, y: smoothed };
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

window.charts = { renderWeightChart, renderMuscleFatChart, renderPathChart };
