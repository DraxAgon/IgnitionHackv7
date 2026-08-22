// scripts/bake-map-data.mjs — pre-render the map's geometry from public sources.
//
//   node scripts/bake-map-data.mjs           resume from .cache/
//   node scripts/bake-map-data.mjs --fresh   refetch everything
//
// Two products, both written to public/mapdata/ and both real measurements:
//
//   loss-{projectId}.json  INPE PRODES annual clear-cut polygons across the
//                          project's footprint, tagged with the year they were
//                          detected and split by whether they fall inside the
//                          project boundary. This is what makes the year slider
//                          mean something: stepping forward reveals the clearing
//                          that actually happened that year, not a fade between
//                          two similar satellite mosaics.
//
//   parcels.json           The forested part of each comparable parcel, computed
//                          as the parcel box minus water, minus mapped non-forest,
//                          minus everything already cleared before the crediting
//                          window opened. Drawn instead of the raw one-degree box.
//
// That last one is worth being precise about. The comparison is computed on
// one-degree parcels, so a parcel IS a box and drawing an invented organic shape
// would be a lie about the unit of analysis. But the loss *rate* for a parcel is
// measured against its forest area, not its total area — so the forested part of
// the box is both the honest referent for the statistic and, on the frontier
// parcels these projects actually match against, a genuinely ragged shape.
//
// Baking rather than fetching live is deliberate: no rate limits, no dead
// endpoint in front of an audience, and the exact bytes shipped are reviewable.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as turf from "@turf/turf";

// cells.js imports its JSON through Vite, which Node cannot resolve without an
// import attribute, so the dataset is read from disk here instead.
const CELLS = JSON.parse(readFileSync(new URL("../src/cells.json", import.meta.url), "utf8")).cells;
import { PROJECTS } from "../src/projects.js";
import { boundaryLonLat } from "../src/geometry.js";
import { matchControls, WINDOW } from "../src/baseline.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = `${ROOT}/public/mapdata`;
const CACHE = `${ROOT}/.cache/mapdata`;

const WFS =
  "https://terrabrasilis.dpi.inpe.br/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&srsName=EPSG:4326";
const WS = "prodes-legal-amz";

// One pixel at the zoom a project fills the screen is roughly 55 m, so
// simplifying to 0.0005 degrees is invisible and cuts the payload by a third.
const TOLERANCE = 0.0005;
const COORD_DP = 4; // ~11 m
const MIN_AREA_KM2 = 0.02; // PRODES maps down to 6.25 ha; below this is noise
const MAX_MASK_PARTS = 80; // largest mask polygons kept when outlining a parcel
const FIRST_YEAR = 2008;
const LAST_YEAR = WINDOW[1];

