// View-model for the dashboard charts (dimsumden-ui-v0/11). Pure: Dashboard.jsx only draws it.
// Metrics shape is ADR 0011 decision 4; every field may be missing.
const MAX_WINDOWS = 12;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

export function windowLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function tokenText(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

function makeChart({ id, title, orientation, rows, measure }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  const bars = rows.map((r) => ({
    label: r.label,
    value: r.value,
    valueText: r.valueText,
    fraction: max > 0 ? r.value / max : 0,
  }));
  const empty = bars.length === 0;
  return {
    id,
    title,
    orientation,
    empty,
    emptyText: empty ? "No data yet" : null,
    bars,
    desc: empty ? `${title}: no data yet.` : `${title} (${measure}): ${bars.map((b) => `${b.label} ${b.valueText}`).join(", ")}.`,
  };
}

const entries = (o) => (o && typeof o === "object" ? Object.entries(o) : []);

export function dashboardModel(metrics, { error = false } = {}) {
  const m = metrics && typeof metrics === "object" ? metrics : {};
  const windows = Array.isArray(m.throughput?.windows) ? m.throughput.windows.slice(-MAX_WINDOWS) : [];
  const tokenRows = entries(m.tokensByRole)
    .map(([label, v]) => ({ label, value: Number(v?.perTicket) }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => b.value - a.value)
    .map((r) => ({ ...r, valueText: tokenText(r.value) }));
  const incidentRows = entries(m.incidentsByTool)
    .map(([label, v]) => ({ label, value: Number(v?.perTicket) }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => b.value - a.value)
    .map((r) => ({ ...r, valueText: String(r.value) }));
  return {
    status: error ? "error" : "ok",
    errorText: error ? "Metrics unavailable" : null,
    retryLabel: error ? "Retry" : null,
    charts: [
      makeChart({
        id: "throughput",
        title: "Tickets resolved per 5-hour window",
        orientation: "vertical",
        measure: "tickets resolved",
        rows: windows.map((w) => ({ label: windowLabel(w.start), value: Number(w.resolved) || 0, valueText: String(Number(w.resolved) || 0) })),
      }),
      makeChart({ id: "tokens", title: "Tokens per resolved ticket by placement type", orientation: "horizontal", measure: "tokens per ticket", rows: tokenRows }),
      makeChart({ id: "incidents", title: "Incidents per ticket by tool", orientation: "horizontal", measure: "incidents per ticket", rows: incidentRows }),
    ],
  };
}
