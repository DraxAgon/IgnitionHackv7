# Phantom

**An independent due-diligence layer for forest carbon credits.**

A forest carbon credit is sold against a prediction: how much forest *would* have been lost
without the project. The project writes that prediction itself, from a reference area it
chooses. An auditor checks it was done to methodology, and a registry certifies it.

Nobody routinely goes back and asks the obvious question:

> **Did comparable forest actually behave the way the baseline said it would?**

That question can only be answered years later, with satellite data that did not exist when the
credits were issued. Phantom asks it continuously — and asks it from the outside.

```
npm install
npm run dev        # http://localhost:5173
npm run check      # dataset + analysis invariants, no network
npm run build
```

## What it does

Select a registered forest carbon project, then **Run independent verification**. Phantom:

1. **Describes the project's forest** by seven covariates measured over 2008–2015 — *before* the
   crediting window opens, so nothing about the outcome leaks into the comparison.
2. **Searches the control pool** for unprotected parcels that resemble it, excluding anything
   within 1.5° so displaced clearing cannot flatter the result.
3. **Observes what actually happened** to those parcels over 2016–2023.
4. **Compares** that against what the project claimed would happen, and against what actually
   happened inside the project.

The output is not a verdict. It is a discrepancy and a risk band — this is Castanheira Forest
Reserve, as the shipped data actually reports it:

```
Project's own baseline              ████████████████████████  32.6%
Independent counterfactual          █                          1.2%
Observed loss in the project area                              0.0%

Claimed avoided:      32.6% − 0.0% = 32.6%
Independent estimate:  1.2% − 0.0% =  1.2%

Discrepancy +31.4 pts · above 96% of 27 comparable parcels · risk SEVERE
```

Two of the seven projects come back **Consistent**: their baselines match what comparable land
did. A screening tool that can only accuse is not a screening tool.

### The continuous backtest

The more useful view is the one that runs year by year. A baseline set in 2016 can look
reasonable in 2016 and become obviously wrong by 2019 — while credits are still being issued and
retired against it. Phantom tracks the claimed pace against what comparable land actually did, and
reports the first year the evidence stopped supporting the claim:

> Comparable land was clearing at under half the claimed pace for two consecutive years by 2017.
> On this evidence the baseline **could have been flagged as high-risk** six years before the end
> of the crediting window — while credits were still being issued and retired.

That is the claim the tool makes, and it is deliberately bounded. Phantom produces an estimate
from public data. It does not prove a baseline was wrong, and it makes no finding about any party.

## Who this is for

Buyers. A company spending millions on certified credits currently has one chain of assurance —
project developer, auditor, registry — and no practical way to sanity-check the assumption the
whole thing rests on. Phantom is the second opinion they can run *before* the money moves.

That framing matters and it is also the accurate one. A company that bought certified credits in
good faith did not write the baseline. Nothing in this project accuses a buyer of anything, and
`validateCaseStudy` enforces that in code.

## What is real and what is illustrative

**Real — all of it measured, none of it modelled:**

