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
import { caseStudyFor } from "./caseStudies.js";
import {
  ACTORS, ROLE_LABEL, actorById, buildLedger, purchaseRows, noteForRole, partiesFor, verifierRecord,
} from "./actors.js";
import {
  COVARIATES, matchControls, counterfactual,
  auditBaseline, divergenceTimeline, lossFraction, portfolioExposure,
} from "./baseline.js";
// Shared with the exported report, so a reader checking the PDF against this
// screen is comparing the same roundings rather than two of them.
import { pct, pts, compact, money, full, multiple } from "./format.js";

/** Run the audit for a project against one region's control pool and window.
 *  Pure and instant — the delay in the UI is theatre for the viewer's
 *  benefit, not computation. */
export function auditFor(project, cells, window) {
  // Match at parcel resolution — the controls are one-degree parcels, so the
  // target must be one too. Observed loss comes from the project's own footprint.
  const host = cells.find((c) => c.id === project.hostCellId) ?? project.parcel;
  const { matches, considered } = matchControls(host, cells);
  const cf = counterfactual(matches, window);
  const audit = auditBaseline(project, cf);
  const timeline = divergenceTimeline(project, matches, window);
  const observedInside = lossFraction(project.parcel, window[0], window[1]);
  return { host, matches, considered, cf, audit, timeline, observedInside };
}

