"""Body Composition Dashboard — mobile-first Dash app."""

import os
from datetime import date, timedelta

import dash
from dash import dcc, html, Input, Output, State, callback, no_update
import dash_bootstrap_components as dbc
import plotly.graph_objects as go

import models
import charts

models.init_db()

# ── Compute slider range from data ───────────────────────────────────
_all = models.get_measurements()
if _all:
    _earliest_raw = _all[0]["date"]
    _earliest = date.fromisoformat(_earliest_raw) if isinstance(_earliest_raw, str) else _earliest_raw
    _total_months = (date.today().year - _earliest.year) * 12 + (date.today().month - _earliest.month)
else:
    _total_months = 12

# Build slider marks as start-year labels at Jan of each year
_earliest_year = _earliest.year
_latest_year = date.today().year
# Map: slider value = months from earliest date to start date
# So slider min=0 means start=earliest, slider max=_total_months-3 means start=3mo ago
_slider_marks = {}
for yr in range(_earliest_year, _latest_year + 1):
    months_offset = (yr - _earliest_year) * 12 + (1 - _earliest.month)
    months_offset = max(0, min(months_offset, _total_months))
    _slider_marks[months_offset] = str(yr)

app = dash.Dash(
    __name__,
    external_stylesheets=[
        dbc.themes.LITERA,
        "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap",
    ],
    meta_tags=[
        {"name": "viewport", "content": "width=device-width, initial-scale=1"},
        {"name": "theme-color", "content": "#111827"},
        {"name": "apple-mobile-web-app-capable", "content": "yes"},
    ],
    title="Body Comp",
)
server = app.server

# PWA: inject manifest link and service worker registration
app.index_string = '''<!DOCTYPE html>
<html>
    <head>
        {%metas%}
        <title>{%title%}</title>
        <link rel="manifest" href="/assets/manifest.json">
        <link rel="icon" href="/assets/icon-192.png">
        <link rel="apple-touch-icon" href="/assets/icon-192.png">
        {%favicon%}
        {%css%}
    </head>
    <body>
        {%app_entry%}
        <footer>
            {%config%}
            {%scripts%}
            {%renderer%}
        </footer>
        <script>
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('/assets/sw.js');
            }
        </script>
    </body>
</html>'''

# ── Styles ──────────────────────────────────────────────────────────
CARD = {
    "backgroundColor": "white",
    "border": "1px solid #e5e7eb",
    "borderRadius": "10px",
    "boxShadow": "0 1px 3px rgba(0,0,0,0.04)",
}
INPUT_STYLE = {
    "fontSize": "1.25rem", "height": "3.2rem",
    "border": "1px solid #d1d5db", "borderRadius": "8px",
}
BODY = {"fontFamily": "Inter, -apple-system, sans-serif",
        "backgroundColor": "#f8f9fa", "minHeight": "100vh"}
GRAPH_CFG = {"displayModeBar": False}
LABEL = {"color": "#6b7280", "fontSize": "0.85rem"}

# ── Data Entry Tab ──────────────────────────────────────────────────
entry_tab = html.Div([
    html.Div([
        dbc.Label("Date", style=LABEL),
        dbc.Input(id="input-date", type="date", value=date.today().isoformat(),
                  className="mb-3",
                  style={**INPUT_STYLE, "fontSize": "1rem", "height": "2.8rem"}),

        dbc.Row([
            dbc.Col([
                dbc.Label("Weight (lbs)", style=LABEL),
                dbc.Input(id="input-weight", type="number", step=0.1,
                          inputMode="decimal", style=INPUT_STYLE),
            ], xs=6),
            dbc.Col([
                dbc.Label("Fat %", style=LABEL),
                dbc.Input(id="input-fat", type="number", step=0.1,
                          inputMode="decimal", style=INPUT_STYLE),
            ], xs=6),
        ], className="mb-3"),

        html.Button("Save", id="btn-submit",
                     style={"width": "100%", "height": "3rem", "fontSize": "1rem",
                            "fontWeight": "500", "border": "1px solid #d1d5db",
                            "borderRadius": "8px",
                            "backgroundColor": "#f3f4f6", "color": "#111827",
                            "cursor": "pointer"}),
        html.Div(id="submit-feedback", className="mt-2"),
    ], style={**CARD, "padding": "20px", "marginBottom": "12px"}),

    html.Div([
        html.Div("Recent", style={"fontSize": "0.9rem", "fontWeight": "500",
                                    "color": "#6b7280", "marginBottom": "10px"}),
        html.Div(id="recent-entries"),
    ], style={**CARD, "padding": "16px"}),
], style={"padding": "12px 0"})


# ── Dashboard Tab ───────────────────────────────────────────────────
dashboard_tab = html.Div([
    # Date range slider
    html.Div([
        html.Div(id="slider-label",
                 style={"textAlign": "center", "fontSize": "0.85rem",
                        "color": "#6b7280", "marginBottom": "4px"}),
        dcc.Slider(
            id="range-slider",
            min=0,
            max=_total_months,
            value=_total_months - 12,  # default: start 1 year ago
            marks=_slider_marks,
            step=1,
            included=False,
        ),
    ], style={**CARD, "padding": "18px 14px 10px", "marginBottom": "10px"}),

    # Weight
    html.Div([
        dcc.Graph(id="weight-chart", config=GRAPH_CFG),
    ], style={**CARD, "padding": "6px 8px 2px", "marginBottom": "10px"}),

    # Muscle & Fat
    html.Div([
        dcc.Graph(id="fat-muscle-chart", config=GRAPH_CFG),
    ], style={**CARD, "padding": "6px 8px 2px", "marginBottom": "10px"}),

    # Path
    html.Div([
        dcc.Graph(id="path-chart", config=GRAPH_CFG),
    ], style={**CARD, "padding": "6px 8px 2px"}),
], style={"padding": "12px 0"})


