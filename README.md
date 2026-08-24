Theme: Enviorment
Sponsor Tracks: Render, Base44

# Phantom

**An independent due-diligence layer for forest carbon credits.**

A forest carbon credit is sold against a prediction: how much forest *would* have been lost
without the project. The project writes that prediction itself, from a reference area it chooses.
An auditor checks it was done to methodology, and a registry certifies it. Nobody routinely goes
back and asks whether comparable forest actually behaved the way the baseline said it would.

Phantom asks that question, from the outside, using public satellite records.

---

## Quick start

```bash
git clone <your-repo-url>
cd ignitionhacks-2026
npm install
npm run dev
```

Then open **http://localhost:5173**.

That is the whole setup. There are **no API keys, no accounts and no environment variables**.
Every data source is public and keyless, and all measured data is committed to the repo.

### Requirements

| | |
|---|---|
| **Node.js** | 18 or newer (developed on 22.x). Check with `node -v`. |
| **npm** | 9 or newer, ships with Node. |
| **Browser** | Any current Chrome, Edge, Firefox or Safari. Needs WebGL for the map. |
| **Internet** | Needed at runtime for map tiles (satellite imagery and place labels). All analysis data is local. |

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server on port 5173 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run check` | Run the data and analysis self-check (no network, no browser) |

`npm run check` is the fastest way to confirm a working install. It recomputes every project from
the committed measurements and asserts the invariants the whole argument depends on.

---

## Dependencies

Runtime (`dependencies`):

| Package | Why |
|---|---|
| `react`, `react-dom` | UI |
| `maplibre-gl` | Map rendering, open source, no access token |
| `@turf/turf` | Geometry: point-in-polygon, area, clipping the clearing data |
| `jspdf` | Builds the downloadable PDF report in the browser |

Build and dev (`devDependencies`): `vite`, `@vitejs/plugin-react`, and `playwright`, which is used
only by the screenshot helper in `scripts/` and is not needed to run the app.

### Services used at runtime

None of these require a key.

| Source | Used for |
|---|---|
| [Sentinel-2 cloudless](https://s2maps.eu) by EOX | Annual satellite mosaics, 10 m, 2018 to 2025 |
| [CARTO](https://carto.com) basemaps | Place labels and the dark base layer |
| OpenStreetMap | Underlying label data |

If tiles fail to load, the analysis panel still works; only the imagery goes blank.

---

## Using it

1. Pick a region, **Amazon** or **Zimbabwe**, in the top bar.
2. Click a project on the map or in the list.
3. Press **Run independent verification**. Phantom describes the project's parcel by seven
   characteristics measured before the crediting window opened, finds unprotected parcels that
   match, and shows what actually happened to them.
4. Drag or play the **year slider** to watch recorded clearing appear year by year.
5. Press **Download PDF** for a shareable report: the verdict, the figures, the map as framed, and
   who bought the credits.
6. **Kariba case** in the top bar opens the real, sourced case study.

---

## How the method works

1. **Describe the parcel** by seven covariates measured over the reference period, before the
   crediting window opens, so nothing about the outcome can leak into the comparison.
2. **Match** unprotected parcels that resemble it, excluding anything within 1.5 degrees so
   displaced clearing cannot flatter the result.
3. **Observe** what actually happened to those parcels over the crediting window.
4. **Compare** that against what the project claimed, and against what happened inside the project.

The benefit the record supports is the gap between what comparable land lost and what the
project's own ground lost. Measured against the claim, that gap is its real additionality.

Phantom produces a screening estimate, not an audit. It says a baseline looks unlike what
comparable land actually did, which is a reason to ask for an explanation before money moves. It
makes no finding about any party.

---

## What is real and what is illustrative

Real, all measured, none modelled:

| | |
|---|---|
| Amazon deforestation | [INPE PRODES](https://terrabrasilis.dpi.inpe.br) via TerraBrasilis, the official Brazilian record |
| Zimbabwe deforestation | Hansen Global Forest Change via Global Forest Watch |
| Terrain and rainfall | [Open-Meteo](https://open-meteo.com) |
| Imagery | Sentinel-2 cloudless by EOX |
| Kariba case study | Verra, BeZero Carbon, Climate Home News, REDD-Monitor and Quantum Commodity Intelligence, all cited in-app |

Illustrative: every Amazon project's name, parties, buyers, baseline claim and credit volumes.
They are not real registry entries and they name no real party. Each one is labelled as such in
the interface.

**Kariba REDD+ (VCS 902) is a real, registered project.** Its registry facts are sourced and cited.

> The claim is illustrative. The measurement is real.

---

## Project structure

```
src/
  App.jsx            top-level state: region, selection, year
  MapView.jsx        the map, its layers and the year-stepped clearing
  Panels.jsx         the verification panel and project list
  CompanyPage.jsx    the Kariba buyer-exposure page
  baseline.js        matching, counterfactual, audit, backtest (pure, no I/O)
  report.js          PDF generation
  cells.json         Amazon control pool, generated
  cells-kariba.json  Zimbabwe control pool, generated
  projects.js        project records, generated
  caseStudies.js     sourced write-ups and their validator
  selfcheck.mjs      invariant checks, run by npm run check
public/mapdata/      baked PRODES clearing polygons, one file per project
tools/               data collectors that call the public APIs
scripts/             map-data bake and screenshot helpers
```

### Regenerating the data (optional)

The committed data is enough to run everything. To rebuild it from source:

```bash
npm run collect                 # Amazon control pool, INPE PRODES + Open-Meteo, ~30 min
npm run projects                # measure each footprint, set the illustrative claims
node scripts/bake-map-data.mjs  # clearing polygons for the map
npm run check
```

These call public APIs that rate-limit. Every collector caches to `.cache/` and resumes, so an
interrupted run costs nothing.

---

## Limitations

- **Matched controls are not a randomised trial.** Similar-looking land can still differ in ways
  seven covariates do not capture: land tenure, enforcement, local politics.
- **The control pool is small, because the Amazon is heavily protected.** Only 73 of 277 parcels
  fall under 25 percent protected coverage, so a project is matched against roughly 13 to 27
  controls rather than hundreds.
- **Parcel resolution is one degree.** Matching runs parcel-to-parcel so the comparison is like
  for like. A project's own observed loss is measured on its real footprint, which is finer.
- **PRODES covers clear-cut deforestation in the Brazilian Amazon.** It does not capture
  degradation, and another region needs another source.
- **The observation window ends in 2023**, the last complete PRODES year at collection time.

## Not built

A forward-looking baseline estimator, projecting expected loss for a project with no history to
backtest against, is a separate extension and is deliberately absent. Everything here is observed
history.

## Attribution

Forest data: INPE PRODES; Hansen, UMD, Google, USGS and NASA via Global Forest Watch (CC BY 4.0).
Imagery: Sentinel-2 cloudless by EOX. Basemap: CARTO and OpenStreetMap contributors.
Map rendering: MapLibre GL JS.
