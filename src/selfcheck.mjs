// node src/selfcheck.mjs
// Asserts the dataset and the analysis hold together. No browser, no network.
import assert from "node:assert";
import {
  COVARIATES, WINDOW, REFERENCE_PERIOD, matchControls, counterfactual, auditBaseline,
  divergenceTimeline, lossFraction, forestAt, clearedBetween, RISK_BANDS,
} from "./baseline.js";
import { CASE_STUDIES, validateCaseStudy } from "./caseStudies.js";
import { ACTORS, PARTIES, buildLedger, purchaseRows, verifierRecord } from "./actors.js";
import { PROJECTS, REGION } from "./projects.js";
// Case studies can attach to a project in any region, so validation checks
// against the union of ids — everything else below is deliberately scoped to
// the Amazon dataset alone, which is what this file was built to check.
import { PROJECTS as KARIBA_PROJECTS } from "./projects-kariba.js";
import { parcelRing } from "./geometry.js";
import { reportFileName } from "./report.js";
import {
  BUYER_LEADERBOARD, DEVELOPER_LEADERBOARD, PUBLIC_COMPANIES, validateCompanyData,
} from "./companyData.js";
import {
  REAL_COMPANIES,
  REAL_PROJECTS,
  REAL_PROJECT_ACTORS,
  CREDIT_EXPOSURES,
  PROJECT_ACTOR_RELATIONSHIPS,
  CARBON_NETWORK,
  validateCarbonNetwork,
} from "./carbonNetwork.js";
import cellsDoc from "./cells.json" with { type: "json" };

const CELLS = cellsDoc.cells;
const pct = (v) => (v * 100).toFixed(1) + "%";
const tlFlagYear = (p, matches) => divergenceTimeline(p, matches).firstFlagYear;

console.log(`source: ${cellsDoc.source}`);
console.log(`${CELLS.length} control parcels · ${cellsDoc.cellDegrees}° · ${cellsDoc.firstYear}–${cellsDoc.lastYear}`);
console.log(`covariates measured ${REFERENCE_PERIOD[0]}–${REFERENCE_PERIOD[1]}, outcomes ${WINDOW[0]}–${WINDOW[1]}\n`);

// ── the control pool is physically coherent ────────────────────────────────
assert(CELLS.length >= 150, `only ${CELLS.length} parcels — too few to match against`);
for (const c of CELLS) {
  assert(c.landKm2 > 0, `${c.id}: no land`);
  assert(c.forest2008Km2 >= 0 && c.forest2008Km2 <= c.landKm2 + 1, `${c.id}: forest exceeds land`);
  assert(c.protectedFrac >= 0 && c.protectedFrac <= 1, `${c.id}: bad protected fraction`);
  const cleared = clearedBetween(c, cellsDoc.firstYear, cellsDoc.lastYear);
  assert(cleared <= c.forest2008Km2 + 1, `${c.id}: cleared ${cleared} exceeds forest ${c.forest2008Km2}`);
  // Forest can only fall: PRODES increments are cumulative clearing.
  let prev = Infinity;
  for (let y = cellsDoc.firstYear; y <= cellsDoc.lastYear; y++) {
    const f = forestAt(c, y);
    assert(f <= prev + 1e-6, `${c.id}: forest grew in ${y}`);
    prev = f;
  }
}

