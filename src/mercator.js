// mercator.js — Web Mercator tile math and a shared tile cache.
// Measuring (forestData) and rendering (changeCanvas) read the same tiles, so
// they share one cache: selecting a project costs no extra network.

export const TILE_PX = 256;

export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
export const tileXToLon = (x, z) => (x / 2 ** z) * 360 - 180;
export const tileYToLat = (y, z) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** Tile index range covering a square of ±halfKm around a centre. */
export function tileRange([lon, lat], halfKm, zoom) {
  const dLat = halfKm / 110.574;
  const dLon = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return {
    x0: Math.floor(lonToTileX(lon - dLon, zoom)),
    x1: Math.floor(lonToTileX(lon + dLon, zoom)),
    y0: Math.floor(latToTileY(lat + dLat, zoom)),
    y1: Math.floor(latToTileY(lat - dLat, zoom)),
  };
}

const cache = new Map();

/** RGBA bytes for one tile, or null if it could not be read. */
export function loadTileData(url) {
  if (cache.has(url)) return cache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = TILE_PX;
        c.height = TILE_PX;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
        resolve(ctx.getImageData(0, 0, TILE_PX, TILE_PX).data);
      } catch {
        resolve(null); // cross-origin taint
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  cache.set(url, p);
  return p;
}

/** Run `fn` over a queue with bounded concurrency. */
export async function pooled(items, limit, fn) {
  const q = items.slice();
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let it = q.shift(); it !== undefined; it = q.shift()) await fn(it);
    })
  );
}
