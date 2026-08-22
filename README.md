# Phantom

A public index that rates forest carbon-offset projects against satellite evidence, and shows
which corporate offset portfolios are built on projects the evidence doesn't support.

Scope is one region on purpose: the **Brazilian Amazon arc of deforestation**.

```
npm install
npm run dev       # http://localhost:5173
npm run check     # runs the pipeline over the bundled measurements, asserts every invariant
npm run build     # static bundle in dist/
```

## What is real and what is not

This is the distinction the whole project rests on, so it is enforced in the code layout.

**Real** — the forest measurements. Every grade is computed from
[UMD/Hansen Global Forest Change v1.11](https://glad.earthengine.app/view/global-forest-change)
(Landsat, 30 m), served as open XYZ tiles by Global Forest Watch. The app fetches those tiles,
decodes them pixel by pixel in a canvas, and counts. Two tilesets carry everything:

| tileset | encoding (verified empirically) |
|---|---|
| `umd_tree_cover_density_2000` (`tcd_30`) | `alpha > 0` ⇔ ≥30% canopy cover in 2000 |
| `umd_tree_cover_loss` (`tcd_30`) | `alpha > 0`, and the **blue byte is the loss year** offset from 2000 |

So forest cover in year *Y* = canopy present in 2000, minus loss recorded at or before *Y*.
Across the 12 projects that is **8.0 million satellite pixels** actually counted.

**Fictional** — the projects and the buyers. Boundaries, names, `AMZ-####` IDs, credit volumes,
claimed baselines and all five companies are invented. Attaching fabricated fraud figures to a
real registry entry or a real company would be defamation, so nothing real is ever named. The
polygons sit at real coordinates, which is what lets real data be measured underneath them.

Put plainly: **the claim is fictional, the check is real.**

## The method

No model, no machine learning. Four measurements, three subtractions, one division — all of it
shown on screen so a grade can be audited by eye.

1. Buffer the project boundary out to **20 km**, then punch out a **5 km cushion** — clearing
   displaced just over the border would contaminate the near band. What remains is the ring:
   same soil, same roads, same economics, no project money.
2. Measure forest cover for {project, ring} × {2015, 2023}.
3. `loss_project`, `loss_ring` — relative loss in each zone.
4. `actually_protected = loss_ring − loss_project`
5. `additionality = actually_protected ÷ claimed_baseline`
6. `credits_unsupported = credits_issued × (1 − additionality)`, at **$5.69**/credit.

Grades: `≥80% A · 50–80% B · 25–50% C · 5–25% D · <5% F`.

### Confidence

Four signals, each computed from the data rather than assumed, each itemized in the UI:

- **Data completeness** — share of tiles that failed to load.
- **Ring comparability** — canopy gap between project and ring in 2000. A ring that never
  resembled the project is a weak counterfactual whatever happened next.
- **Pre-period divergence** — whether the two zones were already diverging *before* the
  crediting window. If they were, the ring was never a clean control.
- **Counterfactual signal** — how much the ring actually lost. Below 1.5% this hard-caps
  confidence at low: with nothing happening outside the boundary there is nothing to be
  additional to, and the comparison cannot resolve a project effect in either direction.

A failing grade at low confidence means *"we cannot resolve this from orbit"* — never misconduct.
Flags read **"flagged for field verification"** throughout, which is exactly what they mean.

## Layout

| file | role |
|---|---|
| `engine.js` | the entire analysis. Pure, no React, no I/O, no network. |
| `forestData.js` | reads and decodes the real satellite tiles |
| `geometry.js` | project footprint and the 5–20 km counterfactual ring |
| `changeCanvas.js` | decodes loss years into the scrubable map overlay |
| `mercator.js` | tile math and one shared tile cache |
| `data.js` | the fictional layer, kept deliberately separate |
| `measurements.json` | bundled real measurements, so the app opens instantly |
| `selfcheck.mjs` | asserts the invariants the demo depends on |

Measurements are bundled so the index loads with no network round-trip and no flicker. Any
project's **"Re-measure from live satellite tiles"** button re-runs the identical read against the
live service and reports whether it matches — the numbers are verifiable in front of an audience,
not taken on trust.

Regenerate them yourself:

```
npm run dev            # terminal 1
npm run measure        # terminal 2 — refetches every tile, rewrites measurements.json
npm run check
```

## Limitations

- **The ring is an approximation.** Land economics can differ across a boundary in ways canopy
  and pre-trend comparisons don't capture.
- **30 m pixels have a floor.** Selective logging under an intact canopy is invisible.
- **Loss ≠ deforestation.** Hansen records canopy loss, which includes fire, windthrow and
  plantation harvest. Phantom does not currently separate them, so a natural disturbance can
  read as project failure. This is the most important open gap.
- **Coverage ends in 2023**, the last year in GFC v1.11.
- **Claimed baselines are illustrative**, because the projects are fictional. Only the measured
  side of the division is real.

Phantom is a **screening tool**. It exists to say which 20 of 3,000 projects deserve an expensive
on-the-ground audit. It does not deliver verdicts.

## Attribution

Forest data: Hansen/UMD/Google/USGS/NASA, distributed by
[Global Forest Watch](https://www.globalforestwatch.org) (CC BY 4.0).
Basemap © [CARTO](https://carto.com/), © OpenStreetMap contributors.
Map rendering by [MapLibre GL JS](https://maplibre.org).
