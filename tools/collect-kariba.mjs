// tools/collect-kariba.mjs — build the control-parcel dataset for the Zambezi
// Valley, Zimbabwe, from the legacy Global Forest Watch v1 API (see tools/gfw.mjs).
//
//   node tools/collect-kariba.mjs           resume (skips cells already cached)
//   node tools/collect-kariba.mjs --fresh   ignore the cache
//
// Source: Hansen Global Forest Change, via production-api.globalforestwatch.org
// — public, keyless, verified live. Real observed history, same as the Amazon
// pipeline in tools/collect.mjs, just a different public endpoint because
// PRODES only covers Brazil.
//
// One measured limitation, carried into `note` below: this endpoint's loss
// figures stop moving past 2019 in spot checks (querying the same geometry
// with later `period` end dates returns an identical number), so annual data
// is only populated through 2019, not the present. `firstYear`/`lastYear`
// reflect that honestly rather than padding later years with zeros that would
// read as "measured zero loss".
//
// Output: src/cells-kariba.json — same shape as src/cells.json.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerBboxGeostore, lossGainStats, boxAreaKm2, sleep } from "./gfw.mjs";
import { elevationFor, precipitationFor } from "./prodes.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE = `${ROOT}/.cache`;
const cachePath = `${CACHE}/cells-kariba.json`;
const fresh = process.argv.includes("--fresh");
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
const cache = !fresh && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

// The Zambezi Valley grid: northern Zimbabwe along the southern shore of Lake
// Kariba and the Zambezi River, spanning the four Rural District Councils the
// real Kariba REDD+ project operates in (Binga, Hurungwe, Nyaminyami, Mbire).
// Finer than the Amazon's 1-degree grid (0.5 degrees) because the whole region
// is much smaller than the Legal Amazon.
const CELL = 0.5; // degrees
// Wider than the four-district footprint on purpose: matchControls' leakage
// buffer excludes every candidate within 1.5 degrees of the project's own
// centre (baseline.js, unchanged — see the root README's exclusion-buffer
// rationale), so a grid sized tightly around Kariba loses most of its pool to
// that exclusion before matching even starts. Kariba sits near the northwest
// corner of this box rather than its centre so most of the grid clears the
// buffer. (west/north match the first, smaller pass exactly, so its cache is
// reused rather than re-fetched.)
const BOUNDS = { west: 27.3, south: -19.6, east: 34.0, north: -14.9 };
const FIRST_YEAR = 2008; // matches baseline.js's REFERENCE_PERIOD[0] anchor
const LAST_YEAR = 2019; // last year this endpoint's loss data actually moves
const THRESH = 30; // canopy-density threshold, GFC's own convention

// Rough bounding boxes for named reserves overlapping the grid, standing in
// for PRODES's conservation-unit layer (no equivalent free bulk download was
// wired up for this pass — see the root README's own precedent for
// documenting an approximated covariate rather than fabricating precision,
// e.g. its rainfall caveat). Approximate on purpose; a parcel's protectedFrac
// here is a coarse overlap estimate, not a measured polygon intersection.
const PROTECTED_BOXES = [
  { name: "Matusadona NP", bbox: [28.0, -17.3, 28.9, -16.75] },
  { name: "Chete Safari Area", bbox: [27.15, -17.75, 27.65, -17.3] },
  { name: "Charara Safari Area", bbox: [28.3, -16.85, 28.9, -16.35] },
  { name: "Chizarira NP", bbox: [27.55, -18.05, 28.1, -17.55] },
];
function protectedFraction([w, s, e, n]) {
  const area = (e - w) * (n - s);
  if (area <= 0) return 0;
  let covered = 0;
  for (const { bbox: [pw, ps, pe, pn] } of PROTECTED_BOXES) {
    const ow = Math.max(0, Math.min(e, pe) - Math.max(w, pw));
    const oh = Math.max(0, Math.min(n, pn) - Math.max(s, ps));
    covered += ow * oh;
  }
  return Math.max(0, Math.min(1, covered / area));
}

const cells = [];
for (let lon = BOUNDS.west; lon < BOUNDS.east; lon += CELL) {
  for (let lat = BOUNDS.south; lat < BOUNDS.north; lat += CELL) {
    const w = +lon.toFixed(3), s = +lat.toFixed(3);
    const e = +(lon + CELL).toFixed(3), n = +(lat + CELL).toFixed(3);
    cells.push({ id: `KZ${w}_${s}`, bbox: [w, s, e, n], center: [(w + e) / 2, (s + n) / 2] });
  }
}
console.log(`${cells.length} parcels across the Zambezi Valley grid\n`);

const todo = cells.filter((c) => !cache[c.id]);
console.log(`measuring ${todo.length} parcels (${cells.length - todo.length} cached)`);
let done = 0, failed = 0;
const CONCURRENCY = 3;

async function measure(cell) {
  const { hash, areaHa } = await registerBboxGeostore(cell.bbox);
  const areaKm2 = areaHa / 100;

  // Cumulative loss through each year of interest, diffed into annual
  // increments — the same "loss up to year Y" -> "loss in year Y" derivation
  // PRODES gives directly and this endpoint only gives cumulatively.
  const years = [];
  for (let y = FIRST_YEAR - 1; y <= LAST_YEAR; y++) years.push(y);
  const cumulative = {};
  let treeExtent2010 = null;
  for (const y of years) {
    const stats = await lossGainStats(hash, y, THRESH);
    cumulative[y] = stats.lossHa / 100; // ha -> km2
    if (treeExtent2010 == null) treeExtent2010 = stats.treeExtent2010 / 100;
  }
  const clearedByYear = {};
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) {
    clearedByYear[y] = +Math.max(0, cumulative[y] - cumulative[y - 1]).toFixed(3);
  }
  const preClearedKm2 = +Math.max(0, cumulative[FIRST_YEAR - 1]).toFixed(1);

  return { areaKm2: +areaKm2.toFixed(1), preClearedKm2, treeExtent2010Km2: +treeExtent2010.toFixed(1), clearedByYear };
}

