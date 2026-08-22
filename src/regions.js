// regions.js — the switchable showcase regions. Each is a fully independent
// dataset (its own REGION framing, project list and comparable-parcel pool);
// switching regions swaps all three together rather than merging them onto
// one map.

import { REGION as AMAZON_REGION, PROJECTS as AMAZON_PROJECTS } from "./projects.js";
import cellsAmazonData from "./cells.json" with { type: "json" };
import { REGION as KARIBA_REGION, PROJECTS as KARIBA_PROJECTS } from "./projects-kariba.js";
import cellsKaribaData from "./cells-kariba.json" with { type: "json" };
import { WINDOW as AMAZON_WINDOW, REFERENCE_PERIOD as AMAZON_REFERENCE_PERIOD } from "./baseline.js";

export const REGIONS = [
  {
    key: "amazon",
    label: "Amazon",
    sublabel: "Brazilian Legal Amazon",
    sourceLabel: "INPE PRODES, the official Brazilian Amazon record",
    REGION: { ...AMAZON_REGION, window: AMAZON_WINDOW, referencePeriod: AMAZON_REFERENCE_PERIOD },
    PROJECTS: AMAZON_PROJECTS,
    CELLS: cellsAmazonData.cells,
  },
  {
    key: "kariba",
    label: "Zimbabwe",
    sublabel: "Zambezi Valley, Kariba REDD+",
    sourceLabel: "Hansen Global Forest Change via Global Nature Watch (formerly Global Forest Watch)",
    REGION: KARIBA_REGION,
    PROJECTS: KARIBA_PROJECTS,
    CELLS: cellsKaribaData.cells,
  },
];

export const DEFAULT_REGION_KEY = "amazon";
export const regionByKey = (key) => REGIONS.find((r) => r.key === key) ?? REGIONS[0];