// ── every project is measured, matched and audited ─────────────────────────
console.log("internal illustrative Forest Explorer project audits");
console.log("id       project                      claimed  independent  risk        controls  flagged");
const seen = new Set();
const bandsHit = new Set();
for (const p of PROJECTS) {
  assert(!seen.has(p.id), `duplicate project id ${p.id}`);
  seen.add(p.id);
  assert(p.parcel?.clearedByYear, `${p.id}: no measured footprint`);
  assert(p.claimedBaselineLoss > 0 && p.claimedBaselineLoss < 1, `${p.id}: implausible baseline`);
  assert(p.creditsRetired <= p.creditsIssued, `${p.id}: retired exceeds issued`);
  // The panel renders a parties block and a credit ledger for every project, so
  // a project the generator added but actors.js never heard of ships as a hole
  // in the panel. Fail here instead, where the fix is one line in actors.js.
  assert(PARTIES[p.id], `${p.id}: no parties in actors.js — add developer, verifier, registry and buyers`);
  assert(buildLedger(p, 2020).length > 0, `${p.id}: ledger is empty`);
  const rows = purchaseRows(p);
  assert(
    rows.reduce((s, r) => s + r.credits, 0) === p.creditsRetired,
    `${p.id}: buyer shares do not reconcile to credits retired`
  );
  // Every purchase names the company that made it and the region it was made
  // in. The panel, the map popup and the PDF all render this one sentence, so
  // a purchase that cannot produce it is a hole in all three at once.
  for (const r of rows) {
    assert(r.actor?.name, `${p.id}: a credit purchase names no purchasing company`);
    assert(r.region, `${p.id}: a credit purchase names no region`);
    assert(
      r.sentence === `${r.actor.name} purchased ${r.credits.toLocaleString("en-US")} credits in ${r.region}.`,
      `${p.id}: purchase does not read as company, volume and region`
    );
  }

  const host = CELLS.find((c) => c.id === p.hostCellId);
  assert(host, `${p.id}: host parcel ${p.hostCellId} is not in the pool`);
  const { matches, considered } = matchControls(host, CELLS);
  // Most of the Legal Amazon is protected, so the unprotected pool is small and
  // a handful of close matches is a realistic floor rather than a disappointing
  // one. Eight is the floor `tools/make-projects.mjs` selects hosts against, and
  // it is a floor on resolution: with n controls a claim can reach at most the
  // (n-1)/n percentile, so eight still lets the top band be reached by the hosts
  // ranked into it. Lower it further and the extreme claims stop registering.
  assert(matches.length >= 8, `${p.id}: only ${matches.length} controls`);
  assert(considered === CELLS.length, `${p.id}: pool size mismatch`);
  // Controls must be genuinely independent of the project.
  for (const m of matches) {
    assert(m.cell.protectedFrac <= 0.25, `${p.id}: control ${m.cell.id} is protected`);
    const d = Math.max(Math.abs(m.cell.center[0] - host.center[0]), Math.abs(m.cell.center[1] - host.center[1]));
    assert(d > 1.5, `${p.id}: control ${m.cell.id} is inside the leakage buffer`);
  }

  const cf = counterfactual(matches);
  assert(cf.p25 <= cf.median && cf.median <= cf.p75, `${p.id}: quantiles out of order`);
  const audit = auditBaseline(p, cf);
  assert(audit.creditsUnsupported >= 0 && audit.creditsUnsupported <= p.creditsIssued, `${p.id}: bad credit exposure`);
  assert(audit.percentile >= 0 && audit.percentile <= 100, `${p.id}: bad percentile`);

  // ── the additionality chain ───────────────────────────────────────────────
  // The headline figure divides by the measured benefit, so the one thing that
  // must never happen is a multiple printed from a division by zero or by a
  // negative number. `benefitMeasurable` is what stands between the two.
  assert(
    Math.abs(audit.realBenefit - (audit.independent - audit.observedInside)) < 1e-12,
    `${p.id}: benefit is not comparable-land loss minus the project's own loss`
  );
  assert(
    audit.benefitMeasurable === (audit.realBenefit > 0 && audit.claimed > 0),
    `${p.id}: benefitMeasurable disagrees with the measurement`
  );
  assert(audit.additionality >= 0 && audit.additionality <= 1, `${p.id}: additionality outside [0, 1]`);
  if (audit.benefitMeasurable) {
    assert(
      Number.isFinite(audit.overstatementMultiple) && audit.overstatementMultiple > 0,
      `${p.id}: measurable benefit but no usable multiple`
    );
    assert(
      Math.abs(audit.overstatementMultiple - audit.claimed / audit.realBenefit) < 1e-9,
      `${p.id}: multiple is not claimed over benefit`
    );
  } else {
    assert(audit.overstatementMultiple === null, `${p.id}: a multiple was printed with no benefit to divide by`);
    assert(audit.additionality === 0, `${p.id}: no measurable benefit but additionality is not zero`);
    assert(audit.creditsUnsupported === p.creditsIssued, `${p.id}: no benefit, so every issued credit is unsupported`);
  }
  assert(
    Math.abs(audit.creditsUnsupported - Math.round(p.creditsIssued * (1 - audit.additionality))) < 1,
    `${p.id}: unsupported credits are not issued x (1 - additionality)`
  );
  assert(
    Math.abs(audit.valueUnsupported - audit.creditsUnsupported * audit.pricePerCredit) < 1e-6,
    `${p.id}: unsupported value does not reconcile to credits x price`
  );
  bandsHit.add(audit.band.key);

  const tl = divergenceTimeline(p, matches);
  assert(tl.rows.length === WINDOW[1] - WINDOW[0] + 1, `${p.id}: timeline wrong length`);
  for (let i = 1; i < tl.rows.length; i++)
    assert(tl.rows[i].claimed >= tl.rows[i - 1].claimed - 1e-9, `${p.id}: claimed path decreases`);

  console.log(
    `${p.id}  ${p.shortName.padEnd(26)} ${pct(audit.claimed).padStart(7)}  ` +
      `${pct(cf.median).padStart(11)}  ${audit.band.label.padEnd(10)}  ${String(cf.n).padStart(8)}  ` +
      (tl.firstFlagYear ?? "—")
  );
}

