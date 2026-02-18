"""Plotly chart builders for body composition dashboard."""

import pandas as pd
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from datetime import date, timedelta
from calibration import apply_calibration
from models import get_measurements

FONT = dict(family="Inter, -apple-system, sans-serif", color="#1f2937", size=12)

BASE_LAYOUT = dict(
    template="plotly_white",
    paper_bgcolor="white",
    plot_bgcolor="white",
    font=FONT,
    xaxis=dict(showgrid=False, zeroline=False, linecolor="#e5e7eb", linewidth=1),
    yaxis=dict(showgrid=False, zeroline=False, linecolor="#e5e7eb", linewidth=1),
    margin=dict(l=48, r=16, t=8, b=28),
    showlegend=False,
)

# Turbo — maximizes perceptual distinguishability across the full range
# Dark blue → cyan → green → yellow → orange → red
COLORSCALE = [
    [0.0, "#30123b"], [0.1, "#4662d7"], [0.2, "#36aaf9"],
    [0.3, "#1ae4b6"], [0.4, "#72fe5e"], [0.5, "#c8ef34"],
    [0.6, "#faba39"], [0.7, "#f66b19"], [0.8, "#e11f0c"],
    [0.9, "#a2023a"], [1.0, "#7a0403"],
]

# White background for hover tooltips (no color swatch)
HOVERLABEL = dict(bgcolor="white", font_size=12, font_family=FONT["family"])


def _load_calibrated_data(since: date = None) -> pd.DataFrame:
    rows = get_measurements(since=since)
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    return apply_calibration(df)


def _all_data_cached():
    if not hasattr(_all_data_cached, "_df") or _all_data_cached._df is None:
        _all_data_cached._df = _load_calibrated_data()
    return _all_data_cached._df


def _smooth(x_dates, y, window_days=90, std_days=20):
    """Resample to daily, then Gaussian-weighted rolling mean.

    Gaussian weighting emphasises the centre of the window and tapers
    smoothly — much less jagged than a flat box, and handles sparse
    regions gracefully because the interpolated fill gets down-weighted
    at the edges.
    """
    mask = np.isfinite(y)
    if mask.sum() < 3:
        return x_dates[mask], y[mask]
    s = pd.Series(y[mask], index=pd.DatetimeIndex(x_dates[mask]))
    s = s.sort_index()
    s = s.groupby(s.index).mean()
    daily = s.resample("D").interpolate(method="linear")
    smoothed = daily.rolling(
        window_days, min_periods=1, center=True, win_type="gaussian",
    ).mean(std=std_days)
    return smoothed.index.values, smoothed.values


def invalidate_cache():
    _all_data_cached._df = None


# ── 1. Weight ───────────────────────────────────────────────────────
def weight_trends_chart(since: date = None) -> go.Figure:
    df = _load_calibrated_data(since=since)
    if df.empty:
        return go.Figure().update_layout(**BASE_LAYOUT)

    n_days = (df["date"].max() - df["date"].min()).days
    pt_size = 12 if n_days < 500 else 8

    fp = df["fat_percent"].dropna()
    cmin = float(fp.min()) if not fp.empty else 10
    cmax = float(fp.max()) if not fp.empty else 25
    fig = go.Figure()

    fig.add_trace(go.Scatter(
        x=df["date"], y=df["weight"], mode="markers",
        marker=dict(
            size=pt_size, color=df["fat_percent"],
            colorscale=COLORSCALE, cmin=cmin, cmax=cmax,
            colorbar=dict(title=dict(text="% Fat", font=dict(size=12)),
                          thickness=16, len=0.6, tickfont=dict(size=11)),
            line=dict(width=0.5, color="white"),
        ),
        hovertemplate="<b>%{x|%b %d, %Y}</b><br>%{y:.1f} pounds, %{marker.color:.1f}% fat<extra></extra>",
        hoverlabel=HOVERLABEL,
    ))

    sort_idx = df["date"].argsort()
    x_s, y_s = _smooth(df["date"].values[sort_idx], df["weight"].values[sort_idx])
    fig.add_trace(go.Scatter(
        x=x_s, y=y_s, mode="lines",
        line=dict(color="black", width=1.5),
        hoverinfo="skip",
    ))

    fig.update_layout(height=300, **BASE_LAYOUT)
    return fig


