// tools/collect.mjs — build the control-parcel dataset from public APIs.
//
//   node tools/collect.mjs           resume (skips cells already cached)
//   node tools/collect.mjs --fresh   ignore the cache
//
// Sources, all public and keyless:
//   INPE PRODES (TerraBrasilis WFS) — official Brazilian Amazon deforestation.
//     Annual clear-cut increments, pre-2008 accumulated clearing, non-forest and
//     hydrography masks, conservation units, indigenous lands, municipalities.
//   Open-Meteo — elevation and precipitation, for the matching covariates.
//
// Output: src/cells.json — one record per 1-degree parcel of the Legal Amazon.
// Nothing here is modelled or predicted; it is all observed history.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE = `${ROOT}/.cache`;
const WFS = "http://terrabrasilis.dpi.inpe.br/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&srsName=EPSG:4326";
const WS = "prodes-legal-amz";

// The region. Widen CELL to trade resolution for collection time.
const CELL = 1.0; // degrees
const BOUNDS = { west: -74, south: -18, east: -43, north: 6 };
const FIRST_YEAR = 2008; // PRODES annual increments start here in this layer
const LAST_YEAR = 2023; // 2024+ are still being published; excluded as partial

const AREA_LAYERS = {
  cleared: "yearly_deforestation", // annual, carries `year`
  preCleared: "accumulated_deforestation_2007", // everything lost before 2008
  nonForest: "no_forest",
  water: "hydrography",
};

const fresh = process.argv.includes("--fresh");
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
const cachePath = `${CACHE}/cells.json`;
const cache = !fresh && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, tries = 7) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (r.ok) return await r.text();
      // 429/503 mean "slow down", not "give up".
      if (r.status === 429 || r.status >= 500) {
        const retryAfter = parseInt(r.headers.get("retry-after") ?? "", 10);
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(30000, 2000 * 2 ** i));
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
const getJson = async (url) => JSON.parse(await getText(url));

/** Sum `area_km` (optionally bucketed by `year`) for one layer inside a bbox. */
async function sumInBbox(layer, bbox, byYear) {
  const props = byYear ? "year,area_km" : "area_km";
  const url = `${WFS}&typeName=${WS}:${layer}&bbox=${bbox.join(",")}&propertyName=${props}&outputFormat=csv`;
  const csv = await getText(url);
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return byYear ? {} : 0;
  const head = lines[0].split(",").map((h) => h.trim());
  const iA = head.indexOf("area_km");
  const iY = head.indexOf("year");
  if (iA < 0) return byYear ? {} : 0;
  const out = byYear ? {} : { total: 0 };
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const a = parseFloat(c[iA]);
    if (!Number.isFinite(a)) continue;
    if (byYear) {
      const y = parseInt(c[iY], 10);
      if (Number.isFinite(y)) out[y] = (out[y] ?? 0) + a;
    } else out.total += a;
  }
  return byYear ? out : out.total;
}

// ── geometry helpers ───────────────────────────────────────────────────────
const ringContains = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const polyContains = (poly, x, y) =>
  ringContains(poly[0], x, y) && !poly.slice(1).some((h) => ringContains(h, x, y));
const geomContains = (g, x, y) =>
  g.type === "Polygon"
    ? polyContains(g.coordinates, x, y)
    : g.coordinates.some((p) => polyContains(p, x, y));

function bboxOfGeom(g) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (a) => {
    if (typeof a[0] === "number") {
      w = Math.min(w, a[0]); e = Math.max(e, a[0]);
      s = Math.min(s, a[1]); n = Math.max(n, a[1]);
    } else a.forEach(walk);
  };
  walk(g.coordinates);
  return [w, s, e, n];
}
const centroidOf = (g) => {
  const [w, s, e, n] = bboxOfGeom(g);
  return [(w + e) / 2, (s + n) / 2];
};
// km² of a lon/lat box, good enough at these latitudes
const boxAreaKm2 = (w, s, e, n) =>
  (e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180) * (n - s) * 110.574;

