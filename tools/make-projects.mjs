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
import { measureBbox, elevationFor, precipitationFor, sleep } from "./prodes.mjs";
import { matchControls, counterfactual, forestAt, WINDOW, REFERENCE_PERIOD } from "../src/baseline.js";

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
];

// Target risk bands, by percentile of the claimed baseline within the controls.
const TARGET_PERCENTILE = [99.5, 98, 96, 95.5, 92, 89, 86, 78, 71, 64, 45, 28];

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

// Pick host parcels: forested, spread out, and varied in deforestation pressure.
const eligible = CELLS.filter((c) => forestAt(c, WINDOW[0]) > 3000 && c.protectedFrac < 0.5)
  .sort((a, b) => b.forest2008Km2 - a.forest2008Km2);
const hosts = [];
for (const c of eligible) {
  if (hosts.length >= SITES.length) break;
  if (hosts.every((h) => Math.max(Math.abs(h.center[0] - c.center[0]), Math.abs(h.center[1] - c.center[1])) >= 3.0))
    hosts.push(c);
}
if (hosts.length < SITES.length) {
  for (const c of eligible) {
    if (hosts.length >= SITES.length) break;
    if (!hosts.includes(c) && hosts.every((h) => Math.max(Math.abs(h.center[0] - c.center[0]), Math.abs(h.center[1] - c.center[1])) >= 1.6))
      hosts.push(c);
  }
}
console.log(`placing ${hosts.length} projects across ${CELLS.length} parcels\n`);

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

  let measured = cache[id];
  if (!measured) {
    process.stdout.write(`  ${id} ${shortName} — measuring footprint...`);
    const m = await measureBbox(bbox, cellsDoc.firstYear, cellsDoc.lastYear);
    const elev = await elevationFor(bbox);
    const precipMmYr = await precipitationFor(host.center);
    measured = { ...m, ...elev, precipMmYr };
    cache[id] = measured;
    writeFileSync(cachePath, JSON.stringify(cache));
    console.log(" done");
    await sleep(400);
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

  // Set the claimed baseline so it lands in the intended band of the real
  // control distribution. The distribution is measured; the claim is the knob.
  const { matches } = matchControls(parcel, CELLS);
  const cf = counterfactual(matches);
  const p = TARGET_PERCENTILE[i] / 100;
  const claimed = Math.min(0.6, Math.max(0.08, +quantile(cf.losses, p).toFixed(3)));

  const creditsIssued = Math.round((areaHa * claimed * 8) / 100000) * 100000;
  projects.push({
    id, name, shortName,
    country: "Brazil",
    state: host.label ?? "Legal Amazon",
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
    parcel,
  });
  console.log(
    `  ${id} ${shortName.padEnd(14)} claims ${(claimed * 100).toFixed(1).padStart(5)}% · ` +
      `controls median ${(cf.median * 100).toFixed(1)}% · n=${cf.n}`
  );
}

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
  center: [-58.5, -6.5],
  zoom: 4.3,
  maxBounds: [[-76, -19], [-41, 7]],
};

export const PROJECTS = ${JSON.stringify(projects, null, 2)};
`;
writeFileSync(`${ROOT}/src/projects.js`, js);
console.log(`\nwrote src/projects.js — ${projects.length} projects`);
