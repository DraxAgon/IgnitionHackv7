// Does the camera frame every project, clear the panel, and leave room to move?
//
//   node scripts/_check-frame.mjs [baseUrl]
//
// The three things the overview has to get right, at four window shapes:
// every project on screen, no project under the panel, and enough slack in the
// pan barrier to move without letting the region off the edge.
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:5188";
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the map, not for a stopwatch: a fixed sleep reads a half-loaded
// camera on a cold cache and reports the pre-frame zoom as the overview.
const ready = async (page) => {
  await page.waitForFunction(() => window.__map?.loaded() && document.querySelectorAll(".pin").length === 13, null, { timeout: 40000 });
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 });
  await settle(400);
};

// Basemap tiles come from a third-party CDN and occasionally arrive corrupt.
// That is not this code failing, and failing on it makes the check useless on a
// flaky connection.
const ours = (e) => !/could not be decoded|Failed to fetch|ERR_|AbortError/i.test(e);

const read = (page) =>
  page.evaluate(() => {
    const m = window.__map;
    const b = m.getBounds();
    const panel = document.querySelector(".side")?.getBoundingClientRect() ?? null;
    const pins = [...document.querySelectorAll(".pin")].map((el) => {
      const q = el.getBoundingClientRect();
      return { id: el.dataset.id, left: q.left, top: q.top, right: q.right, bottom: q.bottom };
    });
    return {
      zoom: +m.getZoom().toFixed(2),
      view: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => +v.toFixed(1)),
      panel: panel && { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom },
      pins,
      w: innerWidth,
      h: innerHeight,
    };
  });

const hidden = (r) =>
  r.pins.filter(
    (p) => r.panel && p.right > r.panel.left && p.left < r.panel.right && p.bottom > r.panel.top && p.top < r.panel.bottom
  );

const browser = await chromium.launch();
let bad = 0;

for (const vp of [
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  const page = await browser.newPage({ viewport: vp });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await ready(page);

  const r = await read(page);
  const off = r.pins.filter((p) => p.left < 0 || p.top < 0 || p.right > r.w || p.bottom > r.h);
  const under = hidden(r);

  // Room to move, measured at the overview zoom rather than at the floor.
  const panned = await page.evaluate(async () => {
    const m = window.__map;
    const c0 = m.getCenter();
    const reach = async (lng, lat) => {
      m.setCenter([lng, lat]);
      await new Promise((r) => setTimeout(r, 250));
      return m.getCenter();
    };
    const w = await reach(c0.lng - 90, c0.lat);
    const e = await reach(c0.lng + 90, c0.lat);
    const s = await reach(c0.lng, c0.lat - 60);
    const n = await reach(c0.lng, c0.lat + 60);
    m.setCenter(c0);
    return { lon: +(e.lng - w.lng).toFixed(1), lat: +(n.lat - s.lat).toFixed(1) };
  });

  // How far back the barrier lets a viewer stand, and what that shows.
  await page.evaluate(() => window.__map.setZoom(0));
  await settle(600);
  const floor = await page.evaluate(() => {
    const b = window.__map.getBounds();
    return { zoom: +window.__map.getZoom().toFixed(2), span: +(b.getEast() - b.getWest()).toFixed(0) };
  });

  // Select a project and come back: both fits happen under the barrier the
  // overview installed, and the return has to land back on the same frame.
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready(page);
  const base = await read(page);
  await page.locator(".pin").first().click();
  await settle(2200);
  const sel = await read(page);
  await page.keyboard.press("Escape");
  await settle(1800);
  const back = await read(page);
  const returned = Math.abs(back.zoom - base.zoom) < 0.05 && back.pins.length === 13 && hidden(back).length === 0;

  const mine = errs.filter(ours);
  const ok = off.length === 0 && under.length === 0 && r.pins.length === 13 && mine.length === 0 && sel.zoom > base.zoom && returned;
  if (!ok) bad++;

  console.log(`${ok ? "OK  " : "FAIL"} ${vp.width}x${vp.height}  overview z${r.zoom}  view ${JSON.stringify(r.view)}`);
  console.log(`       ${r.pins.length} pins · ${off.length} off-screen · ${under.length} under panel`);
  console.log(`       pull-back ${(r.zoom - floor.zoom).toFixed(2)} stops to ${floor.span}deg · pan room ${panned.lon}deg lon / ${panned.lat}deg lat`);
  console.log(`       select z${sel.zoom} -> back z${back.zoom} (${returned ? "reframed clean" : "DID NOT RETURN"})`);
  if (off.length) console.log("       off:", off.map((p) => p.id).join(", "));
  if (under.length) console.log("       under:", under.map((p) => p.id).join(", "));
  if (mine.length) console.log("       errors:", mine.slice(0, 3));

  // A viewer who has panned keeps their frame across a resize, so the app does
  // not re-fit — but the barrier still has to follow the window, because it is a
  // function of the window and not of the frame. Left stale, one sized for a
  // small window survives into a large one and forbids the overview outright.
  //
  // Being pushed to a higher zoom on a grow is the barrier working, not failing:
  // more pixels showing the same degrees is a higher zoom. What must never
  // happen is being pushed ABOVE the zoom this window needs to frame the region,
  // because past that point the overview is simply unreachable.
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready(page);
  // Dragged, not panBy'd: the map only counts a move as the viewer's when the
  // movestart carries an originalEvent, so a programmatic pan would quietly
  // exercise the re-fit path instead of the one being tested here.
  // Upper-left quarter: clear of the right-hand panel on a desktop layout and of
  // the bottom sheet under 900px. Grabbing the sheet scrolls the sheet, the map
  // never moves, and the case silently tests nothing.
  const mid = [Math.round(vp.width * 0.3), Math.round(vp.height * 0.2)];
  await page.mouse.move(mid[0], mid[1]);
  await page.mouse.down();
  await page.mouse.move(mid[0] + 120, mid[1], { steps: 12 });
  await page.mouse.up();
  await settle(700);
  // Confirm the drag actually landed on the map, or the case tests nothing.
  const before = await page.evaluate(() => ({ zoom: +window.__map.getZoom().toFixed(2), lng: window.__map.getCenter().lng }));
  if (Math.abs(before.lng - base.view[0] - (base.view[2] - base.view[0]) / 2) < 0.05) {
    bad++;
    console.log("       drag did not move the map — the resize case tested nothing");
  }
  await page.setViewportSize({ width: vp.width + 380, height: vp.height + 220 });
  await settle(1200);
  const grown = await page.evaluate(() => ({
    zoom: +window.__map.getZoom().toFixed(2),
    wants: +window.__overview().zoom.toFixed(2),
  }));
  // Room left under the frame this window needs. Zero or less means the barrier
  // has locked the viewer in tighter than the overview.
  const headroom = +(grown.wants - grown.zoom).toFixed(2);
  const reachable = headroom >= 0;
  if (!reachable) bad++;
  console.log(
    `       grow after pan: z${before.zoom} -> z${grown.zoom}, overview needs z${grown.wants} ` +
      `(${reachable ? `${headroom} stops of headroom` : "OVERVIEW UNREACHABLE"})`
  );

  await page.close();
}

await browser.close();
console.log(bad ? `\n${bad} viewport(s) failed` : "\nframe check passed.");
process.exit(bad ? 1 : 0);