// ── 1. region boundary + grid ──────────────────────────────────────────────
console.log("fetching Legal Amazon boundary...");
const boundary = await getJson(
  `${WFS}&typeName=${WS}:brazilian_legal_amazon&outputFormat=application/json`
);
const region = boundary.features[0].geometry;

const cells = [];
for (let lon = BOUNDS.west; lon < BOUNDS.east; lon += CELL) {
  for (let lat = BOUNDS.south; lat < BOUNDS.north; lat += CELL) {
    const w = +lon.toFixed(3), s = +lat.toFixed(3);
    const e = +(lon + CELL).toFixed(3), n = +(lat + CELL).toFixed(3);
    // keep the cell if any of a 3x3 sample falls inside the region
    let hit = false;
    for (let a = 0; a <= 2 && !hit; a++)
      for (let b = 0; b <= 2 && !hit; b++)
        if (geomContains(region, w + ((e - w) * a) / 2, s + ((n - s) * b) / 2)) hit = true;
    if (hit) cells.push({ id: `C${w}_${s}`, bbox: [w, s, e, n], center: [(w + e) / 2, (s + n) / 2] });
  }
}
console.log(`${cells.length} parcels intersect the Legal Amazon\n`);

// ── 2. protected + indigenous coverage ─────────────────────────────────────
console.log("fetching conservation units and indigenous lands...");
const protectedGeoms = [];
for (const layer of ["conservation_units_legal_amazon", "indigenous_area_legal_amazon"]) {
  const fcl = await getJson(`${WFS}&typeName=${WS}:${layer}&outputFormat=application/json`);
  for (const f of fcl.features)
    if (f.geometry) protectedGeoms.push({ g: f.geometry, bb: bboxOfGeom(f.geometry) });
  console.log(`  ${layer}: ${fcl.features.length}`);
}
const protectedFraction = ([w, s, e, n]) => {
  const N = 6; // 36 sample points per parcel
  let inside = 0;
  for (let a = 0; a < N; a++)
    for (let b = 0; b < N; b++) {
      const x = w + ((e - w) * (a + 0.5)) / N;
      const y = s + ((n - s) * (b + 0.5)) / N;
      if (protectedGeoms.some((p) => x >= p.bb[0] && x <= p.bb[2] && y >= p.bb[1] && y <= p.bb[3] && geomContains(p.g, x, y)))
        inside++;
    }
  return inside / (N * N);
};

// ── 3. nearest municipality, for human-readable labels ─────────────────────
console.log("fetching municipalities for labels...");
const muniPath = `${CACHE}/municipalities.json`;
let munis;
if (!fresh && existsSync(muniPath)) {
  munis = JSON.parse(readFileSync(muniPath, "utf8"));
} else {
  const fcm = await getJson(
    `${WFS}&typeName=${WS}:municipalities_legal_amazon&outputFormat=application/json`
  );
  munis = fcm.features
    .filter((f) => f.geometry)
    .map((f) => ({ name: f.properties.nome, code: f.properties.geocodigo, c: centroidOf(f.geometry) }));
  writeFileSync(muniPath, JSON.stringify(munis));
}
console.log(`  ${munis.length} municipalities\n`);
const nearestMuni = ([x, y]) => {
  let best = null, bd = Infinity;
  for (const m of munis) {
    const d = (m.c[0] - x) ** 2 + (m.c[1] - y) ** 2;
    if (d < bd) { bd = d; best = m; }
  }
  return best;
};

// ── 4. PRODES areas per parcel ─────────────────────────────────────────────
const todo = cells.filter((c) => !cache[c.id]);
console.log(`measuring ${todo.length} parcels (${cells.length - todo.length} cached)`);
let done = 0, failed = 0;
const CONCURRENCY = 2; // TerraBrasilis rate-limits; two lanes runs clean

