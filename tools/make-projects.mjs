// tools/make-projects.mjs — build the project records.
//
//   node tools/make-projects.mjs      (needs src/cells.json from collect.mjs)
//
// Each project gets its own PRODES measurement over its own footprint, so the
// observed deforestation inside a project is real, not inherited from the parcel
// grid. What stays invented is the CLAIM: the baseline the project asserts, its
// credit volumes, and its name. Those are chosen to span the risk range so the
// interface can be exercised end to end.
//
// The distinction to hold on to: the claim is illustrative, the check is real.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sumInBbox, boxAreaKm2, elevationFor, precipitationFor, sleep } from "./prodes.mjs";
import { matchControls, counterfactual, forestAt, lossFraction, WINDOW, REFERENCE_PERIOD } from "../src/baseline.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cellsDoc = JSON.parse(readFileSync(`${ROOT}/src/cells.json`, "utf8"));
const CELLS = cellsDoc.cells;
const CACHE = `${ROOT}/.cache`;
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
const cachePath = `${CACHE}/projects.json`;
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

// Fictional names, real coordinates. Areas in the range real REDD+ projects occupy.
const SITES = [
  ["Rio Aripuanã Conservation Concession", "Aripuanã", 640000],
  ["Serra do Cachimbo REDD+", "Cachimbo", 820000],
  ["Igarapé Tucumã Forest Project", "Tucumã", 310000],
  ["Alto Juruena REDD+", "Juruena", 470000],
  ["Castanheira Forest Reserve", "Castanheira", 260000],
  ["Vale do Guaporé REDD+", "Guaporé", 730000],
  ["Rio Manicoré Conservation", "Manicoré", 550000],
  ["Serra Verde REDD+", "Serra Verde", 390000],
  ["Baixo Xingu Forest Project", "Baixo Xingu", 880000],
  ["Rio Tapauá REDD+", "Tapauá", 420000],
  ["Campos Lindos Conservation", "Campos Lindos", 200000],
  ["Alto Purus Forest Reserve", "Alto Purus", 610000],
  ["Rio Anajás Forest Project", "Anajás", 350000],
  ["Alto Maués Conservation", "Maués", 700000],
  ["Rio Abacaxis REDD+", "Abacaxis", 480000],
  ["Baixo Madeira Forest Reserve", "Baixo Madeira", 560000],
  ["Rio Uatumã Forest Project", "Uatumã", 290000],
  ["Rio Jutaí Conservation", "Jutaí", 410000],
  ["Rio Arapiuns REDD+", "Arapiuns", 330000],
  ["Alto Tapajós Forest Project", "Alto Tapajós", 760000],
];

// Where each project's claimed baseline should sit inside its own control
// distribution. Ordered so that every risk band is represented from the first
// few projects onward — how many hosts survive selection varies with the data,
// and a truncated list would quietly drop the low-risk end of the scale, which
// is the half that proves the tool can clear a project rather than only flag one.
const BAND_TARGETS = [
  99.5, 96, 91, 83, 70, 52, 35, 97, 88, 76, 61, 44,
  // Appended, never reordered: the first seven of these targets land on the
  // seven already-published projects (see PUBLISHED below), so changing an
  // earlier entry silently rewrites a project a viewer may already have seen.
  90, 79, 66, 48, 30, 85, 72, 57,
];
const targetFor = (i) => BAND_TARGETS[i % BAND_TARGETS.length];

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

// Pick hosts by the quality of the comparison they can support, not by how much
// forest they hold. Most of the Amazon is quiet: a parcel whose matched controls
// all lost ~0% yields a technically valid but unreadable audit, where a "severe"
// baseline means claiming 2% against 0.1%. Requiring a real control distribution
// puts every project somewhere the counterfactual actually has something to say.
//
// Of the two filters, the control MEDIAN is the one doing the work: 103 parcels
// clear the count floor, and 25 clear both. The count floor is a floor on how
// finely the percentile can be read — with n controls the highest percentile a
// claim can reach is (n-1)/n — so it is set at the point where the top band is
// still reachable by the hosts that are ranked into it, and no lower.
const MIN_CONTROLS = 8;
const MIN_CONTROL_MEDIAN = 0.004;

// The host must also have been cleared itself, which the two filters above do
// not imply: they describe the host's CONTROLS, and a quiet parcel can sit
// beside busy ones. Widening the pool turned up three such hosts — two on the
// Maranhão edge and one in southern Rondônia — where PRODES records under 7 km²
// of clearing in sixteen years across a parcel of twelve thousand.
//
// The audit still computes on those, and that is the trap: it reads "severe"
// off a control distribution while the project's own footprint returns 0.0% and
// the map draws an empty frame, because a WFS query over the whole footprint
// comes back with zero polygons. The map's one job is to show the clearing
// inside the boundary against the clearing around it. A host with nothing to
// show cannot do that job, whatever the arithmetic says.
//
// The floor is well clear of both groups: the quietest host that survives lost
// 2.2% of its forest over the window, the loudest that does not lost 0.11%.
const MIN_HOST_LOSS = 0.01;

