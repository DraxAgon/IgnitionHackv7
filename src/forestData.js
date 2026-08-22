// forestData.js — reads REAL forest measurements from public satellite tiles.
//
// Source: UMD / Hansen Global Forest Change (Landsat, 30 m), served as open
// XYZ tiles by Global Forest Watch with `Access-Control-Allow-Origin: *`,
// which is what makes browser-side pixel readback possible. No API key.
//
//   Hansen et al. 2013, "High-Resolution Global Maps of 21st-Century Forest
//   Cover Change", Science 342: 850-853.
//
// Encodings (verified empirically against known-intact and known-cleared sites):
//   tree cover density 2000, tcd_30 : alpha > 0  ⇔ ≥30% canopy cover in 2000
//   tree cover loss,        tcd_30 : alpha > 0 and B byte = years since 2000
//
// So forest cover in year Y = (forest in 2000) minus (loss with year ≤ Y),
// which is exactly the "count pixels above a threshold" step the method needs.

export const TCD_TILE = (z, x, y) =>
  `https://tiles.globalforestwatch.org/umd_tree_cover_density_2000/v1.8/tcd_30/${z}/${x}/${y}.png`;
export const LOSS_TILE = (z, x, y) =>
  `https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/tcd_30/${z}/${x}/${y}.png`;

export const CANOPY_THRESHOLD_PCT = 30; // the tcd_30 tileset's own threshold
export const BASE_YEAR = 2015;
export const END_YEAR = 2023; // last year in GFC v1.11

import { TILE_PX, tileRange, tileXToLon, tileYToLat, loadTileData, pooled } from "./mercator.js";
import { geometryFor, zoneAt } from "./geometry.js";

/**
 * Measure a project and its counterfactual ring from real satellite tiles.
 * Returns pixel counts per zone; the arithmetic on top lives in engine.js.
 */
export async function measureZones(project, { zoom = 11, onProgress } = {}) {
  const { radius, halfKm } = geometryFor(project);
  const { x0, x1, y0, y1 } = tileRange(project.center, halfKm, zoom);

  const coords = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) coords.push([x, y]);

  const zones = [null, freshZone(), freshZone()];
  let loaded = 0,
    failed = 0;

  // Modest concurrency: fast enough to feel live, gentle on a public service.
  await pooled(coords, 6, async ([tx, ty]) => {
    const [tcd, loss] = await Promise.all([
      loadTileData(TCD_TILE(zoom, tx, ty)),
      loadTileData(LOSS_TILE(zoom, tx, ty)),
    ]);
    if (!tcd) {
      failed++;
      onProgress?.(++loaded, coords.length);
      return;
    }
    for (let py = 0; py < TILE_PX; py++) {
      const lat = tileYToLat(ty + (py + 0.5) / TILE_PX, zoom);
      for (let px = 0; px < TILE_PX; px++) {
        const lon = tileXToLon(tx + (px + 0.5) / TILE_PX, zoom);
        const zone = zoneAt(project, lon, lat, radius);
        if (!zone) continue;
        const z = zones[zone];
        z.total++;
        const i = (py * TILE_PX + px) * 4;
        if (tcd[i + 3] > 128) {
          z.forest2000++;
          if (loss && loss[i + 3] > 128 && loss[i + 2] > 0) {
            const year = 2000 + loss[i + 2];
            z.lossByYear[year] = (z.lossByYear[year] || 0) + 1;
          }
        }
      }
    }
    onProgress?.(++loaded, coords.length);
  });

  return {
    projectId: project.id,
    zoom,
    tiles: coords.length,
    tilesFailed: failed,
    project: zones[1],
    ring: zones[2],
  };
}

const freshZone = () => ({ total: 0, forest2000: 0, lossByYear: {} });

// Forest cover as a fraction of zone area, in a given year.
export function coverInYear(zone, year) {
  if (!zone.total) return 0;
  let lost = 0;
  for (const [y, n] of Object.entries(zone.lossByYear)) if (+y <= year) lost += n;
  return (zone.forest2000 - lost) / zone.total;
}

// The four measurements the method needs, from one measurement pass.
export function coversFrom(m, baseYear = BASE_YEAR, endYear = END_YEAR) {
  return {
    coverProjectBase: coverInYear(m.project, baseYear),
    coverProjectEnd: coverInYear(m.project, endYear),
    coverRingBase: coverInYear(m.ring, baseYear),
    coverRingEnd: coverInYear(m.ring, endYear),
  };
}

/**
 * Data-quality signals, all derived from the measurement itself rather than
 * assumed. These drive the confidence level in engine.js.
 */
export function statsFrom(m, baseYear = BASE_YEAR) {
  const canopyFrac = (z) => (z.total ? z.forest2000 / z.total : 0);
  const preLoss = (z) => {
    if (!z.forest2000) return 0;
    let n = 0;
    for (const [y, c] of Object.entries(z.lossByYear)) if (+y < baseYear) n += c;
    return n / z.forest2000;
  };
  return {
    dataGapPct: m.tiles ? (m.tilesFailed / m.tiles) * 100 : 0,
    baselineDeltaPts: Math.abs(canopyFrac(m.project) - canopyFrac(m.ring)) * 100,
    preDivergencePts: Math.abs(preLoss(m.ring) - preLoss(m.project)) * 100,
    pixelsMeasured: m.project.total + m.ring.total,
    source: "UMD/Hansen GFC v1.11",
  };
}

// Annual series for the loss curves — real, one point per year.
export function coverSeriesFrom(m, from = BASE_YEAR, to = END_YEAR) {
  const out = [];
  for (let y = from; y <= to; y++)
    out.push({
      year: y,
      project: coverInYear(m.project, y) * 100,
      ring: coverInYear(m.ring, y) * 100,
    });
  return out;
}