async function measure(cell) {
  const [w, s, e, n] = cell.bbox;
  // Sequential inside a cell: four parallel bursts per cell is what trips the
  // rate limiter, and the wall-clock cost is recovered by the outer lanes.
  const cleared = await sumInBbox(AREA_LAYERS.cleared, cell.bbox, true);
  const preCleared = await sumInBbox(AREA_LAYERS.preCleared, cell.bbox, false);
  const nonForest = await sumInBbox(AREA_LAYERS.nonForest, cell.bbox, false);
  const water = await sumInBbox(AREA_LAYERS.water, cell.bbox, false);
  const areaKm2 = boxAreaKm2(w, s, e, n);
  const byYear = {};
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) byYear[y] = +(cleared[y] ?? 0).toFixed(3);
  return {
    areaKm2: +areaKm2.toFixed(1),
    preClearedKm2: +preCleared.toFixed(1),
    nonForestKm2: +nonForest.toFixed(1),
    waterKm2: +water.toFixed(1),
    clearedByYear: byYear,
  };
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
      if (++done % 20 === 0) {
        writeFileSync(cachePath, JSON.stringify(cache));
        console.log(`  ${done}/${todo.length} parcels (${failed} failed)`);
      }
    }
  })
);
writeFileSync(cachePath, JSON.stringify(cache));
console.log(`PRODES done: ${Object.keys(cache).length} parcels cached, ${failed} failed\n`);

// ── 5. terrain and climate covariates ──────────────────────────────────────
const live = cells.filter((c) => cache[c.id]);

// Terrain and climate are secondary covariates: useful, but not worth losing a
// completed PRODES run over. Cache each parcel as it lands, and if the provider
// starts refusing, keep what we have and carry on with nulls.
const covPath = `${CACHE}/covariates.json`;
const cov = !fresh && existsSync(covPath) ? JSON.parse(readFileSync(covPath, "utf8")) : {};
const saveCov = () => writeFileSync(covPath, JSON.stringify(cov));

console.log("fetching elevation (Open-Meteo)...");
const needElev = live.filter((c) => cov[c.id]?.elevationM == null);
let elevDone = 0;
try {
  for (let i = 0; i < needElev.length; i += 20) {
    const chunk = needElev.slice(i, i + 20);
    // 5 samples per parcel gives a mean and a ruggedness spread.
    const pts = chunk.flatMap((c) => {
      const [w, s, e, n] = c.bbox;
      return [[c.center[1], c.center[0]],
        [s + (n - s) * 0.25, w + (e - w) * 0.25], [s + (n - s) * 0.25, w + (e - w) * 0.75],
        [s + (n - s) * 0.75, w + (e - w) * 0.25], [s + (n - s) * 0.75, w + (e - w) * 0.75]];
    });
    const r = await getJson(
      `https://api.open-meteo.com/v1/elevation?latitude=${pts.map((p) => p[0]).join(",")}&longitude=${pts.map((p) => p[1]).join(",")}`
    );
    chunk.forEach((c, k) => {
      const es = r.elevation.slice(k * 5, k * 5 + 5).filter(Number.isFinite);
      if (!es.length) return;
      const mean = es.reduce((a, b) => a + b, 0) / es.length;
      cov[c.id] = {
        ...cov[c.id],
        elevationM: Math.round(mean),
        ruggednessM: Math.round(Math.sqrt(es.reduce((a, b) => a + (b - mean) ** 2, 0) / es.length)),
      };
    });
    elevDone += chunk.length;
    saveCov();
    process.stdout.write(`\r  ${elevDone}/${needElev.length} parcels`);
    await sleep(250);
  }
  console.log();
} catch (e) {
  saveCov();
  console.log(`\n  elevation stopped early (${e.message}) — keeping ${elevDone} and continuing`);
}