const candidates = CELLS.filter(
  (c) =>
    forestAt(c, WINDOW[0]) > 2000 &&
    c.protectedFrac < 0.6 &&
    lossFraction(c, WINDOW[0], WINDOW[1]) >= MIN_HOST_LOSS
)
  .map((c) => {
    const { matches } = matchControls(c, CELLS);
    return { cell: c, cf: counterfactual(matches) };
  })
  .filter((x) => x.cf.n >= MIN_CONTROLS && x.cf.median >= MIN_CONTROL_MEDIAN)
  .sort((a, b) => b.cf.median - a.cf.median);

// Hosts already published, in the order they were placed.
//
// The rest of this file addresses a project by its position in `hosts`: the id
// is `PJ-4100 + i*137`, the name is `SITES[i]`, the claim comes from a target
// ranked against the other hosts, and `public/mapdata/loss-{id}.json` is baked
// against the footprint that produces. So widening the candidate pool — which
// is the whole point of lowering MIN_CONTROLS — would otherwise renumber every
// project behind the new arrivals, hand their names to different forest, and
// orphan every baked overlay. Pinning the published prefix makes each later run
// additive: these seven keep their ids, names, claims and overlays, and new
// hosts land after them.
//
// Remove an entry here only alongside the project record and overlay it names.
const PUBLISHED = ["C-60_-10", "C-56_-8", "C-66_-10", "C-65_-13", "C-64_-9", "C-70_-11", "C-52_-3"];

const apart = (c, hosts, deg) =>
  hosts.every((h) => Math.max(Math.abs(h.center[0] - c.center[0]), Math.abs(h.center[1] - c.center[1])) >= deg);

const hosts = [];
for (const id of PUBLISHED) {
  const cell = CELLS.find((c) => c.id === id);
  if (!cell) throw new Error(`published host ${id} is no longer in cells.json`);
  hosts.push(cell);
}
const anchored = hosts.length;
for (const { cell } of candidates) {
  if (hosts.length >= SITES.length) break;
  // Parcels are one degree, so this admits no two hosts in adjacent cells. It
  // is a legibility rule, not a methodological one — the leakage buffer in
  // matchControls already keeps each host out of the other's control pool.
  if (!hosts.some((h) => h.id === cell.id) && apart(cell, hosts, 1.5)) hosts.push(cell);
}
if (!hosts.length) throw new Error("no parcel has a usable control distribution — widen the pool");
console.log(
  `placing ${hosts.length} projects across ${CELLS.length} parcels ` +
    `(${anchored} already published, ${hosts.length - anchored} new)\n`
);

// The strongest claims go to the hosts with the most controls. A percentile
// cannot exceed (n-1)/n, so targeting the top band on a thinly-supported host
// silently downgrades it; this puts the extreme cases where the evidence can
// actually carry them.
//
// Ranked in two blocks, published hosts first, so the ranks the published seven
// hold are the ranks they held when their claims were generated. Ranking all
// hosts together would let a newly-admitted parcel with a large control set
// displace them and quietly rewrite the claims already on screen.
const hostCf = hosts.map((h) => counterfactual(matchControls(h, CELLS).matches));
const byCount = (idx) => idx.sort((a, b) => hostCf[b].n - hostCf[a].n);
const byControls = [
  ...byCount(hosts.map((_, i) => i).filter((i) => i < anchored)),
  ...byCount(hosts.map((_, i) => i).filter((i) => i >= anchored)),
];
const targetByHost = [];
byControls.forEach((hostIndex, rank) => { targetByHost[hostIndex] = targetFor(rank); });

