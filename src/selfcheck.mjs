// node src/selfcheck.mjs
// Runs the real pipeline over the bundled satellite measurements and asserts
// the index's invariants. No browser, no network.
import assert from "node:assert";
import { analyzeCovers, analyzeHoldings, PRICE_PER_CREDIT } from "./engine.js";
import { coversFrom, statsFrom } from "./forestData.js";
import { PROJECTS, COMPANIES, REGION } from "./data.js";
import M from "./measurements.json" with { type: "json" };

const pct = (x) => (x * 100).toFixed(1) + "%";
const verdicts = PROJECTS.map((p) => {
  const m = M.byProject[p.id];
  assert(m, `${p.id} has no measurement`);
  return { p, v: analyzeCovers(p, coversFrom(m, M.baseYear, M.endYear), statsFrom(m, M.baseYear)) };
});

console.log(`source: ${M.source}`);
console.log(`window: ${M.baseYear} → ${M.endYear} · canopy ≥ ${M.canopyThresholdPct}% · zoom ${M.zoom}\n`);
console.log("id         grade  addl      lossProj  lossRing  $unsupported   confidence");
for (const { p, v } of verdicts) {
  console.log(
    `${p.id.padEnd(9)}  ${v.grade}      ${pct(v.additionality).padEnd(8)}  ` +
      `${pct(v.lossProject).padEnd(8)}  ${pct(v.lossRing).padEnd(8)}  ` +
      `$${Math.round(v.dollarsUnsupported).toLocaleString("en-US").padEnd(12)}  ${v.confidence.level}`
  );
}

const grades = verdicts.map((x) => x.v.grade).join("");
const count = (g) => verdicts.filter((x) => x.v.grade === g).length;
console.log(`\ngrades: ${grades}`);

// ── invariants the demo depends on ─────────────────────────────────────────
assert(count("A") >= 1, "the index must be able to say a project is real");
assert(count("F") >= 1, "the index must be able to fail a project");
assert(new Set(grades).size >= 4, "grades must span the scale");
assert(
  verdicts.some((x) => x.v.confidence.level === "low"),
  "the index must know what it cannot see"
);
assert(
  verdicts.some((x) => x.v.additionality < 0),
  "at least one project should have lost forest faster than its ring"
);

// Every measurement is real, complete, and large enough to mean something.
for (const { p, v } of verdicts) {
  const m = M.byProject[p.id];
  assert(m.tilesFailed === 0, `${p.id}: ${m.tilesFailed} tiles failed`);
  assert(v.stats.pixelsMeasured > 100000, `${p.id}: only ${v.stats.pixelsMeasured} px`);
  assert(m.ring.total > m.project.total, `${p.id}: ring should be larger than project`);
  for (const z of [m.project, m.ring]) {
    assert(z.forest2000 <= z.total, `${p.id}: forest exceeds zone area`);
    const lost = Object.values(z.lossByYear).reduce((a, b) => a + b, 0);
    assert(lost <= z.forest2000, `${p.id}: loss exceeds year-2000 forest`);
  }
  // Cover can only fall: Hansen loss is cumulative and never reverts.
  let prev = Infinity;
  for (let y = M.baseYear; y <= M.endYear; y++) {
    const c = coversFrom(m, y, y).coverProjectBase;
    assert(c <= prev + 1e-9, `${p.id}: forest cover increased in ${y}`);
    prev = c;
  }
}

// Nothing fictional may collide with a real registry namespace.
for (const p of PROJECTS) {
  assert(/^AMZ-\d{4}$/.test(p.id), `${p.id} must use the demo namespace`);
  const [lon, lat] = p.center;
  const [[w, s], [e, n]] = REGION.maxBounds;
  assert(lon > w && lon < e && lat > s && lat < n, `${p.id} sits outside the region`);
}

// Determinism: pure arithmetic over fixed data.
const again = analyzeCovers(
  PROJECTS[0],
  coversFrom(M.byProject[PROJECTS[0].id], M.baseYear, M.endYear),
  statsFrom(M.byProject[PROJECTS[0].id], M.baseYear)
);
assert.equal(again.additionality, verdicts[0].v.additionality, "non-deterministic");

// Portfolios resolve and never claim more unsupported spend than was spent.
for (const c of COMPANIES) {
  const byId = Object.fromEntries(verdicts.map((x) => [x.p.id, x.v]));
  const r = analyzeHoldings(c.holdings, byId);
  assert.equal(r.rows.length, c.holdings.length, `${c.name}: unresolved holding`);
  assert(r.totalUnsupported <= r.totalSpend + 1e-6, `${c.name}: unsupported exceeds spend`);
  assert(r.totalUnsupported >= 0, `${c.name}: negative unsupported`);
}

const totalUnsupported = verdicts.reduce((s, x) => s + x.v.dollarsUnsupported, 0);
const totalCredits = PROJECTS.reduce((s, p) => s + p.creditsIssued, 0);
console.log(
  `${PROJECTS.length} projects · ${totalCredits.toLocaleString("en-US")} credits · ` +
    `$${Math.round(totalUnsupported).toLocaleString("en-US")} unsupported at $${PRICE_PER_CREDIT}/credit`
);
const low = verdicts.find((x) => x.v.confidence.level === "low");
console.log(`low-confidence case: ${low.p.id} (${low.p.name}) — ${low.v.confidence.factors.find((f) => f.key === "signal").value}`);
console.log("\nself-check passed.");