// ── the map frames every project, and reaches every parcel ─────────────────
// Three boxes, nested, each answering a different question.
//
// `bounds` is what the overview frames, and it has to hold every project
// FOOTPRINT - not every project centre. A frame drawn to the centres crops the
// outer half of the outermost boundaries off the edge of the screen, which is
// the same bug as hiding them under the panel and harder to notice.
//
// `reach` is everything the map can draw. Comparables are matched on covariates
// rather than on distance, so any parcel in the grid can end up on screen, and
// the pan barrier is built to contain this.
//
// `maxBounds` is only the barrier before the first frame lands; MapView derives
// the real one from the overview camera. Assert it still has slack in it, and
// that it stays regional - the point of deriving it was to stop a hand-written
// box from either strangling the overview or opening onto the whole continent.
{
  const [[bw, bs], [be, bn]] = REGION.bounds;
  const [[rw, rs], [re, rn]] = REGION.reach;
  const [[mw, ms], [me, mn]] = REGION.maxBounds;

  assert(rw <= bw && rs <= bs && re >= be && rn >= bn, "REGION.reach does not contain REGION.bounds");
  assert(mw < rw && ms < rs && me > re && mn > rn, "REGION.maxBounds does not contain REGION.reach");
  assert(me - mw <= 180, "maxBounds spans half the world - this view is meant to stay regional");
  assert(REGION.slack > 0 && REGION.slack < 1, `implausible REGION.slack ${REGION.slack}`);

  for (const p of PROJECTS) {
    const [w, s2, e, n] = p.parcel.bbox;
    assert(w >= bw && e <= be && s2 >= bs && n <= bn, `${p.id} is not fully inside REGION.bounds`);
  }
  for (const c of CELLS) {
    const [w, s2, e, n] = c.bbox;
    assert(w >= rw && e <= re && s2 >= rs && n <= rn, `${c.id} sits outside REGION.reach`);
  }

  // The overview is worth framing only if it is meaningfully tighter than the
  // ground the map can reach; otherwise it is the old whole-grid frame again
  // under a new name, and the projects go back to being dots in empty forest.
  const tighter = ((re - rw) * (rn - rs)) / ((be - bw) * (bn - bs));
  assert(tighter >= 1.5, `overview frames ${tighter.toFixed(2)}x the project box - it is framing the grid again`);
  console.log(
    `map frames ${(be - bw).toFixed(0)}x${(bn - bs).toFixed(0)} degrees of projects, ` +
      `reaches ${(re - rw).toFixed(0)}x${(rn - rs).toFixed(0)} of parcels`
  );
}

// ── a drawn reference zone never claims ground it was not measured over ────
// Reference parcels are drawn with the same harmonic outline as the project
// blobs, so the map has one shape language and colour is the only thing that
// separates a project from what it is compared with. The figures behind a
// parcel are still summed over its one-degree box, so the outline is inscribed
// in that box: it may understate the measured ground, never overstate it.
for (const c of CELLS) {
  const [w, s2, e, n] = c.bbox;
  for (const [lon, lat] of parcelRing(c))
    assert(
      lon >= w - 1e-9 && lon <= e + 1e-9 && lat >= s2 - 1e-9 && lat <= n + 1e-9,
      `${c.id}: drawn outline leaves the parcel its figures were measured over`
    );
}

// ── the report names itself after the project and the day ──────────────────
{
  const day = new Date(2026, 7, 21);
  for (const p of PROJECTS) {
    const name = reportFileName(p, day);
    assert(name.endsWith("-2026-08-21.pdf"), `${p.id}: report file name carries no date (${name})`);
    assert(/^[a-z0-9-]+[.]pdf$/.test(name), `${p.id}: report file name is not filesystem-safe (${name})`);
  }
  console.log(`report exports as ${reportFileName(PROJECTS[0], day)}`);
}