const projects = [];
for (let i = 0; i < hosts.length; i++) {
  const host = hosts[i];
  const [name, shortName, areaHa] = SITES[i];
  const id = `PJ-${(4100 + i * 137).toString()}`;

  // Square footprint of the stated area, centred on the host parcel.
  const halfKm = Math.sqrt(areaHa / 100) / 2;
  const [lon, lat] = host.center;
  const dLat = halfKm / 110.574;
  const dLon = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const bbox = [+(lon - dLon).toFixed(4), +(lat - dLat).toFixed(4), +(lon + dLon).toFixed(4), +(lat + dLat).toFixed(4)];

  // Cached against the footprint, not the project id. A measurement is a fact
  // about a box of land; a project id is a position in a list that moves when
  // the candidate pool changes. Keyed by id, tightening a filter re-points an
  // id at a different parcel and the cache then serves that parcel the previous
  // occupant's deforestation — silently, and only in the numbers.
  const key = bbox.join(",");
  let measured = cache[key];
  if (!measured) {
    process.stdout.write(`  ${id} ${shortName} — measuring footprint...`);
    // Deforestation is measured directly on the footprint — it is the number the
    // whole audit turns on. The non-forest and water corrections are inherited
    // from the host parcel by area share; they only adjust the denominator, and
    // querying them doubles the load on a service that is already throttling.
    const cleared = await sumInBbox("yearly_deforestation", bbox, true);
    const preCleared = await sumInBbox("accumulated_deforestation_2007", bbox);
    const areaKm2 = boxAreaKm2(...bbox);
    const share = host.areaKm2 > 0 ? areaKm2 / host.areaKm2 : 0;
    const clearedByYear = {};
    for (let y = cellsDoc.firstYear; y <= cellsDoc.lastYear; y++)
      clearedByYear[y] = +(cleared[y] ?? 0).toFixed(3);
    const m = {
      areaKm2: +areaKm2.toFixed(1),
      preClearedKm2: +preCleared.toFixed(1),
      nonForestKm2: +(host.nonForestKm2 * share).toFixed(1),
      waterKm2: +(host.waterKm2 * share).toFixed(1),
      clearedByYear,
      inherited: ["nonForestKm2", "waterKm2"],
    };
    // Terrain and rainfall come from the host parcel, which contains this
    // footprint. Re-deriving them buys nothing and costs Open-Meteo calls; when
    // its quota is spent those calls only burn the retry ladder before failing,
    // so a null is simply carried through and the matching skips that covariate.
    measured = {
      ...m,
      elevationM: host.elevationM ?? null,
      ruggednessM: host.ruggednessM ?? null,
      precipMmYr: host.precipMmYr ?? null,
    };
    cache[key] = measured;
    writeFileSync(cachePath, JSON.stringify(cache));
    console.log(" done");
    await sleep(300);
  }

  const land = Math.max(1, measured.areaKm2 - measured.waterKm2);
  const parcel = {
    id: `${id}-footprint`,
    bbox,
    center: host.center,
    label: host.label,
    areaKm2: measured.areaKm2,
    landKm2: +land.toFixed(1),
    forest2008Km2: +Math.max(0, land - measured.preClearedKm2 - measured.nonForestKm2).toFixed(1),
    preClearedKm2: measured.preClearedKm2,
    nonForestKm2: measured.nonForestKm2,
    waterKm2: measured.waterKm2,
    clearedByYear: measured.clearedByYear,
    protectedFrac: host.protectedFrac,
    elevationM: measured.elevationM,
    ruggednessM: measured.ruggednessM,
    precipMmYr: measured.precipMmYr,
  };

  // Match on the HOST PARCEL, not the footprint. Controls are one-degree
  // parcels, so comparing a smaller footprint against them is a scale mismatch:
  // covariates like forest share shift with the window you measure them in, and
  // the match count collapsed to single digits when it was done that way. The
  // footprint is still what the project's own observed loss is read from.
  const { matches } = matchControls(host, CELLS);
  const cf = counterfactual(matches);
  const p = targetByHost[i] / 100;
  // Clamp to the range real REDD+ baselines occupy. A low floor matters: without
  // it every project claims more than the controls and none can come back clean.
  const claimed = Math.min(0.6, Math.max(0.02, +quantile(cf.losses, p).toFixed(3)));

  const creditsIssued = Math.round((areaHa * claimed * 8) / 100000) * 100000;
  projects.push({
    id, name, shortName,
    country: "Brazil",
    locality: host.label ?? "Legal Amazon", // nearest municipality, for orientation
    center: host.center,
    areaHa,
    seed: 4100 + i * 137,
    registry: "Illustrative record",
    methodology: "Reference-area baseline",
    startYear: WINDOW[0],
    creditingYears: WINDOW[1] - WINDOW[0] + 1,
    claimedBaselineLoss: claimed,
    creditsIssued: Math.max(200000, creditsIssued),
    creditsRetired: Math.round(Math.max(200000, creditsIssued) * (0.35 + ((i * 7) % 5) * 0.09)),
    pricePerCredit: +(4.2 + ((i * 13) % 9) * 0.55).toFixed(2),
    featured: i < 2,
    hostCellId: host.id, // matching target, in cells.json
    parcel, // the project's own footprint, measured directly
  });
  console.log(
    `  ${id} ${shortName.padEnd(14)} claims ${(claimed * 100).toFixed(1).padStart(5)}% · ` +
      `controls median ${(cf.median * 100).toFixed(1)}% · n=${cf.n}`
  );
}

