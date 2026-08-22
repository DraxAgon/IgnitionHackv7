// tools/measure.mjs — re-measure every project from live satellite tiles and
// rewrite src/measurements.json.
//
//   1. npm run dev          (in another terminal)
//   2. npm run measure
//
// Tile decoding needs a browser canvas, so this drives the same forestData.js
// the app uses inside headless Chromium. Nothing is computed here that the app
// cannot recompute in front of you with the "Re-measure from live satellite
// tiles" button.

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { PROJECTS } from "../src/data.js";

const ORIGIN = process.env.PHANTOM_ORIGIN ?? "http://localhost:5173";

const res = await fetch(`${ORIGIN}/scan.html`).catch(() => null);
if (!res?.ok) {
  console.error(`No dev server at ${ORIGIN}. Run "npm run dev" first.`);
  process.exit(1);
}

console.log(`measuring ${PROJECTS.length} projects from UMD/Hansen tiles...`);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => m.text().startsWith("[m]") && console.log(m.text()));
await page.goto(`${ORIGIN}/scan.html`);

const byProject = await page.evaluate(async (projects) => {
  const fd = await import("/src/forestData.js");
  const out = {};
  for (const p of projects) {
    const m = await fd.measureZones(p, { zoom: 11 });
    out[p.id] = m;
    console.log(`[m] ${p.id.padEnd(9)} ${m.tiles} tiles, ${m.tilesFailed} failed, ${(m.project.total + m.ring.total).toLocaleString()} px`);
  }
  return out;
}, PROJECTS);
await browser.close();

writeFileSync(
  new URL("../src/measurements.json", import.meta.url),
  JSON.stringify({
    source: "UMD/Hansen Global Forest Change v1.11 (Landsat, 30 m), via Global Forest Watch open tiles",
    citation: "Hansen, M. C. et al. (2013) High-Resolution Global Maps of 21st-Century Forest Cover Change. Science 342, 850-853.",
    license: "CC BY 4.0",
    measuredAt: new Date().toISOString().slice(0, 10),
    zoom: 11, baseYear: 2015, endYear: 2023, canopyThresholdPct: 30,
    byProject,
  })
);
console.log("wrote src/measurements.json — run `npm run check` to verify.");