const queue = todo.slice();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let cell = queue.shift(); cell; cell = queue.shift()) {
      try {
        cache[cell.id] = await measure(cell);
      } catch (e) {
        failed++;
        console.warn(`  ${cell.id} failed: ${e.message}`);
      }
      if (++done % 10 === 0 || done === todo.length) {
        writeFileSync(cachePath, JSON.stringify(cache));
        console.log(`  ${done}/${todo.length} parcels (${failed} failed)`);
      }
      await sleep(150);
    }
  })
);
writeFileSync(cachePath, JSON.stringify(cache));
console.log(`GFW done: ${Object.keys(cache).length} parcels cached, ${failed} failed\n`);

// ── terrain and climate covariates (Open-Meteo, keyless, same as the Amazon) ─
const live = cells.filter((c) => cache[c.id]);
const covPath = `${CACHE}/covariates-kariba.json`;
const cov = !fresh && existsSync(covPath) ? JSON.parse(readFileSync(covPath, "utf8")) : {};
const saveCov = () => writeFileSync(covPath, JSON.stringify(cov));

console.log("fetching elevation and precipitation (Open-Meteo)...");
let n = 0;
for (const c of live) {
  if (cov[c.id]?.elevationM == null) {
    try {
      const { elevationM, ruggednessM } = await elevationFor(c.bbox);
      cov[c.id] = { ...cov[c.id], elevationM, ruggednessM };
    } catch (e) {
      console.log(`  ${c.id} elevation: ${e.message}`);
    }
    await sleep(200);
  }
  if (cov[c.id]?.precipMmYr == null) {
    try {
      cov[c.id] = { ...cov[c.id], precipMmYr: await precipitationFor(c.center) };
    } catch (e) {
      console.log(`  ${c.id} precip: ${e.message}`);
    }
    await sleep(200);
  }
  if (++n % 10 === 0 || n === live.length) {
    saveCov();
    process.stdout.write(`\r  ${n}/${live.length} parcels`);
  }
}
console.log();

// ── assemble, same shape as src/cells.json ──────────────────────────────────
const records = live.map((c) => {
  const m = cache[c.id];
  const { elevationM = null, ruggednessM = null, precipMmYr = null } = cov[c.id] ?? {};
  const land = m.areaKm2; // no water/non-forest mask available from this source; land == box area
  const clearedTotal = Object.values(m.clearedByYear).reduce((a, b) => a + b, 0);
  // Forest at the start of FIRST_YEAR: the 2010 tree-extent baseline, walked
  // back by loss that happened between FIRST_YEAR and 2010 (thresh=30 tree
  // cover at 2010 is what this endpoint actually reports; PRODES's
  // forest2008Km2 is the nearest equivalent concept, not an identical
  // measurement, so this is the honest approximation of it available here).
  let lossFirstYearTo2010 = 0;
  for (let y = FIRST_YEAR; y <= 2010; y++) lossFirstYearTo2010 += m.clearedByYear[y] ?? 0;
  const forestFirstYear = Math.max(0, m.treeExtent2010Km2 + lossFirstYearTo2010);
  const consistent = forestFirstYear >= clearedTotal;
  return {
    id: c.id,
    bbox: c.bbox,
    center: [+c.center[0].toFixed(3), +c.center[1].toFixed(3)],
    label: null,
    consistent,
    areaKm2: m.areaKm2,
    landKm2: +land.toFixed(1),
    forest2008Km2: +forestFirstYear.toFixed(1),
    preClearedKm2: m.preClearedKm2,
    nonForestKm2: 0,
    waterKm2: 0,
    clearedByYear: m.clearedByYear,
    protectedFrac: +protectedFraction(c.bbox).toFixed(3),
    elevationM,
    ruggednessM,
    precipMmYr,
  };
});

const usable = records.filter((r) => r.forest2008Km2 > 20 && r.consistent).map(({ consistent, ...r }) => r);
console.log(`dropped ${records.filter((r) => !r.consistent).length} parcels with inconsistent mask accounting`);
writeFileSync(
  `${ROOT}/src/cells-kariba.json`,
  JSON.stringify({
    source: "Hansen Global Forest Change via the legacy Global Forest Watch v1 API (production-api.globalforestwatch.org) — GFW rebranded to Global Nature Watch (globalnaturewatch.org) in 2025; this endpoint is unaffected",
    citation: "Hansen, M. C. et al. (2013). High-Resolution Global Maps of 21st-Century Forest Cover Change. Science. Served via Global Nature Watch, formerly Global Forest Watch.",
    license: "Hansen/UMD/Google/USGS/NASA: CC BY 4.0. Global Nature Watch: open data.",
    collectedAt: new Date().toISOString().slice(0, 10),
    region: "Zambezi Valley, northern Zimbabwe",
    cellDegrees: CELL,
    firstYear: FIRST_YEAR,
    lastYear: LAST_YEAR,
    note:
      "Areas in km2. clearedByYear is Hansen tree-cover loss, derived from cumulative " +
      "loss-to-date queries diffed year over year (this endpoint has no native per-year " +
      "breakdown). Data is only populated through 2019 — later years are not queryable " +
      "from this endpoint and are not included. protectedFrac is a coarse bounding-box " +
      "overlap estimate against a short hand-compiled list of named reserves, not a " +
      "measured polygon intersection.",
    cells: usable,
  })
);
console.log(`wrote src/cells-kariba.json — ${usable.length} parcels with forest (of ${records.length} measured)`);
