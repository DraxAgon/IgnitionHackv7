// Panels.jsx — the one panel that matters, plus the hidden settings popover.
//
// The rule that shaped this file: if a sentence only explains the method, it
// belongs in the report, not on screen. A buyer looking at this has one question
// — is this baseline worth what I am about to pay for it — and every line that
// does not move them toward an answer is competing with the lines that do.
//
// So the panel is seven blocks in a fixed order: who and where, the verdict in
// one sentence, the three figures behind it, the year-by-year evidence, the
// money exposed, who signed it off, and the report. Method, provenance and
// matching criteria live behind one collapsed row.

import { useEffect, useMemo, useRef, useState } from "react";
import { CELLS } from "./cells.js";
import { PROJECTS } from "./projects.js";
import { caseStudyFor } from "./caseStudies.js";
import {
  ACTORS, ROLE_LABEL, actorById, buildLedger, purchaseRows, noteForRole, partiesFor, verifierRecord,
} from "./actors.js";
import {
  COVARIATES, WINDOW, REFERENCE_PERIOD, matchControls, counterfactual,
  auditBaseline, divergenceTimeline, lossFraction,
} from "./baseline.js";
// Shared with the exported report, so a reader checking the PDF against this
// screen is comparing the same roundings rather than two of them.
import { pct, pts, compact, money, full } from "./format.js";

/** Run the audit for a project. Pure and instant — the delay in the UI is
 *  theatre for the viewer's benefit, not computation. */
export function auditFor(project) {
  // Match at parcel resolution — the controls are one-degree parcels, so the
  // target must be one too. Observed loss comes from the project's own footprint.
  const host = CELLS.find((c) => c.id === project.hostCellId) ?? project.parcel;
  const { matches, considered } = matchControls(host, CELLS);
  const cf = counterfactual(matches);
  const audit = auditBaseline(project, cf);
  const timeline = divergenceTimeline(project, matches);
  const observedInside = lossFraction(project.parcel, WINDOW[0], WINDOW[1]);
  return { host, matches, considered, cf, audit, timeline, observedInside };
}

/** The audit for any project, by id — used for a verifier's whole portfolio. */
const auditById = (projectId) => {
  const p = PROJECTS.find((x) => x.id === projectId);
  return p ? auditFor(p).audit : null;
};

/* ── the verification sequence ───────────────────────────────────────────── */
function Verification({ result, phase, ticked }) {
  if (phase !== "running") return null;
  return (
    <div className="sec">
      <div className="sec-title">Matching on pre-window characteristics</div>
      {COVARIATES.map((cv, i) => (
        <div key={cv.key} className={`check${ticked > i ? " on" : ""}`}>
          <span className="check-box">{ticked > i ? "✓" : ""}</span>
          {cv.label}
        </div>
      ))}
    </div>
  );
}