| | |
|---|---|
| Deforestation | [INPE PRODES](https://terrabrasilis.dpi.inpe.br) via TerraBrasilis WFS — the official Brazilian Amazon record. Annual clear-cut increments, pre-2008 accumulated clearing, non-forest and hydrography masks, conservation units, indigenous lands. |
| Terrain, rainfall | [Open-Meteo](https://open-meteo.com) elevation and archive APIs |
| Imagery | [Sentinel-2 cloudless](https://s2maps.eu) by EOX, 10 m, one mosaic per year 2018–2024 |
| Place names | CARTO, OpenStreetMap |

Every source is public and keyless. There is no API key anywhere in this repository.

**Illustrative — the claim side only:** project names, registry status, claimed baselines and
credit volumes. They are not real registry entries and name no real party. They exist so the
interface can be exercised end to end, and they are chosen to span the risk range.

The deforestation measured *under and around* every project is real, including inside its own
footprint — `tools/make-projects.mjs` queries PRODES for each project's own boundary.

> The claim is illustrative. The check is real.

## Adding a real project

1. Append a record to `src/projects.js` with the published boundary, registry reference,
   methodology, start year, claimed baseline and credit volumes.
2. Write its case study in `src/caseStudies.js` — the container is built and validated, and
   deliberately empty. Read the rules at the top of that file first; the short version is that
   every factual claim carries a citation, you report what a named body *determined* rather than
   what you infer, and buyers are never treated as defendants.
3. `npm run check` will fail the build if a study is unsourced or uses accusation language.

The control pool currently covers the Brazilian Legal Amazon. A project outside it needs a pool
collected for its own region — see `tools/collect.mjs`, where the region is a constant.

## Layout

| file | role |
|---|---|
| `src/baseline.js` | matching, counterfactual, audit, backtest. Pure — no React, no I/O, no network. |
| `src/cells.json` | the control pool, generated |
| `src/projects.js` | project records, generated |
| `src/caseStudies.js` | sourced write-ups + the validator. Empty by design. |
| `tools/collect.mjs` | builds the control pool from public APIs |
| `tools/make-projects.mjs` | measures each project's own footprint, sets the illustrative claims |
| `src/report.js` | the panel as a PDF a buyer can send on — same figures, same wording, same map |
| `src/format.js` | the number formats the panel and the report share, so the two cannot drift |
| `src/selfcheck.mjs` | asserts the invariants, including that matching cannot read the outcome window |

Regenerate everything:

```
npm run collect     # ~30 min, resumable, caches to .cache/
npm run projects
npm run check
```

## Limitations

- **Matched controls are not a randomised trial.** Similar-looking land can still differ in ways
  seven covariates do not capture — land tenure, enforcement, local politics.
- **The control pool is small, because the Amazon is protected.** Only 73 of 277 parcels fall under
  25% protected coverage, so a project is typically matched against 13–27 controls, not hundreds.
  Risk bands are calibrated for that: a percentile cannot exceed (n−1)/n, so with 15 controls the
  strongest possible reading is 93.
- **Parcel outlines on the map are drawn, not measured.** Every zone on the map — the project and
  the parcels it is compared against — is drawn in one shape language, so the two differ by colour
  rather than by kind. A comparable parcel is drawn as an outline inscribed in its one-degree box,
  and its figures are summed over that whole box, so the shape understates the ground behind the
  number rather than overstating it. The popup says so. `UNIFORM_REFERENCE_SHAPES` in `MapView.jsx`
  switches to the baked PRODES forest outlines instead, at the cost of the map reading as blobs
  beside rectangles — those outlines are box-clipped, so a parcel with little to subtract comes
  back as very nearly its box.
- **Parcel resolution is 1°.** Matching happens parcel-to-parcel so the comparison is like for
  like; a project's own observed loss is measured on its real footprint, which is finer.
- **Rainfall is missing.** Open-Meteo's daily quota ran out during collection. The covariate is
  null throughout and matching simply skips it — re-run `npm run collect` to fill it in.
- **PRODES is clear-cut deforestation in the Brazilian Amazon.** It does not capture degradation,
  and it does not exist elsewhere; another region needs another source.
- **Bounding-box sums count straddling polygons whole.** Parcel areas come from WFS bbox queries,
  so a large non-forest or water polygon crossing a parcel edge is counted fully on both sides.
  This slightly understates the forest denominator near such features, which slightly overstates
  loss *rates*. The error is symmetric across project and controls, so the comparison between them
  absorbs most of it — but absolute rates should be read as approximate.
- **Claimed baselines here are illustrative**, so the discrepancies shown are exercises. Only the
  measured side of every comparison is real.
- **The observation window ends in 2023**, the last complete PRODES year at time of collection.

## Not built yet

A forward-looking baseline estimator — projecting expected loss for a project that has *no*
history to backtest — is a separate extension and is deliberately absent. Everything in this
repository is observed history.