// ── internal illustrative fixtures never borrow real-company names ─────────
// These actors support Forest Explorer fixtures and are not part of the public
// Companies experience. They still must not borrow real-company names.
const REAL_FIRMS = [
  "verra", "gold standard", "south pole", "kariba", "sgs", "tuv", "tüv", "der norske",
  "dnv", "bureau veritas", "aenor", "ruby canyon", "environmental services inc",
  "delta-s", "first environment", "shell", "chevron", "bp ", "total", "eni ",
  "nestl", "gucci", "volkswagen", "disney", "netflix", "salesforce", "microsoft",
  "google", "apple ", "amazon.com", "delta air", "united airlines", "easyjet",
  "lufthansa", "ryanair", "bhp", "rio tinto", "glencore", "vale ", "petrobras",
];
const actorText = JSON.stringify(ACTORS).toLowerCase();
for (const firm of REAL_FIRMS)
  assert(!actorText.includes(firm), `actors.js internal fixtures name a real firm ("${firm}")`);
assert(ACTORS.every((a) => a.name && a.role && a.country), "an actor is missing a name, role or country");
assert(new Set(ACTORS.map((a) => a.id)).size === ACTORS.length, "duplicate actor id");
for (const role of ["developer", "verifier", "registry", "buyer"])
  assert(ACTORS.some((a) => a.role === role), `no actor fills the ${role} role`);

// A verifier's record has to be computable, since the panel shows it. Scoped
// to verifiers that actually appear on an Amazon project — PARTIES is a
// single global table shared with Zimbabwe's projects (see
// projects-kariba.js), and this block's callback only knows how to look a
// project up in the Amazon's own PROJECTS/CELLS.
for (const vid of new Set(PROJECTS.map((p) => PARTIES[p.id]?.verifier).filter(Boolean))) {
  const rec = verifierRecord(vid, (pid) => {
    const proj = PROJECTS.find((x) => x.id === pid);
    const host = CELLS.find((c) => c.id === proj.hostCellId);
    return auditBaseline(proj, counterfactual(matchControls(host, CELLS).matches));
  });
  assert(rec && rec.projects > 0, `${vid}: no portfolio record`);
  assert(Number.isFinite(rec.meanDiscrepancyPts), `${vid}: mean discrepancy is not a number`);
}
console.log(`
${ACTORS.length} internal illustrative parties · fixture ledgers reconcile to the credit record`);

// ── internal illustrative portfolio fixtures still reconcile ───────────────
// These aggregates remain development coverage for the Explorer; they are not
// rendered in the real-only Companies interface.
const companyProblems = validateCompanyData();
assert(companyProblems.length === 0, `company index:\n  - ${companyProblems.join("\n  - ")}`);
assert(
  BUYER_LEADERBOARD.length === ACTORS.filter((a) => a.role === "buyer").length,
  "a buyer is missing from the leaderboard"
);
assert(
  DEVELOPER_LEADERBOARD.length === ACTORS.filter((a) => a.role === "developer").length,
  "a developer is missing from the leaderboard"
);
for (const board of [BUYER_LEADERBOARD, DEVELOPER_LEADERBOARD]) {
  assert(board.every((row, i) => row.rank === i + 1), "leaderboard ranks are not sequential");
  assert(
    board.every((row, i) => i === 0 || board[i - 1].score >= row.score),
    "leaderboard is not sorted by score"
  );
}
assert(
  PUBLIC_COMPANIES.every((company) => company.relationshipSourceIds.length > 0),
  "a real-company relationship is unsourced"
);
console.log(
  `${BUYER_LEADERBOARD.length} internal buyer fixtures · ` +
  `${DEVELOPER_LEADERBOARD.length} internal developer fixtures · ` +
  `${PUBLIC_COMPANIES.length} sourced Kariba company records`
);

// ── the public carbon network is normalized, sourced and real-only ──────────
const networkProblems = validateCarbonNetwork();
assert(networkProblems.length === 0, `carbon network:\n  - ${networkProblems.join("\n  - ")}`);

assert(REAL_COMPANIES.length === 16, "real network must contain exactly 16 sourced companies");
assert(CREDIT_EXPOSURES.length === 16, "real network must contain exactly 16 sourced exposures");
assert(REAL_PROJECTS.length === 1, "real network must contain only the sourced Kariba project");
assert(REAL_PROJECTS[0].real === true, "Kariba project is not explicitly marked real");
assert(REAL_PROJECTS[0].legacyId === "KARIBA-902", "the real network project is not Kariba VCS 902");
assert(
  !REAL_PROJECTS.some((project) => /illustrative/i.test(`${project.id} ${project.legacyId} ${project.name}`)),
  "an illustrative project leaked into the real network"
);
assert(CARBON_NETWORK.mode === "real-only", "carbon network is not explicitly real-only");