const fresh = process.argv.includes("--fresh");
for (const dir of [OUT, CACHE]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(240000) });
      if (r.ok) return await r.text();
      if (r.status === 429 || r.status >= 500) {
        await sleep(Math.min(30000, 2000 * 2 ** i));
        continue;
      }
      throw new Error(`http ${r.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(Math.min(30000, 1500 * 2 ** i));
    }
  }
  throw new Error("exhausted retries");
}

/** Fetch one WFS layer inside a bbox, cached on disk by layer+bbox. */
async function layerIn(layer, bbox) {
  const key = `${layer}_${bbox.map((v) => v.toFixed(3)).join("_")}.json`.replace(/-/g, "m");
  const path = `${CACHE}/${key}`;
  if (!fresh && existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const url = `${WFS}&typeName=${WS}:${layer}&bbox=${bbox.join(",")}&outputFormat=application/json`;
  const doc = JSON.parse(await getText(url));
  writeFileSync(path, JSON.stringify(doc));
  return doc;
}

// ── geometry helpers ───────────────────────────────────────────────────────

const round = (c, p = COORD_DP) =>
  Array.isArray(c[0]) ? c.map((x) => round(x, p)) : [+c[0].toFixed(p), +c[1].toFixed(p)];

/** Simplify and round one geometry, dropping anything that collapses. */
function tidy(geometry, tolerance = TOLERANCE) {
  if (!geometry?.coordinates?.length) return null;
  let g = geometry;
  try {
    g = turf.simplify(turf.feature(g), { tolerance, highQuality: false, mutate: false }).geometry;
  } catch {
    /* keep the unsimplified ring rather than losing the feature */
  }
  if (!g?.coordinates?.length) return null;
  return { type: g.type, coordinates: round(g.coordinates) };
}

const boxPolygon = ([w, s, e, n]) =>
  turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);

/**
 * Union a list of features, tolerating the self-intersections real data carries.
 *
 * Pairwise and balanced, not accumulated left to right. Folding 80 polygons into
 * a single running total means every step unions against an ever-larger, ever-
 * more-complex blob, and the cost climbs with it — measured at roughly three
 * minutes per parcel. Merging neighbours in rounds keeps both operands small
 * until the very end and takes seven rounds instead of eighty steps.
 */
function unionAll(features) {
  let level = features.filter((f) => f?.geometry?.coordinates?.length);
  if (!level.length) return null;

  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1];
      if (!b) { next.push(a); continue; }
      let merged = null;
      try {
        merged = turf.union(turf.featureCollection([a, b]));
      } catch {
        // A ring the library will not merge is repaired and retried once; if it
        // still refuses, both parts are carried forward separately rather than
        // dropping either from the mask.
        try {
          merged = turf.union(turf.featureCollection([safeBuffer(a), safeBuffer(b)]));
        } catch {
          merged = null;
        }
      }
      if (merged) next.push(merged);
      else next.push(a, b);
    }
    if (next.length === level.length) break; // nothing merged; stop rather than spin
    level = next;
  }
  return level[0] ?? null;
}

/** A zero-width buffer repairs most invalid rings that come out of a WFS. */
function safeBuffer(feature) {
  try {
    return turf.buffer(feature, 0, { units: "meters" }) ?? feature;
  } catch {
    return feature;
  }
}

function difference(base, subtractor) {
  if (!subtractor) return base;
  try {
    return turf.difference(turf.featureCollection([base, subtractor])) ?? base;
  } catch {
    return base;
  }
}

function intersect(a, b) {
  try {
    return turf.intersect(turf.featureCollection([a, b]));
  } catch {
    return null;
  }
}

// ── the project loss overlay ───────────────────────────────────────────────

/** Grow a bbox by a margin in degrees, so the overlay covers the drawn polygon. */
const grow = ([w, s, e, n], m) => [w - m, s - m, e + m, n + m];

async function bakeProjectLoss(project) {
  const outPath = `${OUT}/loss-${project.id}.json`;
  const ring = boundaryLonLat(project);
  const footprint = turf.polygon([ring]);
  const bbox = grow(turf.bbox(footprint), 0.02);

  process.stdout.write(`  ${project.shortName.padEnd(12)} fetching… `);
  const doc = await layerIn("yearly_deforestation", bbox);
  process.stdout.write(`${doc.features.length} polygons → `);

  const inside = [];
  const outside = [];
  const [fw, fs_, fe, fn] = turf.bbox(footprint);

  for (const f of doc.features) {
    const year = Number(f.properties?.year);
    if (!Number.isFinite(year) || year < FIRST_YEAR || year > LAST_YEAR) continue;
    if ((f.properties?.area_km ?? 0) < MIN_AREA_KM2) continue;
    if (!f.geometry?.coordinates?.length) continue;

    const g = tidy(f.geometry);
    if (!g) continue;

    // Assign each polygon to a side by its centroid rather than clipping it.
    //
    // Clipping every polygon against the boundary is exact and far too slow -
    // a project bbox holds several thousand of them and each boolean op costs
    // milliseconds. The error this trades for speed is one polygon's worth of
    // red on the wrong side of the line, and PRODES maps down to 6.25 ha
    // against a project of roughly 5,500 km², so a straddling polygon is a
    // rounding error on the outline of an already illustrative boundary.
    //
    // Nothing numeric depends on this. Every figure in the interface comes from
    // the parcel measurements in cells.json, not from these outlines - this
    // layer exists so a viewer can see where and when the clearing happened.
    let cx = 0, cy = 0;
    try {
      const c = turf.centroid(turf.feature(g)).geometry.coordinates;
      cx = c[0]; cy = c[1];
    } catch {
      continue;
    }
    const near = cx >= fw && cx <= fe && cy >= fs_ && cy <= fn;
    let within = false;
    if (near) {
      try {
        within = turf.booleanPointInPolygon([cx, cy], footprint);
      } catch {
        within = false;
      }
    }
    (within ? inside : outside).push({ type: "Feature", properties: { y: year }, geometry: g });
  }

  const payload = {
    project: project.id,
    source: "INPE PRODES yearly_deforestation via TerraBrasilis WFS",
    firstYear: FIRST_YEAR,
    lastYear: LAST_YEAR,
    note: "Annual clear-cut increments. Real measurements, tagged by detection year.",
    inside: { type: "FeatureCollection", features: inside },
    outside: { type: "FeatureCollection", features: outside },
  };
  writeFileSync(outPath, JSON.stringify(payload));
  const mb = (Buffer.byteLength(JSON.stringify(payload)) / 1e6).toFixed(2);
  console.log(`${inside.length} inside, ${outside.length} around · ${mb} MB`);
}

// ── the comparable parcels ─────────────────────────────────────────────────

/**
 * The forested part of a parcel: the box, less water, less mapped non-forest,
 * less everything cleared before the crediting window opened.
 *
 * Frontier parcels — the ones these projects actually match against — come back
 * genuinely ragged, because that is the shape of the forest that is left. A
 * parcel deep in intact forest stays close to its box, which is also the truth
 * and is drawn as such rather than being roughened to look busier.
 */
async function bakeParcel(cell) {
  const box = boxPolygon(cell.bbox);
  const masks = [];

  for (const layer of ["hydrography", "no_forest", "accumulated_deforestation_2007"]) {
    let doc;
    try {
      doc = await layerIn(layer, cell.bbox);
    } catch (e) {
      console.log(`    ${cell.id} ${layer}: ${e.message}`);
      continue;
    }
    for (const f of doc.features ?? []) {
      if (!f.geometry?.coordinates?.length) continue;
      if ((f.properties?.area_km ?? 1) < MIN_AREA_KM2) continue;
      masks.push(turf.feature(f.geometry));
    }
  }

  // Clearing during the pre-window years is also gone by the time the
  // comparison starts, so it belongs in the mask too.
  try {
    const yearly = await layerIn("yearly_deforestation", cell.bbox);
    for (const f of yearly.features ?? []) {
      const year = Number(f.properties?.year);
      if (!Number.isFinite(year) || year >= WINDOW[0]) continue;
      if ((f.properties?.area_km ?? 0) < MIN_AREA_KM2) continue;
      if (!f.geometry?.coordinates?.length) continue;
      masks.push(turf.feature(f.geometry));
    }
  } catch (e) {
    console.log(`    ${cell.id} yearly: ${e.message}`);
  }

  // Union every mask polygon exactly would cost thousands of boolean ops per
  // parcel and take hours. The shape a viewer actually reads at parcel zoom is
  // set by the big features — the rivers, the large cleared blocks — so the
  // mask is built from the largest of them, simplified first. Scattered small
  // clearings are left in the outline rather than punched out; they are below
  // a pixel at this zoom either way.
  const ranked = masks
    .map((f) => {
      let a = 0;
      try { a = turf.area(f); } catch { a = 0; }
      return { f, a };
    })
    .filter((m) => m.a > 0)
    .sort((x, y) => y.a - x.a)
    .slice(0, MAX_MASK_PARTS)
    .map((m) => {
      try {
        return turf.simplify(m.f, { tolerance: 0.002, highQuality: false, mutate: false });
      } catch {
        return m.f;
      }
    });

  const mask = unionAll(ranked);
  const forest = difference(box, mask);
  const geometry = forest?.geometry ? tidy(forest.geometry, TOLERANCE * 4) : null;
  let coverage = 1;
  try {
    coverage = geometry ? turf.area(turf.feature(geometry)) / turf.area(box) : 1;
  } catch {
    coverage = 1;
  }
  return { geometry, coverage, masked: ranked.length };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("Baking map geometry from INPE PRODES (TerraBrasilis WFS).\n");

  console.log("Project loss overlays:");
  for (const project of PROJECTS) {
    try {
      await bakeProjectLoss(project);
    } catch (e) {
      console.log(`  ${project.shortName}: FAILED ${e.message}`);
    }
  }

  // Only the parcels that some project actually matches against — baking all
  // 277 would take hours to produce geometry nothing draws.
  const needed = new Map();
  for (const project of PROJECTS) {
    const host = CELLS.find((c) => c.id === project.hostCellId);
    if (!host) continue;
    for (const m of matchControls(host, CELLS).matches) needed.set(m.cell.id, m.cell);
  }
  console.log(`\nComparable parcels (${needed.size} matched across ${PROJECTS.length} projects):`);

  const parcels = {};
  let done = 0;
  for (const cell of needed.values()) {
    done++;
    try {
      const { geometry, coverage, masked } = await bakeParcel(cell);
      if (!geometry) {
        console.log(`  [${done}/${needed.size}] ${cell.id} — no geometry, keeping box`);
        continue;
      }
      parcels[cell.id] = geometry;
      console.log(
        `  [${done}/${needed.size}] ${cell.id.padEnd(10)} forest ${(coverage * 100).toFixed(0)}% of box · ${masked} mask polygons`
      );
    } catch (e) {
      console.log(`  [${done}/${needed.size}] ${cell.id}: ${e.message}`);
    }
  }

  const payload = {
    source: "INPE PRODES via TerraBrasilis WFS",
    note:
      "Forested portion of each one-degree comparable parcel: the box less water, " +
      "mapped non-forest, and clearing that predates the crediting window. The parcel " +
      "remains the unit of analysis; this is the part of it the loss rate is measured against.",
    window: WINDOW,
    parcels,
  };
  writeFileSync(`${OUT}/parcels.json`, JSON.stringify(payload));
  console.log(
    `\nWrote ${Object.keys(parcels).length} parcel outlines · ` +
      `${(Buffer.byteLength(JSON.stringify(payload)) / 1e6).toFixed(2)} MB`
  );
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