/* ── results ─────────────────────────────────────────────────────────────── */
function Results({ project, result, year, snapshotMap }) {
  const { audit, cf, timeline, observedInside } = result;
  const study = caseStudyFor(project.id);
  const parties = partiesFor(project.id);
  const [showMethod, setShowMethod] = useState(false);

  // The verdict, in the units a buyer transacts in. This is the largest text in
  // the panel because it is the only sentence most readers will finish.
  const verdict = audit.creditsUnsupported > 0
    ? `${compact(audit.creditsUnsupported)} of ${compact(audit.creditsIssued)} credits are not supported by satellite evidence.`
    : `The claimed baseline is consistent with what comparable land actually did.`;

  const ledger = useMemo(
    () => buildLedger(project, timeline.firstFlagYear),
    [project.id, timeline.firstFlagYear]
  );
  const record = useMemo(
    () => (parties ? verifierRecord(parties.verifier, auditById) : null),
    [project.id]
  );

  // Year-by-year, truncated at the year the map is showing, so the panel and the
  // map are never telling the viewer about different points in time.
  const rows = timeline.rows.filter((r) => r.year <= year);
  const scale = Math.max(...timeline.rows.map((r) => Math.max(r.claimed, r.observed))) * 1.1 || 1;

  return (
    <>
      {/* 2 — the verdict */}
      <div className="sec">
        <div className="verdict" style={{ color: audit.band.color }}>{verdict}</div>
        <div className="verdict-sub">
          Over {WINDOW[0]}–{WINDOW[1]}, measured against {cf.n} comparable unprotected parcels.
        </div>
      </div>

      {/* 3 — the three figures the verdict rests on */}
      <div className="sec">
        <div className="figures">
          <div className="figure">
            <div className="figure-k">Project's baseline</div>
            <div className="figure-v" style={{ color: "var(--loss)" }}>{pct(audit.claimed)}</div>
          </div>
          <div className="figure">
            <div className="figure-k">Independent estimate</div>
            <div className="figure-v" style={{ color: "var(--control-ink)" }}>{pct(audit.independent)}</div>
          </div>
          <div className="figure">
            <div className="figure-k">Discrepancy</div>
            <div className="figure-v" style={{ color: audit.band.color }}>{pts(audit.discrepancyPts)}</div>
          </div>
        </div>
        <div className="notice" style={{ marginTop: 10 }}>
          Predicted loss without the project, against what {cf.n} comparable parcels actually lost.
          The project's own area lost {pct(observedInside)}.
        </div>
      </div>

      {/* 4 — the evidence, year by year */}
      <div className="sec">
        <div className="sec-title">Claimed pace against comparable land</div>
        {rows.map((r) => (
          <div className="tl-row" key={r.year}>
            <span className="tl-year">{r.year}</span>
            <span className="tl-bars">
              <i style={{ top: 1, width: `${(r.claimed / scale) * 100}%`, background: "var(--loss)", opacity: 0.8 }} />
              <i style={{ top: 9, width: `${(r.observed / scale) * 100}%`, background: "var(--control-ink)" }} />
            </span>
          </div>
        ))}
        <div className="notice" style={{ marginTop: 8 }}>
          <span style={{ color: "var(--loss)" }}>■</span> claimed ·{" "}
          <span style={{ color: "var(--control-ink)" }}>■</span> comparable unprotected land
        </div>
        {timeline.firstFlagYear && (
          <div className="flagbox">
            Detectable from <b>{timeline.firstFlagYear}</b> — <b>{timeline.yearsOfWarning} years</b> before
            the window closed, while credits were still being issued and retired.
          </div>
        )}
      </div>

      {/* 5 — the money */}
      <div className="sec">
        <div className="sec-title">Exposure</div>
        <div className="stats">
          <div className="stat">
            <div className="stat-k">Not supported</div>
            <div className="stat-v" style={{ color: audit.band.color }}>{compact(audit.creditsUnsupported)}</div>
          </div>
          <div className="stat">
            <div className="stat-k">At ${audit.pricePerCredit.toFixed(2)}</div>
            <div className="stat-v" style={{ color: audit.band.color }}>{money(audit.valueUnsupported)}</div>
          </div>
        </div>
        <div className="notice" style={{ marginTop: 9 }}>
          <b>{compact(audit.creditsRetired)}</b> of the {compact(audit.creditsIssued)} issued are already
          retired against buyers' targets and cannot be reversed.
        </div>
      </div>

      {/* 6 — who is involved */}
      {parties && <Parties project={project} parties={parties} record={record} ledger={ledger} audit={audit} />}

      {/* 7 — the report */}
      <ExportReport project={project} result={result} year={year} record={record} snapshotMap={snapshotMap} />

      {study && <CaseStudy study={study} />}

      {/* everything methodological, behind one row */}
      <div className="sec">
        <button className="disclose" aria-expanded={showMethod} onClick={() => setShowMethod((v) => !v)}>
          <span>How we measured this</span>
          <span className="disclose-mark">{showMethod ? "−" : "+"}</span>
        </button>
        {showMethod && (
          <div className="notice" style={{ marginTop: 10 }}>
            The project's parcel is described by {COVARIATES.length} characteristics measured over{" "}
            {REFERENCE_PERIOD[0]}–{REFERENCE_PERIOD[1]}, before the crediting window opened, so nothing
            about the outcome can leak into the comparison. Unprotected parcels resembling it are then
            observed over {WINDOW[0]}–{WINDOW[1]}. {result.matches.length} matched from {result.considered}{" "}
            candidates; parcels within 1.5° are excluded so displaced clearing cannot flatter the result.
            <br /><br />
            Deforestation is INPE PRODES, the official Brazilian Amazon record. This is a screening
            estimate from public data, not an audit and not a determination about any party.
          </div>
        )}
      </div>
    </>
  );
}