const realProject = REAL_PROJECTS[0];
assert(realProject.creditsIssued === 26822953, "Kariba issued-credit total changed");
assert(realProject.excessCreditsProjectWide === 15220520, "Kariba project-wide excess total changed");
assert(realProject.dataQuality.datedCredits === 25706781, "Kariba dated-credit total changed");
assert(realProject.dataQuality.datedRetirementRows === 6967, "Kariba dated-row total changed");
assert(realProject.dataQuality.namedBeneficiaryCredits === 12674312, "Kariba informative-beneficiary total changed");
assert(realProject.dataQuality.usableNamedRows === 982, "Kariba informative-beneficiary row total changed");
assert(realProject.informativeBeneficiaryCoveragePct === 49.30338,
  "Kariba informative-beneficiary coverage changed");
assert(realProject.noCompanyExcessAllocation === true, "company-level excess allocation caveat was removed");

const realCompanyIds = new Set(REAL_COMPANIES.map((company) => company.id));
const realProjectIds = new Set(REAL_PROJECTS.map((project) => project.id));
const realActorIds = new Set(REAL_PROJECT_ACTORS.map((actor) => actor.id));
assert(realCompanyIds.size === REAL_COMPANIES.length, "real network has duplicate company IDs");
assert(realProjectIds.size === REAL_PROJECTS.length, "real network has duplicate project IDs");
assert(realActorIds.size === REAL_PROJECT_ACTORS.length, "real network has duplicate actor IDs");

const exposurePairs = new Set();
for (const exposure of CREDIT_EXPOSURES) {
  assert(realCompanyIds.has(exposure.companyId), `${exposure.id}: company reference is invalid`);
  assert(realProjectIds.has(exposure.projectId), `${exposure.id}: project reference is invalid`);
  const pair = `${exposure.companyId}|${exposure.projectId}`;
  assert(!exposurePairs.has(pair), `${exposure.id}: duplicate company-project relationship`);
  exposurePairs.add(pair);
  assert(Object.hasOwn(exposure, "quantityKnown"), `${exposure.id}: quantity-known flag is missing`);
  assert(Object.hasOwn(exposure, "quantityExact"), `${exposure.id}: quantity-exact flag is missing`);
  assert(exposure.quantityKnown === true, `${exposure.id}: documented quantity is not marked known`);
  assert(exposure.quantityExact === true, `${exposure.id}: documented quantity is not marked exact`);
  assert(
    Number.isInteger(exposure.knownCredits) && exposure.knownCredits > 0,
    `${exposure.id}: known credits must be a positive integer`
  );
  assert(exposure.sourceIds.length > 0, `${exposure.id}: exposure is unsourced`);
  assert(
    exposure.sources.length === exposure.sourceIds.length,
    `${exposure.id}: source IDs and source objects do not reconcile`
  );
  for (const [index, sourceId] of exposure.sourceIds.entries()) {
    assert(exposure.sources[index]?.id === sourceId, `${exposure.id}: source ${sourceId} is unresolved`);
    assert(exposure.sources[index]?.url, `${exposure.id}: source ${sourceId} has no evidence link`);
  }
}

for (const relationship of PROJECT_ACTOR_RELATIONSHIPS) {
  assert(realActorIds.has(relationship.actorId), `${relationship.id}: actor reference is invalid`);
  assert(realProjectIds.has(relationship.projectId), `${relationship.id}: project reference is invalid`);
  assert(relationship.sourceIds.length > 0, `${relationship.id}: actor-project relationship is unsourced`);
  assert(
    relationship.sources.length === relationship.sourceIds.length,
    `${relationship.id}: actor-project sources do not reconcile`
  );
}

const tracedCredits = CREDIT_EXPOSURES.reduce((total, exposure) => total + exposure.knownCredits, 0);
assert(tracedCredits === 11204911, "Kariba traced-credit total changed");
assert(realProject.tracedCredits === tracedCredits, "project total does not reconcile to exposure edges");
assert(realProject.exposureCount === CREDIT_EXPOSURES.length, "project exposure count does not reconcile");