# ── 2. Fat & muscle mass ──────────────────────────────────────────
def fat_muscle_mass_chart(since: date = None) -> go.Figure:
    df = _load_calibrated_data(since=since)
    df = df.dropna(subset=["fat_lbs", "muscle_lbs"])
    if df.empty:
        return go.Figure().update_layout(**BASE_LAYOUT)

    fig = make_subplots(
        rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.10,
        subplot_titles=("Muscle", "Fat"),
    )

    sort_idx = df["date"].argsort()
    dates_s = df["date"].values[sort_idx]

    fig.add_trace(go.Scatter(
        x=df["date"], y=df["muscle_lbs"], mode="markers",
        marker=dict(size=9, color="slateblue", opacity=1,
                    line=dict(width=0.5, color="white")),
        hovertemplate="<b>%{x|%b %d, %Y}</b><br>%{y:.1f} pounds<extra></extra>",
        hoverlabel=HOVERLABEL,
        showlegend=False,
    ), row=1, col=1)
    x_m, y_m = _smooth(dates_s, df["muscle_lbs"].values[sort_idx])
    fig.add_trace(go.Scatter(
        x=x_m, y=y_m, mode="lines",
        line=dict(color="black", width=1.5),
        hoverinfo="skip", showlegend=False,
    ), row=1, col=1)

    fig.add_trace(go.Scatter(
        x=df["date"], y=df["fat_lbs"], mode="markers",
        marker=dict(size=9, color="slateblue", opacity=1,
                    line=dict(width=0.5, color="white")),
        hovertemplate="<b>%{x|%b %d, %Y}</b><br>%{y:.1f} pounds<extra></extra>",
        hoverlabel=HOVERLABEL,
        showlegend=False,
    ), row=2, col=1)
    x_f, y_f = _smooth(dates_s, df["fat_lbs"].values[sort_idx])
    fig.add_trace(go.Scatter(
        x=x_f, y=y_f, mode="lines",
        line=dict(color="black", width=1.5),
        hoverinfo="skip", showlegend=False,
    ), row=2, col=1)

    for row, col_name in [(1, "muscle_lbs"), (2, "fat_lbs")]:
        vals = df[col_name]
        pad = (vals.max() - vals.min()) * 0.08
        fig.update_yaxes(
            range=[vals.min() - pad, vals.max() + pad],
            title_text="pounds", title_font_size=11,
            showgrid=False, zeroline=False, linecolor="#e5e7eb", linewidth=1,
            row=row, col=1,
        )
    fig.update_xaxes(showgrid=False, zeroline=False, linecolor="#e5e7eb", linewidth=1)

    fig.update_layout(
        height=600,
        template="plotly_white", paper_bgcolor="white", plot_bgcolor="white",
        font=FONT, margin=dict(l=48, r=16, t=20, b=28), showlegend=False,
    )
    for ann in fig.layout.annotations:
        ann.font = dict(size=12, color="#6b7280")
    return fig


# ── 3. Body composition path ──────────────────────────────────────
def body_comp_path_chart(since: date = None) -> go.Figure:
    df = _load_calibrated_data(since=since)
    df = df.dropna(subset=["fat_lbs", "muscle_lbs"])
    if df.empty:
        return go.Figure().update_layout(**BASE_LAYOUT)

    # Aggregate to quarters
    df["quarter"] = df["date"].dt.to_period("Q").dt.to_timestamp()
    quarterly = df.groupby("quarter").agg(
        fat=("fat_lbs", "mean"), muscle=("muscle_lbs", "mean"),
    ).reset_index()

    fig = go.Figure()

    if len(quarterly) >= 2:
        for i in range(len(quarterly) - 1):
            q0 = quarterly.iloc[i]
            q1 = quarterly.iloc[i + 1]
            dx = q1["muscle"] - q0["muscle"]
            dy = q1["fat"] - q0["fat"]
            mag = np.sqrt(dx**2 + dy**2)
            if mag < 0.01:
                continue

            fig.add_annotation(
                x=q1["muscle"], y=q1["fat"],
                ax=q0["muscle"], ay=q0["fat"],
                xref="x", yref="y", axref="x", ayref="y",
                showarrow=True,
                arrowhead=2, arrowsize=0.7, arrowwidth=1.5,
                arrowcolor="black",
            )

            # Hover at midpoint: YYYY-QN and net changes
            mx = (q0["muscle"] + q1["muscle"]) / 2
            my = (q0["fat"] + q1["fat"]) / 2
            q_label = f"{q1['quarter'].year}-Q{q1['quarter'].quarter}"
            sign_m = "+" if dx >= 0 else ""
            sign_f = "+" if dy >= 0 else ""
            hover = (f"<b>{q_label}</b><br>"
                     f"Muscle: {sign_m}{dx:.1f} lbs<br>"
                     f"Fat: {sign_f}{dy:.1f} lbs<extra></extra>")
            fig.add_trace(go.Scatter(
                x=[mx], y=[my], mode="markers",
                marker=dict(size=14, opacity=0),
                hovertemplate=hover,
                hoverlabel=HOVERLABEL,
                showlegend=False,
            ))

    layout_kw = {**BASE_LAYOUT}
    layout_kw["yaxis"] = {**BASE_LAYOUT["yaxis"], "scaleanchor": "x", "scaleratio": 1}

    fig.update_layout(
        xaxis_title="Muscle (pounds)", yaxis_title="Fat (pounds)",
        height=400, **layout_kw,
    )
    return fig