// ── the boxes the camera is built out of ───────────────────────────────────
// Measured off the data rather than typed in, because a hand-written frame is a
// frame that silently stops matching what it is supposed to be framing the first
// time a project moves.
const bbox = (rows, read) =>
  rows.reduce(
    (b, r) => {
      const [w, s, e, n] = read(r);
      return [Math.min(b[0], w), Math.min(b[1], s), Math.max(b[2], e), Math.max(b[3], n)];
    },
    [180, 90, -180, -90]
  );
// Rounded outward, so rounding can only ever add ground to a frame and never
// crop a project off the edge of one.
const out = ([w, s, e, n]) => [
  [Math.floor(w * 100) / 100, Math.floor(s * 100) / 100],
  [Math.ceil(e * 100) / 100, Math.ceil(n * 100) / 100],
];

// What the overview frames: the project footprints, and nothing else.
const bounds = out(bbox(projects, (p) => p.parcel.bbox));
// Everything the map is able to draw.
const reach = out(bbox(CELLS, (c) => c.bbox));
// Air around the region, as a fraction of each axis, split between the two
// sides. MapView reuses this number once it knows how big the window is.
const SLACK = 0.25;
// The opening barrier, rounded INWARD so it stays a subset of every barrier
// MapView can compute — a value that holds for one second before the map loads
// must not be tighter than the frame that follows it, or it clamps it.
const opening = (() => {
  const [[w, s], [e, n]] = reach;
  const dx = ((e - w) * SLACK) / 2;
  const dy = ((n - s) * SLACK) / 2;
  const inward = (v, dir) => (dir < 0 ? Math.ceil(v * 10) : Math.floor(v * 10)) / 10;
  return [[inward(w - dx, -1), inward(s - dy, -1)], [inward(e + dx, 1), inward(n + dy, 1)]];
})();
const centre = [+((bounds[0][0] + bounds[1][0]) / 2).toFixed(2), +((bounds[0][1] + bounds[1][1]) / 2).toFixed(2)];
const box = (b) => "[[" + b[0][0] + ", " + b[0][1] + "], [" + b[1][0] + ", " + b[1][1] + "]]";

const js = `// projects.js — GENERATED by tools/make-projects.mjs. Do not edit by hand.
//
// Project names, registry status, claimed baselines and credit volumes are
// ILLUSTRATIVE. They are not real registry entries and name no real party.
//
// What is real: \`parcel\`, the INPE PRODES deforestation measured over each
// project's own footprint, and every control it is compared against.
//
// To add a real registered project, append a record with its published boundary,
// registry reference, methodology and baseline, then write its sourced case
// study in caseStudies.js.

export const REGION = {
  name: "Brazilian Legal Amazon",
  center: [${centre[0]}, ${centre[1]}],
  zoom: 5.1,
  // What the overview frames: every project footprint on the map, and nothing
  // else. This used to be the whole parcel grid — 31 by 22 degrees, most of it
  // ground the overview never draws on — which cost about two thirds of a zoom
  // stop and left the thirteen projects huddled in the middle of empty forest.
  bounds: ${box(bounds)},
  // Every parcel the map is able to draw. Comparables are matched on covariates
  // rather than on distance, so one can land anywhere in this grid, and a viewer
  // has to be able to pan to whatever the map has drawn. That is the only reason
  // the barrier is ever wider than the frame.
  reach: ${box(reach)},
  // Air left around the region, as a fraction of each axis, split between the
  // two sides. Room to move, well short of the whole continent.
  slack: ${SLACK},
  // The barrier that holds until the first frame lands, and nothing more.
  //
  // maplibre will not let the viewport show more than maxBounds, so it raises
  // the zoom floor until the bounds fill the window: the bounds, not minZoom,
  // are what set the limit. That makes a hand-written barrier a trap. Draw it
  // tight and it forbids the very overview it exists to protect — which is how
  // the old 35-degree box made its own shipped z4.3 unreachable. Draw it loose
  // enough to be safe at every window size and zooming out lands on Peru.
  //
  // The size that is right depends on the window, because padding is paid in
  // pixels and not in degrees: under 900px the panel becomes a bottom sheet over
  // half the screen, and framing the projects above it means rendering a lot of
  // empty map below them. So MapView measures the barrier off the overview it
  // actually produced (see \`panBarrier\`) rather than guessing here. This value
  // only has to hold for the second before the map loads, and it is a subset of
  // every barrier that computation can return.
  maxBounds: ${box(opening)},
};

export const PROJECTS = ${JSON.stringify(projects, null, 2)};
`;
writeFileSync(`${ROOT}/src/projects.js`, js);
console.log(`\nwrote src/projects.js — ${projects.length} projects`);
