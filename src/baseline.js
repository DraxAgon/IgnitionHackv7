// baseline.js — independent baseline reconstruction. Pure, no I/O, no network.
//
// A forest carbon project's credits rest on a prediction: how much forest would
// have been lost without it. Projects build that prediction themselves, from a
// reference area they choose. Nobody routinely checks whether it was reasonable.
//
// This module rebuilds the prediction from scratch:
//   1. describe the project's parcel by covariates known BEFORE the crediting
//      window opened (so nothing about the outcome leaks into the matching),
//   2. find the unprotected parcels that most resemble it,
//   3. observe what actually happened to those parcels,
//   4. compare that against what the project claimed would happen.
//
// Everything here is observed history. No forecasting.

export const REFERENCE_PERIOD = [2008, 2015]; // used to describe parcels
export const WINDOW = [2016, 2023]; // used to observe outcomes

// ── parcel measurements ────────────────────────────────────────────────────

/** Forest standing at the START of `year`, in km². */
export function forestAt(cell, year) {
  let f = cell.forest2008Km2;
  for (let y = 2008; y < year; y++) f -= cell.clearedByYear[y] ?? 0;
  return Math.max(0, f);
}

/** Forest cleared between `from` and `to` inclusive, in km². */
export function clearedBetween(cell, from, to) {
  let s = 0;
  for (let y = from; y <= to; y++) s += cell.clearedByYear[y] ?? 0;
  return s;
}

/** Share of the forest standing at `from` that was cleared by the end of `to`. */
export function lossFraction(cell, from, to) {
  const base = forestAt(cell, from);
  return base > 0 ? clearedBetween(cell, from, to) / base : 0;
}

/** Cumulative loss fraction for each year of a window. */
export function lossPath(cell, [from, to] = WINDOW) {
  const base = forestAt(cell, from);
  const out = [];
  let acc = 0;
  for (let y = from; y <= to; y++) {
    acc += cell.clearedByYear[y] ?? 0;
    out.push({ year: y, loss: base > 0 ? acc / base : 0 });
  }
  return out;
}

// ── covariates ─────────────────────────────────────────────────────────────
// Every one of these is knowable before the observation window opens. That is
// what makes the controls a fair comparison rather than a circular one.

export const COVARIATES = [
  {
    key: "forestFrac",
    label: "Forest share of land",
    unit: "%",
    format: (v) => (v * 100).toFixed(0) + "%",
    get: (c) => (c.landKm2 > 0 ? forestAt(c, REFERENCE_PERIOD[0]) / c.landKm2 : 0),
    why: "How much of the parcel was still forest when the reference period opened.",
  },
  {
    key: "priorLossRate",
    label: "Prior clearing rate",
    unit: "%/yr",
    format: (v) => (v * 100).toFixed(2) + "%/yr",
    get: (c) => lossFraction(c, REFERENCE_PERIOD[0], REFERENCE_PERIOD[1]) / (REFERENCE_PERIOD[1] - REFERENCE_PERIOD[0] + 1),
    why: "Deforestation pressure already on the parcel before the crediting window — the single strongest predictor of what comes next.",
  },
  {
    key: "frontier",
    label: "Historic clearing",
    unit: "%",
    format: (v) => (v * 100).toFixed(0) + "%",
    get: (c) => (c.landKm2 > 0 ? c.preClearedKm2 / c.landKm2 : 0),
    why: "Share already cleared before 2008. A proxy for roads, settlement and access — the frontier reaches cleared land first.",
  },
  {
    key: "elevationM",
    label: "Elevation",
    unit: "m",
    format: (v) => Math.round(v) + " m",
    get: (c) => c.elevationM ?? null,
    why: "Terrain shapes both agricultural suitability and how reachable a parcel is.",
  },
  {
    key: "ruggednessM",
    label: "Terrain ruggedness",
    unit: "m",
    format: (v) => Math.round(v) + " m",
    get: (c) => c.ruggednessM ?? null,
    why: "Elevation spread within the parcel. Broken ground resists mechanised clearing.",
  },
  {
    key: "precipMmYr",
    label: "Rainfall",
    unit: "mm/yr",
    format: (v) => Math.round(v) + " mm",
    get: (c) => c.precipMmYr ?? null,
    why: "Separates wet closed-canopy forest from drier transitional forest, which clear under different economics.",
  },
  {
    key: "latitude",
    label: "Latitude",
    unit: "°",
    format: (v) => v.toFixed(1) + "°",
    get: (c) => c.center[1],
    why: "Stands in for the broad north-south gradient in biome and settlement history.",
  },
];

