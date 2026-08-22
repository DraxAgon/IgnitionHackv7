// tools/gfw.mjs — shared client for the legacy Global Forest Watch v1 API.
//
// Global Forest Watch rebranded to Global Nature Watch (globalnaturewatch.org)
// in 2025 — globalforestwatch.org now redirects there. This endpoint is
// unaffected: production-api.globalforestwatch.org predates GFW's current
// (API-keyed) Data API and is still live and keyless: register a polygon, get
// back real Hansen-derived tree cover and loss statistics for it. No account,
// no token — verified live before writing this file, and re-verified after
// the rebrand, the same way tools/prodes.mjs wraps PRODES's WFS.
//
// One confirmed limitation: this endpoint's loss data is frozen at an older
// Hansen vintage than the current tile layer — cumulative loss stops moving
// past 2019 in spot checks against the same geometry queried with later
// `period` end dates. Callers should not assume years after that are populated.

const BASE = "https://production-api.globalforestwatch.org";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, opts, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000), ...opts });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) {
        await sleep(Math.min(20000, 1500 * 2 ** i));
        continue;
      }
      throw new Error(`http ${r.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(Math.min(20000, 1200 * 2 ** i));
    }
  }
  throw new Error("exhausted retries");
}

/** Register a GeoJSON polygon (a single ring, lon/lat) and get back a geostore hash + area. */
export async function registerGeostore(ring) {
  const geojson = { type: "Polygon", coordinates: [ring] };
  const doc = await getJson(`${BASE}/v1/geostore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geojson }),
  });
  const a = doc.data.attributes;
  return { hash: a.hash, areaHa: a.areaHa, bbox: a.bbox };
}

const boxRing = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n], [w, s]];

/** Convenience: register a bbox directly. */
export const registerBboxGeostore = (bbox) => registerGeostore(boxRing(bbox));

/**
 * Cumulative tree cover / loss stats for a geostore, from 2001-01-01 through
 * the end of `year`. `thresh` is the canopy-density threshold (30 matches
 * PRODES-comparable "forest"; GFC's own convention).
 */
export async function lossGainStats(hash, year, thresh = 30) {
  const doc = await getJson(
    `${BASE}/v1/umd-loss-gain?geostore=${hash}&period=2001-01-01,${year}-12-31&thresh=${thresh}`
  );
  const a = doc.data.attributes;
  return { treeExtent: a.treeExtent, treeExtent2010: a.treeExtent2010, lossHa: a.loss, gainHa: a.gain };
}

/** km² of a lon/lat box — accurate enough at these latitudes. */
export const boxAreaKm2 = (w, s, e, n) =>
  (e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180) * (n - s) * 110.574;
