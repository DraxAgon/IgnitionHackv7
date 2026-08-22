// geometry.js — the zones drawn on the map, and the one shape language they share.
//
// Two kinds of zone are drawn. A project footprint: registered projects publish
// a boundary, and for the illustrative projects in this build the footprint is a
// deterministic blob around the real centre, sized to the stated area. And a
// reference parcel: one of the comparable unprotected parcels the baseline is
// checked against, whose measurement extent is a one-degree box.
//
// Both are drawn with the same harmonic outline. A box drawn among blobs reads
// as a different KIND of thing rather than as the same kind of thing measured a
// different way, and the only distinction that carries meaning here is colour:
// amber for the project under examination, slate for what it is compared with.
//
// Replace `boundaryLonLat` with a registry polygon and nothing else changes.

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

/** A stable integer seed from any id, so a parcel's outline never moves. */
export function seedFrom(value) {
  const s = String(value);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const KM_PER_DEG_LAT = 110.574;
export const kmPerDegLon = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);

/**
 * The radial wobble every zone on the map is drawn with, as a factor on 1.
 *
 * Three low harmonics: enough to stop reading as a circle, few enough that the
 * outline still reads as one region rather than as a coastline. Draws exactly
 * six numbers from `rand`, in this order, and the project blobs shipped in
 * `loss-*.json` were baked against that sequence — changing it moves every
 * project boundary and invalidates the inside/outside split of the clearing.
 */
function wobble(rand, ks = [2, 3, 5]) {
  const harmonics = ks.map((k) => ({
    k,
    amp: 0.04 + rand() * 0.08,
    phase: rand() * Math.PI * 2,
  }));
  return (t) => 1 + harmonics.reduce((s, h) => s + h.amp * Math.sin(h.k * t + h.phase), 0);
}

/** Radius function of an irregular blob covering `areaHa`. */
export function geometryFor(project) {
  const rand = mulberry32(project.seed ?? 1);
  const R = Math.sqrt(project.areaHa / 100 / Math.PI); // ha → km² → radius km
  const f = wobble(rand);
  return { R, radius: (t) => R * f(t) };
}

/**
 * Close a ring by copying its first vertex, not by walking round to t = 2π.
 *
 * sin(2π) is -2.4e-16 rather than 0, and each harmonic picks up its own error
 * at k·2π + phase, so the computed last vertex misses the first by a fraction
 * of a ULP. GeoJSON requires them to be identical and turf enforces it exactly,
 * so `turf.polygon([ring])` throws "First and last Position are not equivalent"
 * — for whichever seeds happen to land the error above the ULP of the final
 * coordinate, which is why this stayed hidden until a project was added. The
 * vertex is the same point either way; this makes it the same number too.
 */
const closeRing = (pts) => (pts.push([...pts[0]]), pts);

export function boundaryLonLat(project, steps = 128) {
  if (project.boundary) return project.boundary; // a real registry polygon, if supplied
  const { radius } = geometryFor(project);
  const [lon, lat] = project.center;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const r = radius(t);
    pts.push([lon + (Math.cos(t) * r) / kmPerDegLon(lat), lat + (Math.sin(t) * r) / KM_PER_DEG_LAT]);
  }
  return closeRing(pts);
}

/**
 * A reference parcel's outline, in the same shape language as a project blob.
 *
 * The parcel's measurement extent is its one-degree box, and the box is what
 * every number in its popup was summed over. So the outline is INSCRIBED in
 * that box — normalised by the wobble's own peak, which is why the peak is
 * measured over the sampled angles rather than assumed. The drawn zone can then
 * only ever understate the ground the measurement covers, never claim any
 * outside it, and the popup says which extent the figures came from.
 *
 * Used where the bake has no real PRODES forest outline for the parcel. Where it
 * does, that outline is drawn instead — it is measured data, and it is already
 * irregular, so the map keeps one shape language either way.
 */
export function parcelRing(cell, steps = 96) {
  const [w, s, e, n] = cell.bbox;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const hx = (e - w) / 2;
  const hy = (n - s) / 2;
  const f = wobble(mulberry32(seedFrom(cell.id ?? `${w},${s},${e},${n}`)));

  const ts = Array.from({ length: steps }, (_, i) => (i / steps) * Math.PI * 2);
  const peak = ts.reduce((m, t) => Math.max(m, f(t)), 0) || 1;
  const pts = ts.map((t) => [
    cx + (hx * f(t) * Math.cos(t)) / peak,
    cy + (hy * f(t) * Math.sin(t)) / peak,
  ]);
  return closeRing(pts);
}

/**
 * Whether a baked outline is nothing more than the parcel box.
 *
 * The bake stores the forested part of each parcel: the box less water, mapped
 * non-forest and clearing that predates the window. A parcel with none of
 * those to subtract comes back as the box itself - a real outline that carries
 * no more information than the bbox already did, and the last thing on the map
 * still drawn as a plain rectangle. Six of the reference zones in this dataset
 * are that case, which is few enough to look like an inconsistency rather than
 * a category.
 */
export function isRectangularOutline(geometry) {
  if (!geometry) return false;
  const rings =
    geometry.type === "Polygon" ? geometry.coordinates : (geometry.coordinates ?? []).flat();
  return rings.reduce((total, ring) => total + ring.length, 0) <= 5;
}

export const projectFeature = (project, props = {}) => ({
  type: "Feature",
  properties: { id: project.id, ...props },
  geometry: { type: "Polygon", coordinates: [boundaryLonLat(project)] },
});

/** A reference parcel as a drawable feature. */
export const parcelFeature = (cell, props = {}) => ({
  type: "Feature",
  properties: { id: cell.id, ...props },
  geometry: { type: "Polygon", coordinates: [parcelRing(cell)] },
});
