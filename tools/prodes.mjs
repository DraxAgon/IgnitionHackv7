// tools/prodes.mjs — shared client for the public data sources.
// INPE PRODES via TerraBrasilis WFS, and Open-Meteo. No keys, no accounts.

export const WFS =
  "http://terrabrasilis.dpi.inpe.br/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&srsName=EPSG:4326";
export const WS = "prodes-legal-amz";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with backoff. 429 and 5xx mean "slow down", not "give up". */
export async function getText(url, tries = 7) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (r.ok) return await r.text();
      if (r.status === 429 || r.status >= 500) {
        const ra = parseInt(r.headers.get("retry-after") ?? "", 10);
        await sleep(Number.isFinite(ra) ? ra * 1000 : Math.min(30000, 2000 * 2 ** i));
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

export const getJson = async (url) => JSON.parse(await getText(url));

/** Sum `area_km` for a PRODES layer inside a bbox, optionally bucketed by year. */
export async function sumInBbox(layer, bbox, byYear = false) {
  const props = byYear ? "year,area_km" : "area_km";
  const csv = await getText(
    `${WFS}&typeName=${WS}:${layer}&bbox=${bbox.join(",")}&propertyName=${props}&outputFormat=csv`
  );
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

/** All four PRODES measures for one bbox, sequentially (kind to the service). */
export async function measureBbox(bbox, firstYear, lastYear) {
  const cleared = await sumInBbox("yearly_deforestation", bbox, true);
  const preCleared = await sumInBbox("accumulated_deforestation_2007", bbox);
  const nonForest = await sumInBbox("no_forest", bbox);
  const water = await sumInBbox("hydrography", bbox);
  const clearedByYear = {};
  for (let y = firstYear; y <= lastYear; y++) clearedByYear[y] = +(cleared[y] ?? 0).toFixed(3);
  return {
    areaKm2: +boxAreaKm2(...bbox).toFixed(1),
    preClearedKm2: +preCleared.toFixed(1),
    nonForestKm2: +nonForest.toFixed(1),
    waterKm2: +water.toFixed(1),
    clearedByYear,
  };
}

/** km² of a lon/lat box — accurate enough at Amazonian latitudes. */
export const boxAreaKm2 = (w, s, e, n) =>
  (e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180) * (n - s) * 110.574;

/** Mean elevation and within-parcel spread, from five samples. */
export async function elevationFor(bbox) {
  const [w, s, e, n] = bbox;
  const pts = [
    [(s + n) / 2, (w + e) / 2],
    [s + (n - s) * 0.25, w + (e - w) * 0.25], [s + (n - s) * 0.25, w + (e - w) * 0.75],
    [s + (n - s) * 0.75, w + (e - w) * 0.25], [s + (n - s) * 0.75, w + (e - w) * 0.75],
  ];
  const r = await getJson(
    `https://api.open-meteo.com/v1/elevation?latitude=${pts.map((p) => p[0]).join(",")}&longitude=${pts.map((p) => p[1]).join(",")}`
  );
  const es = r.elevation.filter(Number.isFinite);
  const mean = es.reduce((a, b) => a + b, 0) / (es.length || 1);
  const sd = Math.sqrt(es.reduce((a, b) => a + (b - mean) ** 2, 0) / (es.length || 1));
  return { elevationM: Math.round(mean), ruggednessM: Math.round(sd) };
}

/** Mean annual precipitation, mm, averaged over 2016-2020. */
export async function precipitationFor([lon, lat]) {
  const r = await getJson(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&start_date=2016-01-01&end_date=2020-12-31&daily=precipitation_sum&timezone=UTC`
  );
  const vals = r.daily?.precipitation_sum ?? [];
  return Math.round(vals.reduce((a, b) => a + (b ?? 0), 0) / 5);
}
