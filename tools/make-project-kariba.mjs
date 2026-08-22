// tools/make-project-kariba.mjs — build the Zimbabwe project records.
//
//   node tools/make-project-kariba.mjs   (needs src/cells-kariba.json)
//
// Two kinds of record, same as the file header on src/projects-kariba.js says:
//
//   Kariba REDD+ (VCS 902) is REAL, not illustrative: a real registered
//   project, with real published facts about its registry status, area and
//   timeline — sourced and cited in src/caseStudies.js, not invented here.
//
//   The rest are illustrative, built the same way tools/make-projects.mjs
//   builds the Amazon's thirteen: real measured footprints (against the
//   legacy GFW v1 API instead of PRODES, since PRODES is Brazil-only), real
//   place names, invented claims/credits/registry status. They give the
//   region buyer records and a populated list, matching the Amazon's format.
//
// Kariba's boundary is NOT the project's precise registered geometry — no
// keyless source for that was found during this build. It's a hand-traced
// approximation of the published description (the four Rural District
// Councils along the Zambezi Valley south of Lake Kariba: Binga, Hurungwe,
// Nyaminyami, Mbire), sized in the right neighbourhood of the real ~758,000 ha
// the developer states. Flagged as approximate in the record itself.

import { writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerGeostore, registerBboxGeostore, lossGainStats, sleep } from "./gfw.mjs";
import { matchControls, counterfactual, forestAt, lossFraction } from "../src/baseline.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cellsDoc = JSON.parse(readFileSync(`${ROOT}/src/cells-kariba.json`, "utf8"));
const CELLS = cellsDoc.cells;
const FIRST_YEAR = cellsDoc.firstYear;
const LAST_YEAR = cellsDoc.lastYear;
const WINDOW = [FIRST_YEAR + 8, LAST_YEAR]; // [2016, 2019]

/** Measure clearedByYear + forest baseline for a geostore, real GFW data. */
async function measureFootprint(hash) {
  const cumulative = {};
  let treeExtent2010Km2 = null;
  for (let y = FIRST_YEAR - 1; y <= LAST_YEAR; y++) {
    const stats = await lossGainStats(hash, y, 30);
    cumulative[y] = stats.lossHa / 100; // ha -> km2
    if (y === 2010) treeExtent2010Km2 = stats.treeExtent2010 / 100;
    await sleep(150);
  }
  const clearedByYear = {};
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) {
    clearedByYear[y] = +Math.max(0, cumulative[y] - cumulative[y - 1]).toFixed(3);
  }
  let lossToFirstYear = 0;
  for (let y = FIRST_YEAR; y <= 2010; y++) lossToFirstYear += clearedByYear[y] ?? 0;
  const forestFirstYear = Math.max(0, treeExtent2010Km2 + lossToFirstYear);
  const preClearedKm2 = +Math.max(0, cumulative[FIRST_YEAR - 1]).toFixed(1);
  return { clearedByYear, forestFirstYear, preClearedKm2 };
}

// ── 1. Kariba REDD+ — real ──────────────────────────────────────────────────

// Hand-traced approximation of the four-district footprint along the
// southern shore of Lake Kariba and the Zambezi Valley, west (Binga) to east
// (Mbire). Not the registered boundary — see the file header.
const KARIBA_BOUNDARY = [
  [27.70, -16.95], [27.68, -16.75], [27.85, -16.55], [28.20, -16.48],
  [28.60, -16.45], [29.00, -16.50], [29.20, -16.62], [29.18, -16.80],
  [28.95, -16.92], [28.50, -16.98], [28.05, -17.00], [27.70, -16.95],
];

console.log("measuring the Kariba REDD+ footprint against GFW...");
const karibaGeo = await registerGeostore(KARIBA_BOUNDARY);
console.log(`  geostore ${karibaGeo.hash} — ${(karibaGeo.areaHa / 1000).toFixed(1)}k ha`);
const karibaMeasured = await measureFootprint(karibaGeo.hash);
const karibaAreaKm2 = karibaGeo.areaHa / 100;
const [kw, ks, ke, kn] = karibaGeo.bbox;

