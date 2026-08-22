// verdicts.js — bind the fictional projects to their real measurements.
// Pure arithmetic over bundled data: no network, no async, no flicker on reload.

import { analyzeCovers } from "./engine.js";
import { coversFrom, statsFrom, coverSeriesFrom } from "./forestData.js";
import { PROJECTS } from "./data.js";
import M from "./measurements.json";

export const MEASUREMENT_META = {
  source: M.source,
  citation: M.citation,
  license: M.license,
  measuredAt: M.measuredAt,
  zoom: M.zoom,
  baseYear: M.baseYear,
  endYear: M.endYear,
  canopyThresholdPct: M.canopyThresholdPct,
};

export const measurementFor = (id) => M.byProject[id];

export function verdictFor(project, measurement = M.byProject[project.id]) {
  return analyzeCovers(
    project,
    coversFrom(measurement, M.baseYear, M.endYear),
    statsFrom(measurement, M.baseYear)
  );
}

// Full history, not just the crediting window: the years before it are what
// show whether the ring was ever a fair control.
export const historyFor = (id, from = 2001) => coverSeriesFrom(M.byProject[id], from, M.endYear);

export const VERDICTS = PROJECTS.map((project) => ({ project, verdict: verdictFor(project) }));
export const verdictById = Object.fromEntries(VERDICTS.map((x) => [x.project.id, x.verdict]));
export const projectById = Object.fromEntries(PROJECTS.map((p) => [p.id, p]));

export const TOTALS = {
  projects: PROJECTS.length,
  credits: PROJECTS.reduce((s, p) => s + p.creditsIssued, 0),
  hectares: PROJECTS.reduce((s, p) => s + p.areaHa, 0),
  dollarsUnsupported: VERDICTS.reduce((s, x) => s + x.verdict.dollarsUnsupported, 0),
  pixels: VERDICTS.reduce((s, x) => s + x.verdict.stats.pixelsMeasured, 0),
};