/* ── the parties, and the paper trail ────────────────────────────────────── */
function Parties({ project, parties, record, ledger, audit }) {
  const [open, setOpen] = useState(false);
  const dev = actorById(parties.developer);
  const vvb = actorById(parties.verifier);
  const reg = actorById(parties.registry);
  const buys = purchaseRows(project);
  const boughtCredits = buys.reduce((t, r) => t + r.credits, 0);
  const boughtValue = buys.reduce((t, r) => t + r.priceUsd, 0);

  const Row = ({ actor, role, extra }) => (
    <div className="party">
      <div className="party-role">{ROLE_LABEL[role]}</div>
      <div className="party-name">{actor.name}</div>
      {extra && <div className="party-extra">{extra}</div>}
    </div>
  );

  return (
    <div className="sec">
      <div className="sec-title">Who signed this off</div>
      <Row actor={dev} role="developer" extra={`${dev.country} · wrote the baseline and sells the credits`} />
      <Row
        actor={vvb}
        role="verifier"
        extra={
          record
            ? `${vvb.country} · engaged and paid by the developer · signed off ${record.projects} projects here, averaging ${pts(record.meanDiscrepancyPts)} discrepancy`
            : `${vvb.country} · engaged and paid by the developer`
        }
      />
      <Row actor={reg} role="registry" extra={`${reg.country} · holds the retirement record`} />

      {/* Who bought them, not just how many were sold here. A region cannot be
          asked what diligence it did; a company can, and this is the only row
          on the screen a buyer can act on. */}
      <div className="sec-title" style={{ marginTop: 13 }}>Credit purchases</div>
      <div className="buys">
        {buys.map(({ actor, credits, region, priceUsd }) => (
          <div className="buy" key={actor.id}>
            <div className="buy-line">
              <b>{actor.name}</b> purchased {full(credits)} credits in {region}.
            </div>
            <div className="buy-meta">
              {actor.country} · {money(priceUsd)} · retired<i className="lock" aria-label="irreversible" />
            </div>
          </div>
        ))}
        <div className="buy-total">
          <span>
            {buys.length} {buys.length === 1 ? "company" : "companies"} · {full(boughtCredits)} credits
            {buys.length > 0 && ` in ${buys[0].region}`}
          </span>
          <b>{money(boughtValue)}</b>
        </div>
      </div>

      <button className="disclose" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{ marginTop: 10 }}>
        <span>Credit history</span>
        <span className="disclose-mark">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="ledger">
          {ledger.map((e, i) => {
            const actor = e.actorId ? actorById(e.actorId) : null;
            const flag = e.type === "phantom_flag";
            return (
              <div className={`ledger-row${flag ? " is-flag" : ""}`} key={`${e.date}-${i}`}>
                <span className="ledger-date">{e.date}</span>
                <span className="ledger-body">
                  <span className="ledger-label">
                    {e.label}
                    {e.type === "retirement" && <i className="lock" aria-label="irreversible" />}
                  </span>
                  {actor && <span className="ledger-actor">{actor.name}</span>}
                  {e.credits != null && (
                    <span className="ledger-credits">
                      {compact(e.credits)}
                      {e.region ? ` credits in ${e.region}` : ""}
                      {e.vintage ? ` · vintage ${e.vintage}` : ""}
                      {e.priceUsd ? ` · ${money(e.priceUsd)}` : ""}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="notice" style={{ marginTop: 9 }}>
        Company names on this screen are illustrative and describe no real party. The forest
        measured under and around the project is real.
      </div>
    </div>
  );
}

/* ── the report, as a file ───────────────────────────────────────────────── */
/**
 * A button that cannot produce a file is worse than no button, so this one says
 * which file it produced — and says so when it produced none.
 *
 * The map goes in as it is framed at the moment of the click, not re-rendered
 * to some canonical view: the export is meant to be the report the reader is
 * looking at, including where they had put the camera and which year they had
 * scrubbed to.
 */
function ExportReport({ project, result, year, record, snapshotMap }) {
  const [state, setState] = useState({ phase: "idle" });

  async function download() {
    setState({ phase: "working" });
    try {
      // jsPDF is the biggest dependency here and most sessions never export, so
      // the module is fetched on the click rather than at first paint.
      const { downloadReport } = await import("./report.js");
      const name = await downloadReport({
        project,
        result,
        year,
        record,
        mapImage: snapshotMap?.() ?? null,
      });
      setState({ phase: "done", name });
    } catch (err) {
      console.error("report export failed", err);
      setState({ phase: "failed" });
    }
  }

  return (
    <div className="sec">
      <div className="sec-title">Report</div>
      <button className="btn" onClick={download} disabled={state.phase === "working"}>
        {state.phase === "working" ? <><i className="spin" /> building report</> : "Download PDF"}
      </button>
      <div className="notice" style={{ marginTop: 9 }}>
        {state.phase === "done" ? (
          <>Saved as <b className="mono">{state.name}</b></>
        ) : state.phase === "failed" ? (
          "The report could not be built, and nothing was saved. The figures on this screen are unaffected."
        ) : (
          <>
            The verdict, the three figures, the year-by-year evidence, the map as it is framed right
            now, and who bought the credits — as one file to send on.
          </>
        )}
      </div>
    </div>
  );
}

function CaseStudy({ study }) {
  return (
    <div className="sec">
      <div className="sec-title">Case study</div>
      <div className="p-name" style={{ fontSize: 15 }}>{study.headline}</div>
      <p className="notice" style={{ marginTop: 7, fontSize: 12.5, color: "var(--ink-2)" }}>{study.standfirst}</p>
      {study.sources?.length > 0 && (
        <div className="notice" style={{ marginTop: 12 }}>
          Sources:{" "}
          {study.sources.map((s, i) => (
            <span key={s.id}>
              {i > 0 && " · "}
              <a href={s.url} target="_blank" rel="noreferrer">{s.publisher}</a>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── the panel ───────────────────────────────────────────────────────────── */
export function ProjectPanel({ id, year, onClose, onVerified, snapshotMap }) {
  const project = PROJECTS.find((p) => p.id === id);
  const result = useMemo(() => auditFor(project), [id]);
  const [phase, setPhase] = useState("idle");
  const [ticked, setTicked] = useState(0);
  const timers = useRef([]);

  useEffect(() => {
    setPhase("idle");
    setTicked(0);
    onVerified(null);
    return () => timers.current.forEach(clearTimeout);
  }, [id]);

  // The tab title follows the selection, so a pinned tab says which project.
  useEffect(() => {
    document.title = project ? `Phantom · ${project.shortName ?? project.name}` : "Phantom";
    return () => { document.title = "Phantom"; };
  }, [project]);

  function run() {
    setPhase("running");
    setTicked(0);
    timers.current.forEach(clearTimeout);
    timers.current = COVARIATES.map((_, i) => setTimeout(() => setTicked(i + 1), 160 * (i + 1)));
    timers.current.push(
      setTimeout(() => {
        setPhase("done");
        onVerified(result.matches);
      }, 160 * COVARIATES.length + 300)
    );
  }

  const { audit } = result;
  return (
    <aside className="panel side">
      <div className="side-head">
        <button className="btn btn-quiet" style={{ width: "auto", padding: "4px 9px", fontSize: 11.5 }} onClick={onClose}>
          ← all projects
        </button>
        <div className="p-name" style={{ marginTop: 9 }}>{project.name}</div>
        <div className="p-meta">{project.locality} · {project.country} · {compact(project.areaHa)} ha · start {project.startYear}</div>
        <div className="tags">
          <span className="tag" style={{ borderColor: audit.band.color + "66", color: audit.band.color }}>
            {audit.band.label} baseline risk
          </span>
        </div>
      </div>

      <div className="side-body">
        {phase !== "done" && (
          <div className="sec">
            <div className="stats">
              <div className="stat"><div className="stat-k">Credits issued</div><div className="stat-v">{compact(project.creditsIssued)}</div></div>
              <div className="stat"><div className="stat-k">Credits retired</div><div className="stat-v">{compact(project.creditsRetired)}</div></div>
            </div>
            {phase === "idle" ? (
              <>
                <button className="btn" style={{ marginTop: 14 }} onClick={run}>
                  Run independent verification
                </button>
                <div className="notice" style={{ marginTop: 9 }}>
                  Rebuilds the baseline from public satellite records and comparable unprotected forest.
                </div>
              </>
            ) : (
              <div className="btn" style={{ marginTop: 14, cursor: "default" }}>
                <i className="spin" /> searching {CELLS.length} parcels
              </div>
            )}
          </div>
        )}

        <Verification result={result} phase={phase} ticked={ticked} />
        {phase === "done" && (
          <Results project={project} result={result} year={year} snapshotMap={snapshotMap} />
        )}
      </div>
    </aside>
  );
}

/* ── list, shown when nothing is selected ────────────────────────────────── */
export function ProjectList({ onSelect }) {
  useEffect(() => { document.title = "Phantom"; }, []);
  return (
    <aside className="panel side">
      <div className="side-head">
        <div className="sec-title" style={{ marginBottom: 6 }}>Registered forest carbon projects</div>
        <div className="notice">
          Every credit rests on a prediction of what would have happened without the project — written
          by the project itself. Pick one and Phantom rebuilds that prediction from public satellite
          records and comparable unprotected forest.
        </div>
      </div>
      <div className="side-body">
        {[...PROJECTS]
          .sort((a, b) => b.claimedBaselineLoss - a.claimedBaselineLoss)
          .map((p) => (
            <button key={p.id} className="sec" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => onSelect(p.id)}>
              <div className="p-name" style={{ fontSize: 14.5 }}>{p.name}</div>
              <div className="p-meta" style={{ fontSize: 11.5 }}>
                {p.locality} · {compact(p.creditsIssued)} credits · claims {pct(p.claimedBaselineLoss, 0)} loss
              </div>
            </button>
          ))}
      </div>
    </aside>
  );
}

/* ── settings, hidden behind the gear ────────────────────────────────────── */
export function Settings({ open, layers, setLayers, onClose }) {
  if (!open) return null;
  const set = (k) => (v) => setLayers((l) => ({ ...l, [k]: v }));
  const Toggle = ({ k, label, note }) => (
    <div className="row">
      <div>
        <div className="row-label">{label}</div>
        {note && <div className="row-note">{note}</div>}
      </div>
      <button role="switch" aria-checked={layers[k]} aria-label={label} className="switch" onClick={() => set(k)(!layers[k])} />
    </div>
  );
  return (
    <div className="panel pop" role="dialog" aria-label="Map and data settings">
      <div className="sec">
        <div className="sec-title">Map</div>
        <Toggle k="labels" label="Place names" />
        <Toggle k="controls" label="Comparable parcels" note="shown after a verification runs" />
      </div>
      <div className="sec">
        <div className="sec-title">Data</div>
        <div className="notice">
          Deforestation: <a href="https://terrabrasilis.dpi.inpe.br" target="_blank" rel="noreferrer">INPE PRODES</a>,
          the official Brazilian Amazon record — annual clear-cut increments, {REFERENCE_PERIOD[0]}–{WINDOW[1]}.
          Terrain and rainfall: <a href="https://open-meteo.com" target="_blank" rel="noreferrer">Open-Meteo</a>.
          Imagery: <a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless by EOX</a>.
          Place names © CARTO, OpenStreetMap.
          <br /><br />
          Project records, company names and credit volumes in this build are illustrative and describe
          no real party. The deforestation measured under and around them is real.
        </div>
      </div>
      <div className="sec">
        <button className="btn btn-quiet" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