/** Mean and spread of each covariate across the pool, for standardisation. */
export function covariateStats(pool) {
  const stats = {};
  for (const cv of COVARIATES) {
    const vals = pool.map(cv.get).filter(Number.isFinite);
    const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1)) || 1;
    stats[cv.key] = { mean, sd };
  }
  return stats;
}

/**
 * Standardised distance between two parcels: a diagonal Mahalanobis distance,
 * scaled per covariate so no single unit dominates. Lower is more alike.
 *
 * Covariates missing on either side are skipped rather than treated as zero —
 * an absent elevation is not sea level, and scoring it as such would quietly
 * distort every comparison that touched it.
 */
export function distance(a, b, stats) {
  let sum = 0;
  let used = 0;
  for (const cv of COVARIATES) {
    const va = cv.get(a);
    const vb = cv.get(b);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
    const d = (va - vb) / stats[cv.key].sd;
    sum += d * d;
    used++;
  }
  return used ? Math.sqrt(sum / used) : Infinity;
}

/** Which covariates actually have data across the pool. */
export const availableCovariates = (pool) =>
  COVARIATES.filter((cv) => pool.some((c) => Number.isFinite(cv.get(c))));

/** 0-100 readability score for a distance. 1.0 sd of average mismatch ≈ 61%. */
export const similarity = (d) => 100 * Math.exp(-d / 2);

// ── matching ───────────────────────────────────────────────────────────────

/**
 * Find the unprotected parcels most like `target`.
 * Controls must be genuinely counterfactual: unprotected, forested, and not the
 * project's own parcel or its immediate neighbours (which absorb leakage).
 */
export function matchControls(target, pool, opts = {}) {
  const {
    limit = 250,
    maxDistance = 1.0,
    maxProtected = 0.25,
    excludeIds = [],
    excludeWithinDeg = 1.5,
    minForestKm2 = 200,
  } = opts;
  const stats = covariateStats(pool);
  const excluded = new Set([target.id, ...excludeIds]);

  const scored = pool
    .filter((c) => {
      if (excluded.has(c.id)) return false;
      if (c.protectedFrac > maxProtected) return false;
      if (forestAt(c, WINDOW[0]) < minForestKm2) return false;
      const dx = Math.abs(c.center[0] - target.center[0]);
      const dy = Math.abs(c.center[1] - target.center[1]);
      return Math.max(dx, dy) > excludeWithinDeg; // leakage buffer
    })
    .map((c) => {
      const d = distance(target, c, stats);
      return { cell: c, distance: d, similarity: similarity(d) };
    })
    .filter((m) => m.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);

  return { matches: scored.slice(0, limit), stats, considered: pool.length };
}

// ── independent counterfactual ─────────────────────────────────────────────

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/**
 * What actually happened to the matched controls over the window: the
 * distribution of observed loss, which is the independent baseline.
 */
export function counterfactual(matches, window = WINDOW) {
  const losses = matches.map((m) => lossFraction(m.cell, window[0], window[1])).sort((a, b) => a - b);
  return {
    n: losses.length,
    median: quantile(losses, 0.5),
    p25: quantile(losses, 0.25),
    p75: quantile(losses, 0.75),
    p90: quantile(losses, 0.9),
    max: losses.at(-1) ?? 0,
    losses,
  };
}

/** Where a claimed baseline sits inside the observed control distribution. */
export function percentileOf(value, sortedLosses) {
  if (!sortedLosses.length) return 0;
  let below = 0;
  for (const l of sortedLosses) if (l < value) below++;
  return (below / sortedLosses.length) * 100;
}

/**
 * Bands over the percentile, with thresholds set for the sample sizes this
 * actually runs on. With 15 controls the highest percentile any claim can reach
 * is 14/15 — so a 99-point threshold would be unreachable by construction and
 * the top band would never fire no matter how extreme the baseline.
 */
export const RISK_BANDS = [
  { key: "severe", label: "Severe", min: 95, color: "#e5484d" },
  { key: "high", label: "High", min: 88, color: "#ee7f2d" },
  { key: "elevated", label: "Elevated", min: 75, color: "#e8b931" },
  { key: "moderate", label: "Moderate", min: 55, color: "#9bcf3b" },
  { key: "consistent", label: "Consistent", min: 0, color: "#2fbf71" },
];
export const riskBandFor = (percentile) => RISK_BANDS.find((b) => percentile >= b.min);

// ── the audit ──────────────────────────────────────────────────────────────

/**
 * Compare a project's own claimed baseline against the independent one.
 * `claimedBaselineLoss` is the fraction of project forest the project predicted
 * would be lost over the crediting window without it.
 */