const karibaParcel = {
  id: "KARIBA-902-footprint",
  bbox: [+kw.toFixed(4), +ks.toFixed(4), +ke.toFixed(4), +kn.toFixed(4)],
  center: [+((kw + ke) / 2).toFixed(3), +((ks + kn) / 2).toFixed(3)],
  label: "Binga / Hurungwe / Nyaminyami / Mbire",
  areaKm2: +karibaAreaKm2.toFixed(1),
  landKm2: +karibaAreaKm2.toFixed(1),
  forest2008Km2: +karibaMeasured.forestFirstYear.toFixed(1),
  preClearedKm2: karibaMeasured.preClearedKm2,
  nonForestKm2: 0,
  waterKm2: 0,
  clearedByYear: karibaMeasured.clearedByYear,
  protectedFrac: 0.15, // rough: parts of the footprint overlap safari areas along the lake shore
  elevationM: null,
  ruggednessM: null,
  precipMmYr: null,
};
console.log(`  measured: forest2008 ${karibaParcel.forest2008Km2} km2, cleared ${FIRST_YEAR}-${LAST_YEAR} = ` +
  `${Object.values(karibaMeasured.clearedByYear).reduce((a, b) => a + b, 0).toFixed(1)} km2`);

// claimedBaselineLoss is NOT a directly-quoted figure. The project's own
// reported baseline rate — 3.7% deforestation per year, per reporting on the
// project's own maps (see caseStudies.js) — is compounded over Phantom's own
// fixed window so the interactive matching mechanic has a number to compare
// against. That is a real rate applied to a window the app chose, not the
// figure Verra's own review used (which covered the real ~2011-2023
// crediting period with a different method) — caseStudies.js keeps the two
// clearly separate.
const CLAIMED_ANNUAL_RATE = 0.037;
const karibaClaimYears = WINDOW[1] - WINDOW[0] + 1;
const karibaClaimedBaselineLoss = +(1 - (1 - CLAIMED_ANNUAL_RATE) ** karibaClaimYears).toFixed(3);

const karibaProject = {
  id: "KARIBA-902",
  name: "Kariba REDD+ Project",
  shortName: "Kariba REDD+",
  country: "Zimbabwe",
  locality: "Binga / Hurungwe / Nyaminyami / Mbire",
  center: karibaParcel.center,
  areaHa: 758000, // per the developer's own site (carbongreenafrica.net); see caseStudies.js
  seed: 902,
  registry: "VCS 902 — withdrawn from the Verra registry, May 2024",
  methodology: "VM0009 (avoided unplanned deforestation, reference region)",
  startYear: 2011,
  creditingYears: LAST_YEAR - FIRST_YEAR + 1, // the app's own fixed comparison window, not the real crediting period (see caseStudies.js)
  claimedBaselineLoss: karibaClaimedBaselineLoss,
  creditsIssued: 26822953, // Exact Verra review total preserved in the sourced Kariba dataset.
  creditsRetired: null, // no primary-sourced aggregate retirement figure found; the panel hides this stat rather than showing a false zero
  pricePerCredit: null,
  featured: true,
  real: true,
  boundaryApproximate: true,
  boundary: KARIBA_BOUNDARY.map(([lon, lat]) => [+lon.toFixed(4), +lat.toFixed(4)]),
  hostCellId: null,
  parcel: karibaParcel,
};

// ── 2. illustrative projects — same recipe as tools/make-projects.mjs ──────
//
// Real Zimbabwean place names (forests, safari areas, communal lands near the
// Zambezi Valley), fictional specific projects — the same convention the
// Amazon's thirteen already use (e.g. "Serra do Cachimbo REDD+" names a real
// range, the project on it is invented).
const SITES = [
  ["Chizarira REDD+", "Chizarira", 240000],
  ["Mafungabusi Forest Project", "Mafungabusi", 180000],
  ["Sijarira Conservation Concession", "Sijarira", 90000],
  ["Dande Valley REDD+", "Dande Valley", 260000],
  ["Nyakasanga Forest Reserve", "Nyakasanga", 130000],
  ["Sebungwe Escarpment Project", "Sebungwe", 310000],
  ["Gokwe Forest Concession", "Gokwe", 150000],
];