/** The audit for any project in a region, by id — used for a verifier's whole portfolio. */
const auditByIdFor = (projects, cells, window) => (projectId) => {
  const p = projects.find((x) => x.id === projectId);
  return p ? auditFor(p, cells, window).audit : null;
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
function Results({ project, result, year, snapshotMap, region }) {
  const { audit, cf, timeline, observedInside } = result;
  const { PROJECTS, CELLS, REGION } = region;
  const window = REGION.window;
  const referencePeriod = REGION.referencePeriod;
  const study = caseStudyFor(project.id);
  const parties = partiesFor(project.id);
  const [showMethod, setShowMethod] = useState(false);

  // The verdict, in the units a buyer transacts in. This is the largest text in
  // the panel because it is the only sentence most readers will finish.
  const verdict = audit.creditsUnsupported > 0
    ? `The satellite record does not support ${compact(audit.creditsUnsupported)} of ${compact(audit.creditsIssued)} credits issued.`
    : `The claimed baseline is consistent with what comparable land actually did.`;
  const overstatement = multiple(audit.overstatementMultiple);

  const ledger = useMemo(
    () => buildLedger(project, timeline.firstFlagYear),
    [project.id, timeline.firstFlagYear]
  );
  const auditById = useMemo(() => auditByIdFor(PROJECTS, CELLS, window), [PROJECTS, CELLS, window]);
  const record = useMemo(
    () => (parties ? verifierRecord(parties.verifier, auditById) : null),
    [project.id, auditById]
  );


  return (
    <>
      {/* 2 — the accusation, as a number */}
      <div className="sec">
        <div className="headline-k">
          {overstatement ? "Claim overstated by" : "What the record shows"}
        </div>
        {overstatement ? (
          <div className="headline-v" style={{ color: audit.supportBand.color }}>{overstatement}</div>
        ) : (
          <div className="headline-none">No forest saved</div>
        )}
        <div className="verdict">{verdict}</div>
        <div className="verdict-sub">
          Over {window[0]}–{window[1]}, measured against {cf.n} comparable unprotected parcels.
          Flagged for field verification.
        </div>
        {timeline.firstFlagYear && (
          <div className="flagbox">
            Detectable from <b>{timeline.firstFlagYear}</b>, <b>{timeline.yearsOfWarning} years</b> before
            the window closed, while credits were still being issued and retired.
          </div>
        )}
      </div>

      {/* 3 — the subtraction the headline rests on, aligned so it adds up by eye */}
      <div className="sec">
        <div className="sec-title">How the benefit was measured</div>
        <div className="derivation">
          <div className="drv-row">
            <span className="drv-k">Comparable land lost</span>
            <span className="drv-v" style={{ color: "var(--control-ink)" }}>{pct(audit.independent, 2)}</span>
          </div>
          <div className="drv-row">
            <span className="drv-k">Project&rsquo;s own ground lost</span>
            <span className="drv-v" style={{ color: "var(--loss)" }}>−&thinsp;{pct(audit.observedInside, 2)}</span>
          </div>
          <div className="drv-row is-sum">
            <span className="drv-k">Benefit the record supports</span>
            <span className="drv-v">{pts(audit.realBenefit * 100)}</span>
          </div>
          <div className="drv-row is-claim">
            <span className="drv-k">Claimed without the project</span>
            <span className="drv-v">{pct(audit.claimed, 2)}</span>
          </div>
        </div>
      </div>

      {/* 6 — who is involved */}
      {parties && <Parties project={project} parties={parties} record={record} ledger={ledger} audit={audit} />}

      {/* 7 — the report */}
      <ExportReport
        project={project} result={result} year={year} record={record} snapshotMap={snapshotMap}
        window={window} referencePeriod={referencePeriod} sourceLabel={region.sourceLabel}
      />

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
            {referencePeriod[0]}–{referencePeriod[1]}, before the crediting window opened, so nothing
            about the outcome can leak into the comparison. Unprotected parcels resembling it are then
            observed over {window[0]}–{window[1]}. {result.matches.length} matched from {result.considered}{" "}
            candidates; parcels within 1.5° are excluded so displaced clearing cannot flatter the result.
            <br /><br />
            Deforestation is {region.sourceLabel ?? "INPE PRODES, the official Brazilian Amazon record"}.
            This is a screening estimate from public data, not an audit and not a determination about any party.
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
function ExportReport({ project, result, year, record, snapshotMap, window, referencePeriod, sourceLabel, lossLabel }) {
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
        window,
        referencePeriod,
        sourceLabel,
        lossLabel,
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
            now, and who bought the credits, as one file to send on.
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
export function ProjectPanel({ id, year, onClose, onVerified, snapshotMap, region }) {
  const { PROJECTS, CELLS, REGION } = region;
  const project = PROJECTS.find((p) => p.id === id);
  const result = useMemo(() => auditFor(project, CELLS, REGION.window), [id, CELLS, REGION.window]);
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

  return (
    <aside className="panel side">
      <div className="side-head">
        <button className="btn btn-quiet" style={{ width: "auto", padding: "4px 9px", fontSize: 11.5 }} onClick={onClose}>
          ← all projects
        </button>
        <div className="p-name" style={{ marginTop: 9 }}>{project.name}</div>
        <div className="p-meta">{project.locality} · {project.country} · {compact(project.areaHa)} ha · start {project.startYear}</div>
        <div className="tags">
          <span className="tag">
            {project.real === true ? "Real registered project" : "Illustrative project"}
          </span>
        </div>
      </div>

      <div className="side-body">
        {phase !== "done" && (
          <div className="sec">
            <div className="stats" style={project.creditsRetired == null ? { gridTemplateColumns: "1fr" } : undefined}>
              <div className="stat"><div className="stat-k">Credits issued</div><div className="stat-v">{compact(project.creditsIssued)}</div></div>
              {project.creditsRetired != null && (
                <div className="stat"><div className="stat-k">Credits retired</div><div className="stat-v">{compact(project.creditsRetired)}</div></div>
              )}
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
          <Results project={project} result={result} year={year} snapshotMap={snapshotMap} region={region} />
        )}
      </div>
    </aside>
  );
}

/* ── list, shown when nothing is selected ────────────────────────────────── */
export function ProjectList({ onSelect, region }) {
  useEffect(() => { document.title = "Phantom"; }, []);
  const { PROJECTS, CELLS, REGION } = region;

  // Every project in the region audited on the same terms, rolled into one
  // total. Computed here rather than stored, so the total can never drift from
  // the per-project figures a reader gets by opening the rows underneath it.
  const rows = useMemo(() => PROJECTS
    .map((p) => ({ p, audit: auditFor(p, CELLS, REGION.window).audit }))
    .sort((a, b) => b.audit.valueUnsupported - a.audit.valueUnsupported),
    [PROJECTS, CELLS, REGION.window]);
  const portfolio = useMemo(() => portfolioExposure(rows.map((r) => r.audit)), [rows]);

  return (
    <aside className="panel side">
      <div className="side-head">
        <div className="sec-title" style={{ marginBottom: 6 }}>Forest carbon projects</div>
        <div className="portfolio">
          <div className="portfolio-k">Unsupported across {portfolio.projects} projects</div>
          <div className="portfolio-v">{money(portfolio.valueUnsupported)}</div>
          <div className="portfolio-sub">
            {compact(portfolio.creditsUnsupported)} of {compact(portfolio.creditsIssued)} credits issued.{" "}
            {portfolio.withoutMeasurableBenefit > 0 && (
              <>{portfolio.withoutMeasurableBenefit} of them saved no forest compared with
              similar land. </>
            )}
            {portfolio.worstMultiple != null && <>Widest single overstatement {multiple(portfolio.worstMultiple)}.</>}
          </div>
        </div>
      </div>
      <div className="side-body">
        {rows.map(({ p, audit }) => (
          <button key={p.id} className="sec list-row" onClick={() => onSelect(p.id)}>
            <div className="list-row-main">
              <div className="p-name" style={{ fontSize: 14.5 }}>{p.name}</div>
              <div className="p-meta" style={{ fontSize: 11.5 }}>
                {p.real === true ? "Real registered project" : "Illustrative project"} · {p.locality} ·{" "}
                {compact(p.creditsIssued)} credits · claims {pct(p.claimedBaselineLoss, 0)} loss
              </div>
            </div>
            <div className="list-row-fig">
              <span
                className={`list-row-mult${audit.overstatementMultiple == null ? " is-text" : ""}`}
                style={{ color: audit.supportBand.color }}
              >
                {multiple(audit.overstatementMultiple) ?? "no forest saved"}
              </span>
              <span className="list-row-val">{money(audit.valueUnsupported)}</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

/* ── settings, hidden behind the gear ────────────────────────────────────── */
export function Settings({ open, layers, setLayers, onClose, region }) {
  if (!open) return null;
  const set = (k) => (v) => setLayers((l) => ({ ...l, [k]: v }));
  const { REGION } = region;
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
        <div className="sec-title">Data: {region.sublabel}</div>
        <div className="notice">
          Deforestation:{" "}
          {region.key === "kariba" ? (
            <><a href="https://globalnaturewatch.org" target="_blank" rel="noreferrer">Global Nature Watch</a> (formerly
            Global Forest Watch), Hansen Global Forest Change: annual tree-cover loss, {REGION.referencePeriod[0]}–{REGION.window[1]}.</>
          ) : (
            <><a href="https://terrabrasilis.dpi.inpe.br" target="_blank" rel="noreferrer">INPE PRODES</a>,
            the official Brazilian Amazon record: annual clear-cut increments, {REGION.referencePeriod[0]}–{REGION.window[1]}.</>
          )}{" "}
          Terrain and rainfall: <a href="https://open-meteo.com" target="_blank" rel="noreferrer">Open-Meteo</a>.
          Imagery: <a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless by EOX</a>.
          Place names © CARTO, OpenStreetMap.
          <br /><br />
          {region.key === "kariba" ? (
            "Kariba REDD+ is a real, registered project. See the case study below for sourced facts " +
            "about its registry status and Verra's findings. Its boundary is an approximation; see the case study."
          ) : (
            "Project records, company names and credit volumes in this build are illustrative and describe " +
            "no real party. The deforestation measured under and around them is real."
          )}
        </div>
      </div>
      <div className="sec">
        <button className="btn btn-quiet" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