// Every invented actor name is banned from the real graph, including internal
// developer, verifier and registry fixtures as well as the buyer fixtures.
const illustrativeNames = ACTORS.map((actor) => actor.name.toLowerCase());
const publicNetworkText = JSON.stringify({
  companies: REAL_COMPANIES,
  projects: REAL_PROJECTS,
  actors: REAL_PROJECT_ACTORS,
  exposures: CREDIT_EXPOSURES,
}).toLowerCase();
for (const name of illustrativeNames)
  assert(!publicNetworkText.includes(name), `illustrative entity leaked into real network: ${name}`);

const forbiddenCompanyFields = ["score", "rank", "exposureRank"];
const companyAllocationPattern = /supported|unsupported|excess/i;
for (const company of REAL_COMPANIES) {
  assert(company.real === true, `${company.id}: company is not explicitly real`);
  for (const field of forbiddenCompanyFields)
    assert(!Object.hasOwn(company, field), `${company.id}: forbidden ${field} field appears in real company data`);
  assert(
    !Object.keys(company).some((field) => companyAllocationPattern.test(field)),
    `${company.id}: project outcome was allocated to a company record`
  );
}
for (const exposure of CREDIT_EXPOSURES) {
  for (const field of forbiddenCompanyFields)
    assert(!Object.hasOwn(exposure, field), `${exposure.id}: forbidden ${field} field appears on exposure`);
  assert(
    !Object.keys(exposure).some((field) => companyAllocationPattern.test(field)),
    `${exposure.id}: project outcome was allocated to a company exposure`
  );
}

assert(CARBON_NETWORK.companies === REAL_COMPANIES, "network company collection is not canonical");
assert(CARBON_NETWORK.projects === REAL_PROJECTS, "network project collection is not canonical");
assert(CARBON_NETWORK.actors === REAL_PROJECT_ACTORS, "network actor collection is not canonical");
assert(CARBON_NETWORK.exposures === CREDIT_EXPOSURES, "network exposure collection is not canonical");
assert(
  CARBON_NETWORK.projectActorRelationships === PROJECT_ACTOR_RELATIONSHIPS,
  "network actor-project collection is not canonical"
);
console.log(
  `${REAL_COMPANIES.length} real Kariba companies · ${tracedCredits.toLocaleString("en-US")} traced credits · ` +
  `${realProject.informativeBeneficiaryCoveragePct}% informative beneficiary coverage`
);

assert(bandsHit.size >= 3, `risk bands collapse: only ${[...bandsHit].join(", ")}`);
assert(
  PROJECTS.some((p) => {
    const host = CELLS.find((c) => c.id === p.hostCellId);
    const { matches } = matchControls(host, CELLS);
    return auditBaseline(p, counterfactual(matches)).band.key === "consistent";
  }),
  "no project comes back consistent — the tool must be able to clear one"
);

// ── matching uses only pre-window information ──────────────────────────────
// A covariate that reads the outcome window would make the comparison circular.
const src = (await import("node:fs")).readFileSync(new URL("./baseline.js", import.meta.url), "utf8");
const covBlock = src.slice(src.indexOf("export const COVARIATES"), src.indexOf("export function covariateStats"));
assert(!/WINDOW\[/.test(covBlock), "a covariate reads the outcome window — matching would be circular");

// ── internal illustrative project fixtures make no real-party claims ───────
const REAL_ENTITIES = ["verra", "kariba", "south pole", "volkswagen", "nestl", "gucci", "vcs-", "gold standard"];
const projectText = JSON.stringify(PROJECTS).toLowerCase();
for (const e of REAL_ENTITIES)
  assert(!projectText.includes(e), `projects.js names a real entity ("${e}") — that belongs in a sourced case study`);

const allKnownProjectIds = [...PROJECTS, ...KARIBA_PROJECTS].map((p) => p.id);
for (const cs of CASE_STUDIES) {
  const problems = validateCaseStudy(cs, allKnownProjectIds);
  assert(problems.length === 0, `case study ${cs.projectId}:\n  - ${problems.join("\n  - ")}`);
}
console.log(`\n${CASE_STUDIES.length} case studies, all validated`);

const totalForest = CELLS.reduce((s, c) => s + c.forest2008Km2, 0);
console.log(
  `${Math.round(totalForest).toLocaleString("en-US")} km² of forest across the pool · ` +
    `${COVARIATES.length} covariates · bands seen: ${[...bandsHit].join(", ")}`
);
console.log("\nself-check passed.");
