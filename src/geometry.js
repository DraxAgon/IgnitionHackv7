// geometry.js — project footprint and the counterfactual ring.
// Shared by the real-data reader, the synthetic scene generator, and the map.

export const RING_INNER_KM = 5; // cushion: displaced clearing contaminates this band
export const RING_OUTER_KM = 20;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Irregular radial blob r(θ). Radial shapes make the 5/20 km buffer exact:
// buffering is just r(θ)+k, which is why the annulus can be both drawn and
// rasterized from the same three lines of math.
export function geometryFor(project) {
  const rand = mulberry32(project.seed ^ 0x9e3779b9);
  const R = Math.sqrt(project.areaHa / 100 / Math.PI); // ha → km² → radius km
  const harmonics = [2, 3, 5].map((k) => ({
    k,
    amp: 0.03 + rand() * 0.07,
    phase: rand() * Math.PI * 2,
  }));
  const radius = (t) =>
    R * (1 + harmonics.reduce((s, h) => s + h.amp * Math.sin(h.k * t + h.phase), 0));
  const halfKm = R * 1.35 + RING_OUTER_KM + 1.5;
  return { R, radius, halfKm };
}

export const KM_PER_DEG_LAT = 110.574;
export const kmPerDegLon = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);

// Closed boundary in local km (east, north), optionally buffered outward.
export function boundaryKm(project, bufferKm = 0, steps = 160) {
  const { radius } = geometryFor(project);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const r = radius(t) + bufferKm;
    pts.push([Math.cos(t) * r, Math.sin(t) * r]);
  }
  return pts;
}

export function kmToLonLat(project, [x, y]) {
  const [lon, lat] = project.center;
  return [lon + x / kmPerDegLon(lat), lat + y / KM_PER_DEG_LAT];
}

export function boundaryLonLat(project, bufferKm = 0, steps = 160) {
  return boundaryKm(project, bufferKm, steps).map((p) => kmToLonLat(project, p));
}

// Which zone a point falls in: the project polygon, the measured ring, or neither.
export function zoneAt(project, lon, lat, radius) {
  const [clon, clat] = project.center;
  const dx = (lon - clon) * kmPerDegLon(clat);
  const dy = (lat - clat) * KM_PER_DEG_LAT;
  const d = Math.hypot(dx, dy);
  const rb = radius(Math.atan2(dy, dx));
  if (d <= rb) return 1; // project
  if (d > rb + RING_INNER_KM && d <= rb + RING_OUTER_KM) return 2; // ring
  return 0;
}

// GeoJSON for the map: project polygon, and the ring as a true annulus
// (outer boundary with the cushion punched out as an interior ring).
export function projectFeature(project, extra = {}) {
  return {
    type: "Feature",
    properties: { id: project.id, ...extra },
    geometry: { type: "Polygon", coordinates: [boundaryLonLat(project, 0)] },
  };
}

export function ringFeature(project, extra = {}) {
  return {
    type: "Feature",
    properties: { id: project.id, ...extra },
    geometry: {
      type: "Polygon",
      coordinates: [
        boundaryLonLat(project, RING_OUTER_KM),
        boundaryLonLat(project, RING_INNER_KM).slice().reverse(),
      ],
    },
  };
}

export function cushionFeature(project, extra = {}) {
  return {
    type: "Feature",
    properties: { id: project.id, ...extra },
    geometry: {
      type: "Polygon",
      coordinates: [
        boundaryLonLat(project, RING_INNER_KM),
        boundaryLonLat(project, 0).slice().reverse(),
      ],
    },
  };
}
