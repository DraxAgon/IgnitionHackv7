// scripts/shoot.mjs — screenshot the running app for review.
//   node scripts/shoot.mjs [baseUrl] [outDir]
// Not part of the build; a way to check the map actually renders what the code
// claims, since a map is the one thing you cannot verify by reading a diff.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:5175";
const OUT = process.argv[3] ?? ".shots";
mkdirSync(OUT, { recursive: true });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await settle(3500);
await page.screenshot({ path: `${OUT}/01-overview.png` });

// Open Rio Manicoré from the list.
const item = page.locator(".side-body button", { hasText: "Manicoré" }).first();
if (await item.count()) {
  await item.click();
  await settle(4000);
  await page.screenshot({ path: `${OUT}/02-selected-2016.png` });

  // Run the verification so the comparables are drawn.
  const run = page.locator("button", { hasText: "Run independent verification" }).first();
  if (await run.count()) {
    await run.click();
    await settle(4500);
  }
  await page.screenshot({ path: `${OUT}/03-verified.png` });

  // Step the slider to the end of the window.
  const track = page.locator(".year-track");
  if (await track.count()) {
    await track.focus();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("ArrowRight");
      await settle(320);
    }
    await settle(1800);
    await page.screenshot({ path: `${OUT}/04-selected-2023.png` });
  }

  // Pull back to the region so the comparable parcels come into frame.
  await page.evaluate(() => window.__map?.easeTo({ center: [-58.5, -6.5], zoom: 4.4, duration: 800 }));
  await settle(3500);
  await page.screenshot({ path: `${OUT}/05-comparables.png` });
}

console.log(errors.length ? `console errors:\n  ${errors.slice(0, 12).join("\n  ")}` : "no console errors");
await browser.close();