export function auditBaseline(project, cf) {
  const claimed = project.claimedBaselineLoss;
  const independent = cf.median;
  const percentile = percentileOf(claimed, cf.losses);
  const band = riskBandFor(percentile);

  // ── the one chain every displayed figure hangs off ──────────────────────
  //
  // These four lines are the whole comparison, and they are written out in
  // sequence so the arithmetic is checkable by eye:
  //
  //   discrepancy      = claimed − independent
  //   unsupportedShare = discrepancy ÷ claimed
  //   creditsUnsupported = issued × unsupportedShare
  //
  // Everything the interface renders derives from here. An earlier build showed
  // a 16-point discrepancy beside an "avoided deforestation" panel reading
  // 0.0% against 0.0%, because those two framings were computed independently
  // and happened to disagree: this project lost more forest than its own
  // baseline predicted, so its *avoided* figure is zero while its *baseline*
  // still sits far above what comparable land did. Both were true and together
  // they read as a bug. The panel now states the baseline comparison only, and
  // `selfcheck.mjs` asserts the chain holds for every project.
  const discrepancyPts = (claimed - independent) * 100;
  const supportedShare = claimed > 0 ? Math.min(1, independent / claimed) : 1;
  const unsupportedShare = 1 - supportedShare;
  const creditsUnsupported = Math.round(project.creditsIssued * unsupportedShare);
  const ratio = independent > 0 ? claimed / independent : Infinity;

  // A buyer wants one number. This is the percentile inverted: 100 means the
  // baseline sits at the bottom of what comparable land actually did, 0 means
  // it sits above essentially all of it. It is a summary of the comparison,
  // not a rating of the project.
  const consistencyScore = Math.round(100 - percentile);

  return {
    claimed,
    independent,
    p25: cf.p25,
    p75: cf.p75,
    controls: cf.n,
    percentile,
    consistencyScore,
    band,
    discrepancyPts,
    ratio,
    supportedShare,
    unsupportedShare,
    creditsUnsupported,
    creditsIssued: project.creditsIssued,
    creditsRetired: project.creditsRetired,
    pricePerCredit: project.pricePerCredit ?? 5.69,
    valueUnsupported: creditsUnsupported * (project.pricePerCredit ?? 5.69),
  };
}

// ── continuous backtest ────────────────────────────────────────────────────

/**
 * Year by year, what the project predicted against what comparable land did.
 * This is the question a buyer actually wants answered: at what point did the
 * evidence stop supporting the baseline — and how long ago was that?
 *
 * The claimed path is straight-line unless the project supplies its own; real
 * baselines are usually stated as an annual rate.
 */
export function divergenceTimeline(project, matches, window = WINDOW) {
  const [from, to] = window;
  const years = to - from + 1;
  const controlPaths = matches.map((m) => lossPath(m.cell, window));

  const rows = [];
  let firstFlagYear = null;
  let consecutive = 0;

  for (let i = 0; i < years; i++) {
    const year = from + i;
    const claimed = project.claimedPath
      ? project.claimedPath[i]
      : (project.claimedBaselineLoss * (i + 1)) / years;
    const observedAll = controlPaths.map((p) => p[i]?.loss ?? 0).sort((a, b) => a - b);
    const observed = quantile(observedAll, 0.5);
    const ratio = claimed > 0 ? observed / claimed : 1;

    // Two consecutive years below half the claimed pace is the flag.
    if (ratio < 0.5) consecutive++;
    else consecutive = 0;
    if (consecutive >= 2 && firstFlagYear === null) firstFlagYear = year;

    rows.push({
      year,
      claimed,
      observed,
      p25: quantile(observedAll, 0.25),
      p75: quantile(observedAll, 0.75),
      ratio,
      status: ratio >= 0.85 ? "tracking" : ratio >= 0.5 ? "watch" : ratio >= 0.25 ? "diverging" : "overstated",
    });
  }

  return {
    rows,
    firstFlagYear,
    yearsOfWarning: firstFlagYear ? to - firstFlagYear : 0,
    finalRatio: rows.at(-1)?.ratio ?? 1,
  };
}

/** Everything about one project, in one call. */
export function auditProject(project, hostCell, pool, opts = {}) {
  const { matches, considered } = matchControls(hostCell, pool, opts);
  const cf = counterfactual(matches, opts.window ?? WINDOW);
  const audit = auditBaseline(project, cf);
  const timeline = divergenceTimeline(project, matches, opts.window ?? WINDOW);
  const observedInside = lossFraction(hostCell, (opts.window ?? WINDOW)[0], (opts.window ?? WINDOW)[1]);
  return { project, hostCell, matches, considered, counterfactual: cf, audit, timeline, observedInside };
}
