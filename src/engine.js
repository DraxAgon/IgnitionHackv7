// engine.js — the entire analysis. Pure functions, no React, no I/O, no network.
//
// The four forest-cover measurements come in from outside, so the same
// arithmetic runs on real Hansen/UMD satellite tiles (forestData.js) and on
// synthetic scenes (rasters.js). Swapping the pixel source changes nothing here.

export const PRICE_PER_CREDIT = 5.69; // USD/tCO2e, nature-based REDD+ reference
export const CANOPY_THRESHOLD_PCT = 30; // ≥30% canopy = "forest" (UMD tcd_30)

export function gradeFor(additionality) {
  if (!Number.isFinite(additionality)) return "F";
  if (additionality >= 0.8) return "A";
  if (additionality >= 0.5) return "B";
  if (additionality >= 0.25) return "C";
  if (additionality >= 0.05) return "D";
  return "F";
}

/**
 * Steps 5-8: two subtractions, one subtraction, one division — plus the money.
 * `covers` are the four measured forest-cover fractions.
 */
export function analyzeCovers(project, covers, stats) {
  const { coverProjectBase, coverProjectEnd, coverRingBase, coverRingEnd } = covers;

  // Two subtractions: relative forest loss in each zone
  const lossProject = coverProjectBase ? (coverProjectBase - coverProjectEnd) / coverProjectBase : 0;
  const lossRing = coverRingBase ? (coverRingBase - coverRingEnd) / coverRingBase : 0;

  // One subtraction: loss the project avoided relative to its counterfactual
  const actuallyProtected = lossRing - lossProject;

  // One division: against the project's own claimed baseline
  const additionality = actuallyProtected / project.claimedBaselineLoss;

  // Money. Clamped to [0,1]: over-delivery isn't refunded, and under-delivery
  // can't unsupport more credits than were actually issued.
  const addClamped = Math.min(Math.max(additionality, 0), 1);
  const creditsUnsupported = Math.round(project.creditsIssued * (1 - addClamped));

  return {
    projectId: project.id,
    covers,
    lossProject,
    lossRing,
    actuallyProtected,
    additionality,
    grade: gradeFor(additionality),
    creditsUnsupported,
    dollarsUnsupported: creditsUnsupported * PRICE_PER_CREDIT,
    confidence: confidenceFrom(stats, lossRing),
    stats,
  };
}

// Below this much loss in the ring there is effectively nothing to be
// additional to, and no amount of pixel precision can resolve a project effect.
export const WEAK_SIGNAL_PCT = 1.5;

/**
 * Confidence from three things the data can actually tell us, not from
 * assumptions. Each is surfaced in the UI with its own number.
 *
 *  dataGapPct        — share of satellite tiles that failed to load
 *  baselineDeltaPts  — how alike project and ring were to begin with (2000
 *                      canopy). A ring that never looked like the project is
 *                      a weak counterfactual regardless of what happened next.
 *  preDivergencePts  — whether the two zones were ALREADY diverging before the
 *                      crediting window opened. If they were, the ring was not
 *                      a clean control and the causal claim is weaker.
 */
export function confidenceFrom(stats = {}, lossRing = null) {
  const { dataGapPct = 0, baselineDeltaPts = 0, preDivergencePts = 0, pixelsMeasured = 0 } = stats;
  const ringLossPct = lossRing == null ? null : lossRing * 100;
  const factors = [
    {
      key: "coverage",
      label: "Data completeness",
      value: `${dataGapPct.toFixed(1)}% of tiles missing`,
      detail:
        pixelsMeasured > 0
          ? `${pixelsMeasured.toLocaleString("en-US")} satellite pixels measured across both zones`
          : "no pixels measured",
      penalty: dataGapPct >= 10 ? 2 : dataGapPct >= 2 ? 1 : 0,
    },
    {
      key: "comparability",
      label: "Ring comparability",
      value: `${baselineDeltaPts.toFixed(1)} pt canopy gap in 2000`,
      detail:
        "How closely the ring resembled the project before either was protected. A large gap means a weaker counterfactual.",
      penalty: baselineDeltaPts >= 20 ? 2 : baselineDeltaPts >= 10 ? 1 : 0,
    },
    {
      key: "pretrend",
      label: "Pre-period divergence",
      value: `${preDivergencePts.toFixed(1)} pt split before ${BASE_YEAR_LABEL}`,
      detail:
        "Project and ring loss rates in the years before the measurement window. If they had already split, the ring was not a clean control.",
      penalty: preDivergencePts >= 15 ? 2 : preDivergencePts >= 7 ? 1 : 0,
    },
    {
      key: "signal",
      label: "Counterfactual signal",
      value: ringLossPct == null ? "not measured" : `${ringLossPct.toFixed(1)}% ring loss`,
      detail:
        "How much deforestation the ring actually experienced. If the land outside the boundary was barely touched, there was nothing for the project to be additional to and the comparison cannot resolve a project effect either way.",
      penalty: ringLossPct == null ? 0 : ringLossPct < WEAK_SIGNAL_PCT ? 3 : ringLossPct < 3 ? 1 : 0,
    },
  ];
  const total = factors.reduce((s, f) => s + f.penalty, 0);
  const weakSignal = ringLossPct != null && ringLossPct < WEAK_SIGNAL_PCT;
  return {
    level: weakSignal ? "low" : total <= 1 ? "high" : total <= 3 ? "medium" : "low",
    factors,
    score: total,
    weakSignal,
  };
}

const BASE_YEAR_LABEL = 2015;

// Portfolio rollup: spend, versus spend on credits the evidence doesn't support.
export function analyzeHoldings(holdings, verdictById) {
  const rows = holdings
    .filter((h) => verdictById[h.projectId])
    .map((h) => {
      const v = verdictById[h.projectId];
      const spend = h.credits * h.pricePerCredit;
      const addClamped = Math.min(Math.max(v.additionality, 0), 1);
      const unsupported = spend * (1 - addClamped);
      return { ...h, verdict: v, spend, unsupported, supported: spend - unsupported };
    });
  return {
    rows,
    totalCredits: rows.reduce((s, r) => s + r.credits, 0),
    totalSpend: rows.reduce((s, r) => s + r.spend, 0),
    totalUnsupported: rows.reduce((s, r) => s + r.unsupported, 0),
  };
}

