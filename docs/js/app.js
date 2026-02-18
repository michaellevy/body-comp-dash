// Main app logic — tabs, form, slider, chart orchestration

document.addEventListener('DOMContentLoaded', async () => {
    // ── Tabs ───────────────────────────────────────────
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.target).classList.add('active');
            if (tab.dataset.target === 'log-tab') refreshRecent();
            if (tab.dataset.target === 'charts-tab') refreshCharts();
        });
    });

    // ── Date default ───────────────────────────────────
    const dateInput = document.getElementById('input-date');
    dateInput.value = new Date().toISOString().slice(0, 10);

    // ── Save ───────────────────────────────────────────
    document.getElementById('save-btn').addEventListener('click', async () => {
        const weight = document.getElementById('input-weight').value;
        const fat = document.getElementById('input-fat').value;
        const feedback = document.getElementById('feedback');

        if (!weight) {
            feedback.textContent = 'Weight is required.';
            feedback.className = 'err';
            return;
        }

        const dt = dateInput.value || new Date().toISOString().slice(0, 10);
        await db.saveMeasurement(dt, weight, fat || null);

        const fatStr = fat ? `, ${fat}% fat` : '';
        const d = new Date(dt + 'T00:00:00');
        const mon = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        feedback.textContent = `Saved ${mon} — ${weight} lbs${fatStr}`;
        feedback.className = 'ok';

        document.getElementById('input-weight').value = '';
        document.getElementById('input-fat').value = '';
        refreshRecent();
    });

    // ── Recent entries ─────────────────────────────────
    async function refreshRecent() {
        const el = document.getElementById('recent-entries');
        const recent = await db.getRecentMeasurements(7);
        if (!recent.length) {
            el.innerHTML = '<div class="muted">No entries yet.</div>';
            return;
        }
        let html = '<div class="entry-header"><span>Date</span><span>Weight</span><span>Fat%</span></div>';
        recent.reverse().forEach(r => {
            const fat = r.fat_percent != null ? r.fat_percent.toFixed(1) : '—';
            html += `<div class="entry-row"><span>${r.date}</span><span>${r.weight.toFixed(1)}</span><span>${fat}</span></div>`;
        });
        el.innerHTML = html;
    }

    // ── Slider ─────────────────────────────────────────
    const slider = document.getElementById('range-slider');
    const sliderLabel = document.getElementById('slider-label');
    let allData = [];

    function sliderToDate(val) {
        const now = new Date();
        const months = parseInt(slider.max) - parseInt(val);
        if (months <= 0) return null; // all data
        const d = new Date(now.getFullYear(), now.getMonth() - months, 1);
        return d.toISOString().slice(0, 10);
    }

    function updateSliderLabel() {
        const since = sliderToDate(slider.value);
        if (!since) {
            sliderLabel.textContent = 'All data';
        } else {
            sliderLabel.textContent = 'From ' + since.slice(0, 7);
        }
    }

    slider.addEventListener('input', () => {
        updateSliderLabel();
    });

    slider.addEventListener('change', () => {
        refreshCharts();
    });

    // ── Charts ─────────────────────────────────────────
    async function refreshCharts() {
        allData = await db.getAllMeasurements();
        const since = sliderToDate(slider.value);
        let filtered = allData;
        if (since) {
            filtered = allData.filter(r => r.date >= since);
        }
        const cal = calibrate(filtered);

        charts.renderWeightChart('weight-chart', cal);
        charts.renderMuscleFatChart('muscle-fat-chart', cal);
        charts.renderPathChart('path-chart', cal);
    }

    // ── Settings (Supabase) ────────────────────────────
    const settingsBtn = document.getElementById('settings-btn');
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
        });
    }

    document.getElementById('supa-save')?.addEventListener('click', () => {
        const url = document.getElementById('supa-url').value.trim();
        const key = document.getElementById('supa-key').value.trim();
        if (url && key) {
            db.setSupa(url, key);
            document.getElementById('supa-status').textContent = 'Saved.';
            document.getElementById('supa-status').className = 'ok';
        }
    });

    document.getElementById('sync-pull')?.addEventListener('click', async () => {
        const n = await db.syncFromCloud();
        document.getElementById('supa-status').textContent = `Pulled ${n} rows.`;
        document.getElementById('supa-status').className = 'ok';
        refreshRecent();
    });

    document.getElementById('sync-push')?.addEventListener('click', async () => {
        const n = await db.syncToCloud();
        document.getElementById('supa-status').textContent = `Pushed ${n} rows.`;
        document.getElementById('supa-status').className = 'ok';
    });

    document.getElementById('export-btn')?.addEventListener('click', async () => {
        const all = await db.getAllMeasurements();
        const blob = new Blob([db.exportJSON(all)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bodycomp-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
    });

    document.getElementById('import-file')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const data = JSON.parse(text);
        const n = await db.importJSON(data);
        document.getElementById('supa-status').textContent = `Imported ${n} rows.`;
        document.getElementById('supa-status').className = 'ok';
        refreshRecent();
    });

    // ── Init ───────────────────────────────────────────
    // Populate Supabase fields if configured
    if (db.supaConfigured()) {
        const url = localStorage.getItem('supa_url');
        const key = localStorage.getItem('supa_key');
        if (document.getElementById('supa-url')) document.getElementById('supa-url').value = url;
        if (document.getElementById('supa-key')) document.getElementById('supa-key').value = key;
        // Auto-sync from cloud on load
        db.syncFromCloud().then(() => refreshRecent());
    }

    // Set slider range based on data
    const all = await db.getAllMeasurements();
    if (all.length) {
        const earliest = new Date(all[0].date);
        const now = new Date();
        const totalMonths = (now.getFullYear() - earliest.getFullYear()) * 12 + (now.getMonth() - earliest.getMonth());
        slider.max = totalMonths;
        slider.value = Math.max(0, totalMonths - 12); // default 1 year
    }
    updateSliderLabel();
    refreshRecent();
});
