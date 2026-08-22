// changeCanvas.js — paints REAL forest change around a project onto a canvas
// that is georeferenced exactly to the tile grid, so it can be laid straight
// onto the map with no reprojection error.
//
// Every pixel here came off a Landsat-derived tile. Dragging the year scrubber
// replays actual recorded deforestation, not an animation of a model.

import { TILE_PX, tileRange, tileXToLon, tileYToLat, loadTileData, pooled } from "./mercator.js";
import { TCD_TILE, LOSS_TILE, BASE_YEAR, END_YEAR } from "./forestData.js";
import { geometryFor } from "./geometry.js";

const STANDING = [31, 89, 58, 108]; // canopy still present
const PRE_LOSS = [110, 88, 62, 120]; // cleared before the measurement window
const EARLY = [232, 185, 49]; // cleared at the window's start
const LATE = [229, 72, 77]; // cleared at the window's end

export async function buildChangeMosaic(project, { zoom = 11, onProgress } = {}) {
  const { halfKm } = geometryFor(project);
  const { x0, x1, y0, y1 } = tileRange(project.center, halfKm, zoom);
  const w = (x1 - x0 + 1) * TILE_PX;
  const h = (y1 - y0 + 1) * TILE_PX;

  const forest = new Uint8Array(w * h); // 1 = ≥30% canopy in 2000
  const lossYr = new Uint8Array(w * h); // 0 = never lost, else years since 2000

  const coords = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) coords.push([x, y]);

  let done = 0;
  await pooled(coords, 6, async ([tx, ty]) => {
    const [tcd, loss] = await Promise.all([
      loadTileData(TCD_TILE(zoom, tx, ty)),
      loadTileData(LOSS_TILE(zoom, tx, ty)),
    ]);
    if (tcd) {
      const ox = (tx - x0) * TILE_PX;
      const oy = (ty - y0) * TILE_PX;
      for (let py = 0; py < TILE_PX; py++) {
        const row = (oy + py) * w + ox;
        for (let px = 0; px < TILE_PX; px++) {
          const i = (py * TILE_PX + px) * 4;
          if (tcd[i + 3] > 128) {
            forest[row + px] = 1;
            if (loss && loss[i + 3] > 128 && loss[i + 2] > 0) lossYr[row + px] = loss[i + 2];
          }
        }
      }
    }
    onProgress?.(++done, coords.length);
  });

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  // MapLibre reads pixels off this element; keep it attached but out of view.
  Object.assign(canvas.style, { position: "absolute", left: "-99999px", top: "0" });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.createImageData(w, h);
  const span = Math.max(1, END_YEAR - BASE_YEAR);

  function render(year) {
    const d = img.data;
    for (let i = 0, p = 0; i < forest.length; i++, p += 4) {
      if (!forest[i]) {
        d[p + 3] = 0;
        continue;
      }
      const ly = lossYr[i];
      const lostYear = ly ? 2000 + ly : 0;
      let c;
      if (!lostYear || lostYear > year) c = STANDING;
      else if (lostYear < BASE_YEAR) c = PRE_LOSS;
      else {
        const t = Math.min(1, Math.max(0, (lostYear - BASE_YEAR) / span));
        d[p] = EARLY[0] + (LATE[0] - EARLY[0]) * t;
        d[p + 1] = EARLY[1] + (LATE[1] - EARLY[1]) * t;
        d[p + 2] = EARLY[2] + (LATE[2] - EARLY[2]) * t;
        d[p + 3] = 224;
        continue;
      }
      d[p] = c[0];
      d[p + 1] = c[1];
      d[p + 2] = c[2];
      d[p + 3] = c[3];
    }
    ctx.putImageData(img, 0, 0);
  }

  render(END_YEAR);

  return {
    canvas,
    render,
    width: w,
    height: h,
    // Corner coordinates of the tile block: exact, so nothing is warped.
    coordinates: [
      [tileXToLon(x0, zoom), tileYToLat(y0, zoom)],
      [tileXToLon(x1 + 1, zoom), tileYToLat(y0, zoom)],
      [tileXToLon(x1 + 1, zoom), tileYToLat(y1 + 1, zoom)],
      [tileXToLon(x0, zoom), tileYToLat(y1 + 1, zoom)],
    ],
    destroy() {
      canvas.remove();
    },
  };
}