const BAND_TARGETS = [92, 55, 78, 35, 88, 62, 45]; // spans consistent through severe

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

const MIN_CONTROLS = 8;
const KARIBA_CENTER = karibaParcel.center;
const apart = (c, others, deg) =>
  others.every((o) => Math.max(Math.abs(o.center[0] - c.center[0]), Math.abs(o.center[1] - c.center[1])) >= deg);

const candidates = CELLS
  .filter((c) => forestAt(c, WINDOW[0]) > 60 && c.protectedFrac < 0.6 && lossFraction(c, WINDOW[0], WINDOW[1]) > 0.005)
  .map((c) => ({ cell: c, cf: counterfactual(matchControls(c, CELLS).matches, WINDOW) }))
  .filter((x) => x.cf.n >= MIN_CONTROLS)
  .sort((a, b) => b.cf.n - a.cf.n);

const hosts = [];
for (const { cell } of candidates) {
  if (hosts.length >= SITES.length) break;
  if (apart(cell, [{ center: KARIBA_CENTER }, ...hosts], 1.0)) hosts.push(cell);
}
if (hosts.length < SITES.length) {
  console.log(`only found ${hosts.length} usable hosts of ${SITES.length} requested — continuing with what's available`);
}
console.log(`\nplacing ${hosts.length} illustrative projects:`);

const illustrative = [];
for (let i = 0; i < hosts.length; i++) {
  const host = hosts[i];
  const [name, shortName, areaHa] = SITES[i];
  const id = `KZ-${(1100 + i * 73).toString()}`;

  const halfKm = Math.sqrt(areaHa / 100) / 2;
  const [lon, lat] = host.center;
  const dLat = halfKm / 110.574;
  const dLon = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const bbox = [+(lon - dLon).toFixed(4), +(lat - dLat).toFixed(4), +(lon + dLon).toFixed(4), +(lat + dLat).toFixed(4)];

  process.stdout.write(`  ${id} ${shortName.padEnd(14)} measuring footprint...`);
  const { hash, areaHa: measuredHa } = await registerBboxGeostore(bbox);
  const m = await measureFootprint(hash);
  const areaKm2v = measuredHa / 100;
  console.log(" done");
  await sleep(150);

  const parcel = {
    id: `${id}-footprint`,
    bbox,
    center: host.center,
    label: host.label,
    areaKm2: +areaKm2v.toFixed(1),
    landKm2: +areaKm2v.toFixed(1),
    forest2008Km2: +m.forestFirstYear.toFixed(1),
    preClearedKm2: m.preClearedKm2,
    nonForestKm2: 0,
    waterKm2: 0,
    clearedByYear: m.clearedByYear,
    protectedFrac: host.protectedFrac,
    elevationM: host.elevationM,
    ruggednessM: host.ruggednessM,
    precipMmYr: host.precipMmYr,
  };

  const { matches } = matchControls(host, CELLS);
  const cf = counterfactual(matches, WINDOW);
  const p = BAND_TARGETS[i % BAND_TARGETS.length] / 100;
  const claimed = Math.min(0.55, Math.max(0.03, +quantile(cf.losses, p).toFixed(3)));
  // A smaller multiplier than the Amazon's (8) would floor almost every
  // credit volume identically: this pool's claimed fractions run much lower
  // (3-15%, against the Amazon's 12-48%), since real loss rates in this dry
  // savanna control pool are themselves much lower than Amazon rainforest.
  const creditsIssued = Math.max(80000, Math.round((areaHa * claimed * 35) / 10000) * 10000);

  illustrative.push({
    id, name, shortName,
    country: "Zimbabwe",
    locality: host.label ?? "Zambezi Valley",
    center: host.center,
    areaHa,
    seed: 1100 + i * 73,
    registry: "Illustrative record",
    methodology: "Reference-area baseline",
    startYear: WINDOW[0],
    creditingYears: WINDOW[1] - WINDOW[0] + 1,
    claimedBaselineLoss: claimed,
    creditsIssued,
    creditsRetired: Math.round(creditsIssued * (0.3 + ((i * 11) % 5) * 0.08)),
    pricePerCredit: +(4.5 + ((i * 7) % 9) * 0.5).toFixed(2),
    featured: false,
    real: false,
    hostCellId: host.id,
    parcel,
  });
  console.log(
    `    claims ${(claimed * 100).toFixed(1).padStart(5)}% · controls median ${(cf.median * 100).toFixed(1)}% · n=${cf.n}`
  );
}

