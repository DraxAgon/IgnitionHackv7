// Panels.jsx — everything that floats over the map.
import { useMemo, useState } from "react";
import { PROJECTS, COMPANIES } from "./data.js";
import { VERDICTS, verdictById, projectById, historyFor, MEASUREMENT_META, measurementFor, verdictFor } from "./verdicts.js";
import { analyzeHoldings, PRICE_PER_CREDIT, CANOPY_THRESHOLD_PCT } from "./engine.js";
import { measureZones } from "./forestData.js";
import {
  Grade, Confidence, Toggle, LossCurve, SplitBar, GRADE_COLORS, GRADE_ORDER, CONF_COLORS,
  fmtInt, fmtMoney, fmtCompact, fmtPct, fmtHa,
} from "./ui.jsx";

const { baseYear, endYear } = MEASUREMENT_META;
const pctS = (x) => (x * 100).toFixed(1);

/* ── left: layers, scrubber, filters ─────────────────────────────────────── */
export function Controls({ layers, setLayers, year, setYear, filters, setFilters, selectedId }) {
  const set = (k) => (v) => setLayers((l) => ({ ...l, [k]: v }));
  const toggleGrade = (g) =>
    setFilters((f) => ({ ...f, grades: f.grades.includes(g) ? f.grades.filter((x) => x !== g) : [...f.grades, g] }));

  return (
    <aside className="panel panel-left">
      <div className="panel-head">
        <div className="panel-title">Map layers</div>
      </div>
      <div className="panel-body">
        <div className="section">
          <Toggle label="Tree cover loss" note="UMD/Hansen, 2001–2023" checked={layers.loss} onChange={set("loss")} />
          <Toggle label="Canopy extent 2000" note={`baseline, ≥${CANOPY_THRESHOLD_PCT}% cover`} checked={layers.canopy} onChange={set("canopy")} />
          <Toggle label="Project boundaries" checked={layers.projects} onChange={set("projects")} />
          <Toggle label="Counterfactual rings" note="5–20 km, cushion excluded" checked={layers.rings} onChange={set("rings")} />
          <Toggle label="Grade markers" checked={layers.pins} onChange={set("pins")} />
        </div>

        <div className="section">
          <div className="section-title">Forest change replay</div>
          {selectedId ? (
            <>
              <Toggle label="Decoded change overlay" note="measured pixels, this project" checked={layers.change} onChange={set("change")} />
              <div style={{ marginTop: 10 }}>
                <div className="row" style={{ padding: "0 0 7px" }}>
                  <span className="row-label">Year</span>
                  <span className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{year}</span>
                </div>
                <input
                  className="range" type="range" min={baseYear} max={endYear} step={1}
                  value={year} onChange={(e) => setYear(+e.target.value)}
                  aria-label="Forest change year"
                />
                <div className="row" style={{ padding: "5px 0 0" }}>
                  <span className="row-note">{baseYear}</span>
                  <span className="row-note">{endYear}</span>
                </div>
                <div className="notice" style={{ marginTop: 9 }}>
                  Drag to replay recorded clearing. Red is loss inside the crediting window; brown was already gone before it opened.
                </div>
              </div>
            </>
          ) : (
            <div className="notice">Select a project to replay its measured forest loss year by year.</div>
          )}
        </div>

        <div className="section">
          <div className="section-title">Filter by grade</div>
          <div className="filter-row">
            {GRADE_ORDER.map((g) => (
              <button
                key={g} className="filter-btn" aria-pressed={filters.grades.includes(g)}
                onClick={() => toggleGrade(g)}
                style={filters.grades.includes(g) ? { color: GRADE_COLORS[g], borderColor: GRADE_COLORS[g] } : undefined}
              >
                {g}
              </button>
            ))}
            {filters.grades.length > 0 && (
              <button className="filter-btn" onClick={() => setFilters((f) => ({ ...f, grades: [] }))}>clear</button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ── right: ranked index ─────────────────────────────────────────────────── */
const SORTS = {
  unsupported: ["$ unsupported", (a, b) => b.verdict.dollarsUnsupported - a.verdict.dollarsUnsupported],
  additionality: ["Additionality", (a, b) => a.verdict.additionality - b.verdict.additionality],
  credits: ["Credits issued", (a, b) => b.project.creditsIssued - a.project.creditsIssued],
  name: ["Name", (a, b) => a.project.name.localeCompare(b.project.name)],
};

export function ProjectList({ onSelect, filters, setFilters, sort, setSort }) {
  const rows = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return VERDICTS.filter(
      ({ project, verdict }) =>
        (!filters.grades.length || filters.grades.includes(verdict.grade)) &&
        (!q || project.name.toLowerCase().includes(q) || project.id.toLowerCase().includes(q) || project.state.toLowerCase().includes(q))
    ).sort(SORTS[sort][1]);
  }, [filters, sort]);

  const shown = rows.reduce((s, r) => s + r.verdict.dollarsUnsupported, 0);

  return (
    <aside className="panel panel-right">
      <div className="panel-head">
        <div className="panel-title">The index</div>
        <div className="panel-h1">{rows.length} of {PROJECTS.length} projects</div>
        <div className="panel-sub">
          <span className="num" style={{ color: "var(--danger)" }}>{fmtMoney(shown)}</span> of credit value unsupported
        </div>
        <input
          className="search" style={{ marginTop: 11 }} placeholder="Search name, ID or state"
          value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
        />
        <div className="filter-row" style={{ marginTop: 9 }}>
          {Object.entries(SORTS).map(([k, [label]]) => (
            <button key={k} className="filter-btn" aria-pressed={sort === k} onClick={() => setSort(k)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="panel-body">
        <div className="list">
          {rows.map(({ project, verdict }, i) => (
            <button key={project.id} className="item" onClick={() => onSelect(project.id)}>
              <span className="item-rank">{i + 1}</span>
              <span className="item-main">
                <span className="item-name">{project.name}</span>
                <span className="item-meta">
                  {project.id} · {fmtPct(verdict.additionality, 0)} additional · {fmtCompact(verdict.dollarsUnsupported)}
                </span>
              </span>
              <Grade g={verdict.grade} />
            </button>
          ))}
          {!rows.length && <div className="panel-pad notice">No projects match those filters.</div>}
        </div>
      </div>
    </aside>
  );
}

/* ── right: the evidence ─────────────────────────────────────────────────── */
export function Detail({ id, onBack, year }) {
  const project = projectById[id];
  const verdict = verdictById[id];
  const [live, setLive] = useState(null);
  const history = useMemo(() => historyFor(id), [id]);
  const gc = GRADE_COLORS[verdict.grade];
  const c = verdict.covers;
  const flagged = !["A", "B"].includes(verdict.grade);

  async function verifyLive() {
    setLive({ status: "running", done: 0, total: 1 });
    try {
      const m = await measureZones(project, {
        zoom: MEASUREMENT_META.zoom,
        onProgress: (done, total) => setLive({ status: "running", done, total }),
      });
      const v = verdictFor(project, m);
      setLive({ status: "done", additionality: v.additionality, grade: v.grade, tiles: m.tiles, failed: m.tilesFailed });
    } catch {
      setLive({ status: "error" });
    }
  }

  const rows = [
    ["1", "project", `Forest cover · project · ${baseYear}`, `canopy pixels ÷ polygon pixels`, pctS(c.coverProjectBase) + "%"],
    ["2", "project", `Forest cover · project · ${endYear}`, `canopy pixels ÷ polygon pixels`, pctS(c.coverProjectEnd) + "%"],
    ["3", "ring", `Forest cover · ring · ${baseYear}`, `canopy pixels ÷ ring pixels`, pctS(c.coverRingBase) + "%"],
    ["4", "ring", `Forest cover · ring · ${endYear}`, `canopy pixels ÷ ring pixels`, pctS(c.coverRingEnd) + "%"],
    ["5", "project", "Loss inside the project", `(${pctS(c.coverProjectBase)} − ${pctS(c.coverProjectEnd)}) ÷ ${pctS(c.coverProjectBase)}`, pctS(verdict.lossProject) + "%"],
    ["6", "ring", "Loss in the ring", `(${pctS(c.coverRingBase)} − ${pctS(c.coverRingEnd)}) ÷ ${pctS(c.coverRingBase)}`, pctS(verdict.lossRing) + "%"],
    ["7", "both", "Actually protected", `${pctS(verdict.lossRing)} − ${pctS(verdict.lossProject)}`, pctS(verdict.actuallyProtected) + " pts"],
    ["8", "verdict", "Additionality", `${pctS(verdict.actuallyProtected)} ÷ ${pctS(project.claimedBaselineLoss)} claimed`, fmtPct(verdict.additionality)],
  ];
  const dotColor = { project: "#e7eef3", ring: "#4fa8d8", both: "#a78bfa", verdict: gc };

  return (
    <aside className="panel panel-right">
      <div className="panel-head">
        <button className="back" onClick={onBack}>← all projects</button>
        <div className="panel-h1" style={{ marginTop: 7 }}>{project.name}</div>
        <div className="panel-sub mono">
          {project.id} · {project.state} · {fmtHa(project.areaHa)}
        </div>
        <div
          className="chip" style={{
            marginTop: 10, boxShadow: "none", padding: "5px 10px",
            color: flagged ? "var(--warn)" : "var(--A)",
            borderColor: (flagged ? "#e8b931" : "#2fbf71") + "55",
            background: (flagged ? "#e8b931" : "#2fbf71") + "12",
          }}
        >
          {flagged ? "flagged for field verification" : "screening passed — no field audit triggered"}
        </div>
      </div>

      <div className="panel-body">
        <div className="section">
          <div className="verdict-top">
            <Grade g={verdict.grade} size="lg" />
            <div>
              <div className="verdict-pct" style={{ color: gc }}>{fmtPct(verdict.additionality)}</div>
              <div className="verdict-cap">additionality vs claimed baseline</div>
            </div>
          </div>
          <div className="kpis">
            <div className="kpi"><div className="kpi-label">Credits issued</div><div className="kpi-val">{fmtInt(project.creditsIssued)}</div></div>
            <div className="kpi"><div className="kpi-label">Credits unsupported</div><div className="kpi-val" style={{ color: "var(--danger)" }}>{fmtInt(verdict.creditsUnsupported)}</div></div>
            <div className="kpi"><div className="kpi-label">Value unsupported</div><div className="kpi-val" style={{ color: "var(--danger)" }}>{fmtMoney(verdict.dollarsUnsupported)}</div></div>
            <div className="kpi"><div className="kpi-label">Confidence</div><div className="kpi-val"><Confidence level={verdict.confidence.level} /></div></div>
          </div>
        </div>

        <div className="section">
          <div className="section-title">Forest cover · project vs ring</div>
          <LossCurve series={history} windowStart={baseYear} grade={verdict.grade} year={year} />
          <div className="notice" style={{ marginTop: 7 }}>
            <span style={{ color: gc }}>──</span> inside the project ·{" "}
            <span style={{ color: "var(--accent)" }}>┄┄</span> counterfactual ring. The shaded gap is what the
            project can claim. Years before {baseYear} show whether the two were ever alike.
          </div>
        </div>

        <div className="section">
          <div className="section-title">The whole calculation</div>
          <div className="notice" style={{ marginBottom: 10 }}>
            Claim on file: <em>“without this project, {pctS(project.claimedBaselineLoss)}% of forest cover is lost
            by {endYear}.”</em> Four measurements, three subtractions, one division — no model.
          </div>
          <div className="ladder">
            {rows.map(([n, zone, label, math, out]) => (
              <div key={n} className={`lad${n === "8" ? " lad-final" : ""}`}>
                <span className="lad-n">{n}</span>
                <span className="lad-dot" style={{ background: dotColor[zone] }} />
                <span>
                  <span className="lad-label">{label}</span>
                  <span className="lad-math">{math}</span>
                </span>
                <span className="lad-out" style={{ color: n === "8" ? gc : "var(--ink)" }}>{out}</span>
              </div>
            ))}
          </div>
          <div className="money">
            {fmtInt(project.creditsIssued)} × (1 − {pctS(Math.min(Math.max(verdict.additionality, 0), 1))}%) × ${PRICE_PER_CREDIT}
            <br />= <strong style={{ color: "var(--danger)" }}>{fmtMoney(verdict.dollarsUnsupported)} unsupported</strong>
          </div>
        </div>

        <div className="section">
          <div className="section-title">Confidence · {verdict.confidence.level}</div>
          {verdict.confidence.factors.map((f) => (
            <div key={f.key} className="conf-item">
              <span className="conf-bar" style={{ background: f.penalty === 0 ? "#2a353d" : f.penalty === 1 ? "var(--warn)" : "var(--danger)" }} />
              <div style={{ flex: 1 }}>
                <div className="conf-name"><span>{f.label}</span><span className="conf-val">{f.value}</span></div>
                <div className="conf-detail">{f.detail}</div>
              </div>
            </div>
          ))}
          {verdict.confidence.level === "low" && (
            <div className="money" style={{ background: "rgba(229,72,77,.07)", fontFamily: "var(--sans)", fontSize: 12 }}>
              Low confidence means <strong>we cannot resolve this project from orbit</strong> — read the grade as
              insufficient evidence, never as misconduct.
            </div>
          )}
        </div>

        <div className="section">
          <div className="section-title">Verify</div>
          <div className="notice" style={{ marginBottom: 10 }}>
            The figures above were measured from {MEASUREMENT_META.source.split(",")[0]} on {MEASUREMENT_META.measuredAt}.
            Re-run the same read against the live tile service now.
          </div>
          <button className="btn btn-accent btn-block" onClick={verifyLive} disabled={live?.status === "running"}>
            {live?.status === "running" ? <><i className="spin" /> reading {live.done}/{live.total} tiles</> : "Re-measure from live satellite tiles"}
          </button>
          {live?.status === "done" && (
            <div className="money" style={{ background: "rgba(47,191,113,.07)", borderColor: "rgba(47,191,113,.25)" }}>
              live: {fmtPct(live.additionality)} · grade {live.grade} · {live.tiles} tiles, {live.failed} failed
              <br />
              bundled: {fmtPct(verdict.additionality)} · grade {verdict.grade}
              <br />
              <strong style={{ color: Math.abs(live.additionality - verdict.additionality) < 0.005 ? "var(--A)" : "var(--warn)" }}>
                {Math.abs(live.additionality - verdict.additionality) < 0.005 ? "match" : "differs — tile service updated"}
              </strong>
            </div>
          )}
          {live?.status === "error" && <div className="notice" style={{ marginTop: 8, color: "var(--danger)" }}>Live read failed — offline or the tile service is unreachable.</div>}
        </div>
      </div>
    </aside>
  );
}

/* ── right: buyers ───────────────────────────────────────────────────────── */
export function Buyers({ onSelect }) {
  const [companyId, setCompanyId] = useState(COMPANIES[0].id);
  const company = COMPANIES.find((c) => c.id === companyId);
  const result = useMemo(() => analyzeHoldings(company.holdings, verdictById), [company]);
  const share = result.totalSpend ? result.totalUnsupported / result.totalSpend : 0;

  function exportFindings() {
    const payload = {
      generatedBy: "Phantom — screening index for forest carbon projects",
      disclaimer: "Projects, registry IDs and companies are fictional. Forest measurements are real: " + MEASUREMENT_META.source,
      measurementWindow: `${baseYear}-${endYear}`,
      portfolio: company.name,
      totalSpendUsd: Math.round(result.totalSpend),
      unsupportedSpendUsd: Math.round(result.totalUnsupported),
      holdings: result.rows.map((r) => ({
        projectId: r.projectId, projectName: projectById[r.projectId].name,
        grade: r.verdict.grade, additionality: +r.verdict.additionality.toFixed(4),
        confidence: r.verdict.confidence.level, credits: r.credits, pricePerCredit: r.pricePerCredit,
        spendUsd: Math.round(r.spend), unsupportedUsd: Math.round(r.unsupported),
        status: ["A", "B"].includes(r.verdict.grade) ? "screening passed" : "flagged for field verification",
      })),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    a.download = `phantom-${company.id}-audit.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <aside className="panel panel-right">
      <div className="panel-head">
        <div className="panel-title">Portfolio exposure</div>
        <div className="panel-h1">{company.name}</div>
        <div className="panel-sub">{company.sector} · {result.rows.length} projects · {fmtInt(result.totalCredits)} credits</div>
        <div className="filter-row" style={{ marginTop: 11 }}>
          {COMPANIES.map((c) => (
            <button key={c.id} className="filter-btn" aria-pressed={c.id === companyId} onClick={() => setCompanyId(c.id)}>
              {c.name.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body">
        <div className="section">
          <p className="statement">
            {company.name} spent <span className="num">{fmtMoney(result.totalSpend)}</span> on forest offsets.{" "}
            <span className="num hl-red">{fmtMoney(result.totalUnsupported)}</span> of it bought nothing the
            satellites can find.
          </p>
          <div style={{ marginTop: 13 }}><SplitBar supported={result.totalSpend - result.totalUnsupported} unsupported={result.totalUnsupported} /></div>
          <div className="row" style={{ paddingBottom: 0 }}>
            <span className="row-note">{fmtPct(1 - share)} supported</span>
            <span className="row-note" style={{ color: "var(--danger)" }}>{fmtPct(share)} unsupported</span>
          </div>
        </div>

        <table className="table">
          <thead>
            <tr><th>Project</th><th>Grade</th><th className="r">Spend · unsupported</th></tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.projectId + r.year} onClick={() => onSelect(r.projectId)}>
                <td>
                  <div>{projectById[r.projectId].name}</div>
                  <div className="item-meta">{r.projectId} · {fmtInt(r.credits)} @ ${r.pricePerCredit.toFixed(2)} · {r.year}</div>
                  <div style={{ marginTop: 6, maxWidth: 170 }}>
                    <SplitBar supported={r.supported} unsupported={r.unsupported} />
                  </div>
                </td>
                <td><Grade g={r.verdict.grade} /></td>
                <td className="r">
                  <div className="mono">{fmtCompact(r.spend)}</div>
                  <div className="mono" style={{ color: "var(--danger)", fontSize: 11.5, marginTop: 2 }}>
                    −{fmtCompact(r.unsupported)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="section">
          <button className="btn btn-accent btn-block" onClick={exportFindings}>Export findings (JSON)</button>
          <div className="notice" style={{ marginTop: 9 }}>
            Unsupported spend = spend × (1 − additionality) per project, additionality clamped to 0–100%.
            Companies and purchase records are fictional; the grades behind them are measured.
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ── bottom: legend ──────────────────────────────────────────────────────── */
export function Legend({ selectedId }) {
  return (
    <div className="legend">
      <span className="legend-cap">Grade</span>
      <span className="grade-ramp">
        {GRADE_ORDER.map((g) => (
          <span key={g} style={{ color: GRADE_COLORS[g], background: GRADE_COLORS[g] + "1c", border: `1px solid ${GRADE_COLORS[g]}55` }}>{g}</span>
        ))}
      </span>
      <span className="legend-group"><i className="swatch" style={{ background: "#e5484d" }} />tree cover loss</span>
      <span className="legend-group"><i className="swatch" style={{ background: "#4fa8d8", opacity: 0.5 }} />counterfactual ring</span>
      <span className="legend-group"><i className="swatch" style={{ background: "#93a4b0", opacity: 0.35 }} />5 km cushion (excluded)</span>
      {selectedId && (
        <>
          <span className="legend-group"><i className="swatch" style={{ background: "rgb(31,89,58)" }} />canopy standing</span>
          <span className="legend-group"><i className="swatch" style={{ background: "linear-gradient(90deg,#e8b931,#e5484d)" }} />cleared {baseYear}–{endYear}</span>
          <span className="legend-group"><i className="swatch" style={{ background: "rgb(110,88,62)" }} />cleared before {baseYear}</span>
        </>
      )}
    </div>
  );
}