console.log("fetching precipitation (Open-Meteo archive)...");
// Two years is plenty to rank parcels wet-to-dry, and asking for five made the
// archive API throttle hard — the request weight scales with days x locations.
const PRECIP_YEARS = 2;
const needPrecip = live.filter((c) => cov[c.id]?.precipMmYr == null);
let precipDone = 0;
try {
  for (let i = 0; i < needPrecip.length; i += 10) {
    const chunk = needPrecip.slice(i, i + 10);
    const r = await getJson(
      `https://archive-api.open-meteo.com/v1/archive?latitude=${chunk.map((c) => c.center[1]).join(",")}` +
        `&longitude=${chunk.map((c) => c.center[0]).join(",")}` +
        `&start_date=2018-01-01&end_date=2019-12-31&daily=precipitation_sum&timezone=UTC`
    );
    const arr = Array.isArray(r) ? r : [r];
    arr.forEach((res, k) => {
      const vals = res.daily?.precipitation_sum ?? [];
      if (!vals.length || !chunk[k]) return;
      const total = vals.reduce((a, b) => a + (b ?? 0), 0);
      cov[chunk[k].id] = { ...cov[chunk[k].id], precipMmYr: Math.round(total / PRECIP_YEARS) };
    });
    precipDone += chunk.length;
    saveCov();
    process.stdout.write(`\r  ${precipDone}/${needPrecip.length} parcels`);
    await sleep(500);
  }
  console.log();
} catch (e) {
  saveCov();
  console.log(`\n  precipitation stopped early (${e.message}) — keeping ${precipDone} and continuing`);
}
console.log("\n");

// ── 6. assemble ────────────────────────────────────────────────────────────
const records = live.map((c) => {
  const m = cache[c.id];
  const { elevationM = null, ruggednessM = null, precipMmYr = null } = cov[c.id] ?? {};

  // Forest standing when the record opens.
  //
  // The masks are summed from bbox queries, which count a polygon whole even
  // when it only clips the parcel. In heavily-cleared parcels that over-subtracts
  // enough to leave less forest than PRODES later records being cleared, which
  // is impossible. Such parcels are flagged and dropped rather than patched:
  // flooring the baseline at observed clearing merely converts the error into a
  // fake 100% loss rate, which would poison every counterfactual they enter.
  const land = Math.max(1, m.areaKm2 - m.waterKm2);
  const clearedTotal = Object.values(m.clearedByYear).reduce((a, b) => a + b, 0);
  const rawForest = land - m.preClearedKm2 - m.nonForestKm2;
  const forest2008 = Math.max(0, rawForest);
  const consistent = rawForest >= clearedTotal;
  const muni = nearestMuni(c.center);

  return {
    id: c.id,
    bbox: c.bbox,
    center: [+c.center[0].toFixed(3), +c.center[1].toFixed(3)],
    label: muni?.name ?? null,
    consistent,
    areaKm2: m.areaKm2,
    landKm2: +land.toFixed(1),
    forest2008Km2: +forest2008.toFixed(1),
    preClearedKm2: m.preClearedKm2,
    nonForestKm2: m.nonForestKm2,
    waterKm2: m.waterKm2,
    clearedByYear: m.clearedByYear,
    protectedFrac: +protectedFraction(c.bbox).toFixed(3),
    elevationM,
    ruggednessM,
    precipMmYr,
  };
});

// Must hold real forest and account for itself coherently.
const usable = records.filter((r) => r.forest2008Km2 > 200 && r.consistent).map(({ consistent, ...r }) => r);
console.log(`dropped ${records.filter((r) => !r.consistent).length} parcels with inconsistent mask accounting`);
writeFileSync(
  `${ROOT}/src/cells.json`,
  JSON.stringify({
    source: "INPE PRODES via TerraBrasilis WFS (deforestation, masks, boundaries); Open-Meteo (elevation, precipitation)",
    citation: "INPE. PRODES — Monitoramento do Desmatamento da Floresta Amazônica Brasileira por Satélite. terrabrasilis.dpi.inpe.br",
    license: "INPE PRODES: open data. Open-Meteo: CC BY 4.0.",
    collectedAt: new Date().toISOString().slice(0, 10),
    region: "Brazilian Legal Amazon",
    cellDegrees: CELL,
    firstYear: FIRST_YEAR,
    lastYear: LAST_YEAR,
    note: "Areas in km2. clearedByYear is PRODES annual clear-cut deforestation. Nothing here is modelled.",
    cells: usable,
  })
);
console.log(`wrote src/cells.json — ${usable.length} parcels with forest (of ${records.length} measured)`);