// ── 3. assemble, REGION framed over every project ───────────────────────────
const PROJECTS = [karibaProject, ...illustrative];

const bboxOf = (rows, read) =>
  rows.reduce((b, r) => {
    const [rw, rs, re, rn] = read(r);
    return [Math.min(b[0], rw), Math.min(b[1], rs), Math.max(b[2], re), Math.max(b[3], rn)];
  }, [180, 90, -180, -90]);
const out = ([bw, bs, be, bn]) => [
  [Math.floor(bw * 100) / 100, Math.floor(bs * 100) / 100],
  [Math.ceil(be * 100) / 100, Math.ceil(bn * 100) / 100],
];
const bounds = out(bboxOf(PROJECTS, (p) => p.parcel.bbox));
const reach = out(bboxOf(CELLS, (c) => c.bbox));
const SLACK = 0.3;
const opening = (() => {
  const [[rw, rs], [re, rn]] = reach;
  const dx = ((re - rw) * SLACK) / 2;
  const dy = ((rn - rs) * SLACK) / 2;
  const inward = (v, dir) => (dir < 0 ? Math.ceil(v * 10) : Math.floor(v * 10)) / 10;
  return [[inward(rw - dx, -1), inward(rs - dy, -1)], [inward(re + dx, 1), inward(rn + dy, 1)]];
})();
const centre = [+((bounds[0][0] + bounds[1][0]) / 2).toFixed(2), +((bounds[0][1] + bounds[1][1]) / 2).toFixed(2)];
const box = (b) => "[[" + b[0][0] + ", " + b[0][1] + "], [" + b[1][0] + ", " + b[1][1] + "]]";

const js = `// projects-kariba.js — GENERATED by tools/make-project-kariba.mjs. Do not edit by hand.
//
// Kariba REDD+ (VCS 902) is a REAL, registered project (${'"'}real${'"'}: true) —
// its registry status, area, timeline and the Verra finding are real
// published facts, sourced in src/caseStudies.js. Its boundary is an
// approximation (see this file's header comment and boundaryApproximate
// below); what is directly measured is Hansen-derived forest loss over that
// approximate footprint, via the legacy GFW v1 API (tools/gfw.mjs), since
// PRODES does not cover Zimbabwe.
//
// The rest are illustrative, built the same way src/projects.js's Amazon
// projects are: real measured footprints, invented claims and credits.

export const REGION = {
  name: "Zambezi Valley, Zimbabwe",
  center: [${centre[0]}, ${centre[1]}],
  zoom: 6.2,
  bounds: ${box(bounds)},
  reach: ${box(reach)},
  slack: ${SLACK},
  maxBounds: ${box(opening)},
  window: [${WINDOW[0]}, ${WINDOW[1]}],
  referencePeriod: [${FIRST_YEAR}, ${FIRST_YEAR + 7}],
};

export const PROJECTS = ${JSON.stringify(PROJECTS, null, 2)};
`;
writeFileSync(`${ROOT}/src/projects-kariba.js`, js);
console.log(`\nwrote src/projects-kariba.js — ${PROJECTS.length} projects (1 real, ${illustrative.length} illustrative)`);