# ── Layout ──────────────────────────────────────────────────────────
app.layout = html.Div([
    dbc.Tabs([
        dbc.Tab(entry_tab, label="Log", tab_id="tab-entry",
                tab_style={"marginLeft": "4px"},
                label_style={"fontSize": "0.9rem", "fontWeight": "500", "color": "#111827"}),
        dbc.Tab(dashboard_tab, label="Charts", tab_id="tab-dash",
                label_style={"fontSize": "0.9rem", "fontWeight": "500", "color": "#111827"}),
    ], id="tabs", active_tab="tab-entry"),
], style={**BODY, "maxWidth": "600px", "margin": "0 auto", "padding": "0 10px"})


# ── Helpers ─────────────────────────────────────────────────────────
def _slider_to_since(slider_val):
    """Convert slider value (months from earliest) to a since date."""
    if slider_val <= 0:
        return None  # all data
    since = date(_earliest.year + ((_earliest.month - 1 + slider_val) // 12),
                 (_earliest.month - 1 + slider_val) % 12 + 1, 1)
    return min(since, date.today())


# ── Callbacks ───────────────────────────────────────────────────────

@callback(
    Output("slider-label", "children"),
    Input("range-slider", "drag_value"),
    Input("range-slider", "value"),
)
def update_slider_label(drag_val, val):
    v = drag_val if drag_val is not None else val
    if v is None or v <= 0:
        return f"From {_earliest.strftime('%Y-%m')} (all)"
    s = _slider_to_since(v)
    return f"From {s.strftime('%Y-%m')}"


@callback(
    Output("submit-feedback", "children"),
    Output("recent-entries", "children"),
    Output("input-weight", "value"),
    Output("input-fat", "value"),
    Input("btn-submit", "n_clicks"),
    State("input-date", "value"),
    State("input-weight", "value"),
    State("input-fat", "value"),
    prevent_initial_call=True,
)
def submit_measurement(n_clicks, dt_str, weight, fat):
    if not weight:
        return (html.Div("Weight is required.", style={"color": "#b45309", "fontSize": "0.85rem"}),
                no_update, no_update, no_update)
    dt = date.fromisoformat(dt_str) if dt_str else date.today()
    fat_val = float(fat) if fat else None
    models.add_measurement(dt, float(weight), fat_val)
    charts.invalidate_cache()
    fat_str = f", {fat}% fat" if fat else ""
    return (html.Div(f"Saved {dt.strftime('%b %d')} — {weight} lbs{fat_str}",
                     style={"color": "#059669", "fontSize": "0.85rem"}),
            _recent_entries_table(), None, None)


@callback(
    Output("recent-entries", "children", allow_duplicate=True),
    Input("tabs", "active_tab"),
    prevent_initial_call="initial_duplicate",
)
def load_recent(tab):
    if tab != "tab-entry":
        return no_update
    return _recent_entries_table()


def _recent_entries_table():
    recent = models.get_recent_measurements(7)
    if not recent:
        return html.Div("No entries yet.", style={"color": "#9ca3af", "fontSize": "0.85rem"})

    header = html.Div([
        html.Span("Date", style={"flex": "1"}),
        html.Span("Weight", style={"flex": "1", "textAlign": "right"}),
        html.Span("Fat%", style={"flex": "1", "textAlign": "right"}),
    ], style={"display": "flex", "color": "#9ca3af", "fontSize": "0.75rem",
              "paddingBottom": "6px", "borderBottom": "1px solid #f0f0f0"})

    rows = []
    for r in recent:
        fat_str = f"{r['fat_percent']:.1f}" if r["fat_percent"] else "—"
        rows.append(html.Div([
            html.Span(r["date"], style={"flex": "1", "fontSize": "0.85rem"}),
            html.Span(f"{r['weight']:.1f}", style={"flex": "1", "textAlign": "right", "fontSize": "0.85rem"}),
            html.Span(fat_str, style={"flex": "1", "textAlign": "right", "fontSize": "0.85rem"}),
        ], style={"display": "flex", "color": "#374151", "padding": "5px 0",
                  "borderBottom": "1px solid #f9fafb"}))

    return html.Div([header] + rows)


@callback(
    Output("weight-chart", "figure"),
    Input("range-slider", "value"),
    Input("tabs", "active_tab"),
)
def update_weight(months, tab):
    if tab != "tab-dash":
        return no_update
    try:
        return charts.weight_trends_chart(since=_slider_to_since(months))
    except Exception:
        return go.Figure()


@callback(
    Output("fat-muscle-chart", "figure"),
    Input("range-slider", "value"),
    Input("tabs", "active_tab"),
)
def update_fat_muscle(months, tab):
    if tab != "tab-dash":
        return no_update
    try:
        return charts.fat_muscle_mass_chart(since=_slider_to_since(months))
    except Exception as e:
        return go.Figure().update_layout(title=f"Error: {e}")


@callback(
    Output("path-chart", "figure"),
    Input("range-slider", "value"),
    Input("tabs", "active_tab"),
)
def update_path(months, tab):
    if tab != "tab-dash":
        return no_update
    try:
        return charts.body_comp_path_chart(since=_slider_to_since(months))
    except Exception as e:
        return go.Figure().update_layout(title=f"Error: {e}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8050))
    debug = os.environ.get("DASH_DEBUG", "true").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
