// companyData.js — portfolio-level translations of Phantom's project audits.
//
// The leaderboard is intentionally split in two:
//   1. an illustrative, fully reconciled dataset that can be ranked end to end;
//   2. sourced public records about real companies, which are not ranked while
//      coverage is incomplete. A known link to one project is not a company's
//      whole forest-credit portfolio.

import { ACTORS, PARTIES, actorById, purchaseRows } from "./actors.js";
import { REGIONS } from "./regions.js";
import {
  matchControls, counterfactual, auditBaseline, divergenceTimeline,
} from "./baseline.js";

const HIGH_RISK_BANDS = new Set(["high", "severe"]);

const round = (value) => Math.round(value);
const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);

/** Run the exact same comparison used by the project panel. */
export function analyzeProject(project, region) {
  const host = region.CELLS.find((cell) => cell.id === project.hostCellId) ?? project.parcel;
  const { matches, considered } = matchControls(host, region.CELLS);
  const cf = counterfactual(matches, region.REGION.window);
  return {
    audit: auditBaseline(project, cf),
    timeline: divergenceTimeline(project, matches, region.REGION.window),
    controls: matches.length,
    considered,
  };
}

export const PROJECT_ANALYSES = REGIONS.flatMap((region) =>
  region.PROJECTS.map((project) => ({
    project,
    region,
    ...analyzeProject(project, region),
  }))
);

const analysisById = new Map(PROJECT_ANALYSES.map((row) => [row.project.id, row]));

const supportLabel = (score) => {
  if (score >= 80) return "Strong support";
  if (score >= 60) return "Mixed support";
  if (score >= 40) return "Limited support";
  return "Low support";
};

const scoreColor = (score) => {
  if (score >= 80) return "#2fbf71";
  if (score >= 60) return "#9bcf3b";
  if (score >= 40) return "#e8b931";
  return "#e5484d";
};

/**
 * One row per illustrative buyer.
 *
 * Portfolio score = purchased-credit weighted supported share.
 * A project supporting 80% of its baseline and representing twice the buyer's
 * credits contributes twice the weight of a 40% project. No transparency or
 * response score is invented where the dataset has no evidence for one.
 */
export const BUYER_LEADERBOARD = ACTORS.filter((actor) => actor.role === "buyer")
  .map((actor) => {
    const holdings = [];

    for (const row of PROJECT_ANALYSES) {
      if (!PARTIES[row.project.id]?.buyers.includes(actor.id)) continue;
      const purchase = purchaseRows(row.project).find((item) => item.actor.id === actor.id);
      if (!purchase) continue;

      const supportedCredits = round(purchase.credits * row.audit.supportedShare);
      const unsupportedCredits = purchase.credits - supportedCredits;
      holdings.push({
        ...row,
        purchase,
        supportedCredits,
        unsupportedCredits,
        highRiskCredits: HIGH_RISK_BANDS.has(row.audit.band.key) ? purchase.credits : 0,
      });
    }

    const credits = sum(holdings, (row) => row.purchase.credits);
    const supportedCredits = sum(holdings, (row) => row.supportedCredits);
    const unsupportedCredits = credits - supportedCredits;
    const highRiskCredits = sum(holdings, (row) => row.highRiskCredits);
    const score = credits ? round((supportedCredits / credits) * 100) : 0;

    return {
      id: actor.id,
      actor,
      holdings: holdings.sort((a, b) => b.unsupportedCredits - a.unsupportedCredits),
      score,
      scoreLabel: supportLabel(score),
      color: scoreColor(score),
      credits,
      supportedCredits,
      unsupportedCredits,
      highRiskCredits,
      highRiskShare: credits ? highRiskCredits / credits : 0,
      flaggedProjects: holdings.filter((row) => row.timeline.firstFlagYear).length,
      projects: holdings.length,
      regions: new Set(holdings.map((row) => row.region.key)).size,
      evidence: "Illustrative retirement ledger",
    };
  })
  .filter((row) => row.credits > 0)
  .sort((a, b) => b.score - a.score || b.credits - a.credits)
  .map((row, index) => ({ ...row, rank: index + 1 }));

/** Developers are scored on issued credits because they create the baseline. */
export const DEVELOPER_LEADERBOARD = ACTORS.filter((actor) => actor.role === "developer")
  .map((actor) => {
    const projects = PROJECT_ANALYSES.filter(
      (row) => PARTIES[row.project.id]?.developer === actor.id
    );
    const creditsIssued = sum(projects, (row) => row.project.creditsIssued ?? 0);
    const supportedCredits = sum(
      projects,
      (row) => round((row.project.creditsIssued ?? 0) * row.audit.supportedShare)
    );
    const score = creditsIssued ? round((supportedCredits / creditsIssued) * 100) : 0;
    const meanDiscrepancyPts = projects.length
      ? sum(projects, (row) => row.audit.discrepancyPts) / projects.length
      : 0;

    return {
      id: actor.id,
      actor,
      holdings: [...projects].sort((a, b) => b.audit.discrepancyPts - a.audit.discrepancyPts),
      score,
      scoreLabel: supportLabel(score),
      color: scoreColor(score),
      projects: projects.length,
      creditsIssued,
      supportedCredits,
      unsupportedCredits: creditsIssued - supportedCredits,
      meanDiscrepancyPts,
      flaggedProjects: projects.filter((row) => row.timeline.firstFlagYear).length,
      verifiers: [...new Set(projects.map((row) => PARTIES[row.project.id]?.verifier).filter(Boolean))]
        .map(actorById),
      registries: [...new Set(projects.map((row) => PARTIES[row.project.id]?.registry).filter(Boolean))]
        .map(actorById),
      evidence: "Illustrative project records",
    };
  })
  .filter((row) => row.projects > 0)
  .sort((a, b) => b.score - a.score || b.creditsIssued - a.creditsIssued)
  .map((row, index) => ({ ...row, rank: index + 1 }));

// Every public-record statement below links to the source that published it.
// These records establish a reported relationship to Kariba; they do not claim
// to be a complete transaction ledger or a company-wide portfolio assessment.
const LEGACY_PUBLIC_SOURCES = {
  verra2025: {
    id: "verra2025",
    date: "2025-09-23",
    publisher: "Verra",
    title: "Verra acts on Kariba project and cancels excess credits",
    url: "https://verra.org/verra-acts-on-kariba-project-cancels-excess-credits-advances-independent-review/",
    summary: "Verra published the result of its carbon-accounting review and its treatment of excess credits.",
  },
  ftm2023: {
    id: "ftm2023",
    date: "2023-01-27",
    publisher: "Follow the Money",
    title: "Showcase project by the world's biggest carbon trader resulted in more carbon emissions",
    url: "https://www.ftm.eu/articles/south-pole-kariba-carbon-emission/kort",
    summary: "The investigation names corporate customers and records responses from Volkswagen and Greenchoice.",
  },
  finanz2023: {
    id: "finanz2023",
    date: "2023-10-30",
    publisher: "Finansavisen",
    title: "Carbon-credit project faces billion-krone collapse",
    url: "https://www.finansavisen.no/esg/2023/10/30/8052036/milliardkollaps-for-karbonkreditt-prosjekt",
    summary: "Reporting names Volkswagen, Nestle, L'Oreal, Gucci and McKinsey as buyers of Kariba credits.",
  },
  cmw2025: {
    id: "cmw2025",
    date: "2025-07-01",
    publisher: "Carbon Market Watch / NewClimate Institute",
    title: "Corporate Climate Responsibility Monitor 2025: Volkswagen",
    url: "https://carbonmarketwatch.org/wp-content/uploads/2025/07/CCRM2025_SectionB4_Automobile_Standalone_v03_web.pdf",
    summary: "The report says Kariba represented 20% of Volkswagen's 5.9 MtCO2e credit acquisitions in 2022.",
  },
  volkswagen2024: {
    id: "volkswagen2024",
    date: "2025-03-11",
    publisher: "Volkswagen Group",
    title: "Volkswagen Group Sustainability Report 2024",
    url: "https://www.volkswagen-group.com/en/publications/more/annual-report-2024-2931/download?disposition=attachment",
    summary: "Volkswagen describes its current standards and process for purchasing and retiring carbon credits.",
  },
  loreal2024: {
    id: "loreal2024",
    date: "2025-03-14",
    publisher: "L'Oreal",
    title: "2024 Universal Registration Document: climate outcomes",
    url: "https://www.loreal-finance.com/eng/2024-universal-registration-document/en/article/209/",
    summary: "L'Oreal states that it does not currently use carbon offsetting mechanisms.",
  },
  latimes2025: {
    id: "latimes2025",
    date: "2025-10-17",
    publisher: "Los Angeles Times",
    title: "Majority of corporate carbon credits from tarnished project deemed unsupported",
    url: "https://www.latimes.com/business/story/2025-10-17/majority-of-carbon-credits-from-tarnished-project-deemed-bogus",
    summary: "Reporting revisits corporate use of Kariba credits after Verra's review and records company responses.",
  },
};

const legacyPublicCompany = ({ id, name, relationshipSourceIds, articleIds, knownCredits = null, note }) => ({
  id,
  name,
  projectId: "KARIBA-902",
  relationship: "Named in published reporting as a buyer of Kariba REDD+ credits",
  relationshipSourceIds,
  articles: articleIds.map((sourceId) => LEGACY_PUBLIC_SOURCES[sourceId]),
  knownCredits,
  note,
  confidence: knownCredits == null ? "Relationship reported; volume not available" : "Relationship and 2022 volume reported",
});

const LEGACY_PUBLIC_COMPANIES = [
  legacyPublicCompany({
    id: "public-volkswagen",
    name: "Volkswagen Group",
    relationshipSourceIds: ["ftm2023", "finanz2023", "cmw2025"],
    articleIds: ["cmw2025", "volkswagen2024", "ftm2023", "verra2025", "latimes2025"],
    knownCredits: 1180000,
    note: "The 1.18M figure is 20% of the 5.9 MtCO2e acquired in 2022, as reported by Carbon Market Watch and NewClimate Institute.",
  }),
  legacyPublicCompany({
    id: "public-loreal",
    name: "L'Oreal",
    relationshipSourceIds: ["finanz2023"],
    articleIds: ["finanz2023", "loreal2024", "verra2025"],
    note: "The source identifies a Kariba purchase but does not provide a volume; L'Oreal's later disclosure says it does not currently use offsets.",
  }),
  legacyPublicCompany({
    id: "public-nestle",
    name: "Nestle",
    relationshipSourceIds: ["finanz2023"],
    articleIds: ["finanz2023", "latimes2025", "verra2025"],
    note: "The attached reporting identifies a Kariba purchase, but the exact quantity is not available in these sources.",
  }),
  legacyPublicCompany({
    id: "public-gucci",
    name: "Gucci",
    relationshipSourceIds: ["ftm2023", "finanz2023"],
    articleIds: ["ftm2023", "finanz2023", "latimes2025", "verra2025"],
    note: "The attached reporting identifies a Kariba purchase, but the exact quantity is not available in these sources.",
  }),
  legacyPublicCompany({
    id: "public-mckinsey",
    name: "McKinsey & Company",
    relationshipSourceIds: ["finanz2023"],
    articleIds: ["finanz2023", "latimes2025", "verra2025"],
    note: "The attached reporting identifies a Kariba purchase, but the exact quantity is not available in these sources.",
  }),
  legacyPublicCompany({
    id: "public-greenchoice",
    name: "Greenchoice",
    relationshipSourceIds: ["ftm2023"],
    articleIds: ["ftm2023", "verra2025"],
    note: "Follow the Money identifies Greenchoice as a major Kariba buyer and reports that the company said it acted in good faith.",
  }),
].map((company) => ({ ...company, projectAnalysis: analysisById.get(company.projectId) }));

// Project-first evidence for the one registered project currently on the map.
// The legacy records above are retained only as source history; this is the
// exported, reproducible source catalog used by the current public dataset.
export const PUBLIC_SOURCES = {
  ...LEGACY_PUBLIC_SOURCES,
  berkeleyVrod2026: {
    id: "berkeleyVrod2026", date: "2026-06", publisher: "Berkeley Carbon Trading Project",
    title: "Voluntary Registry Offsets Database (VROD), version 2026-06",
    url: "https://gspp.berkeley.edu/berkeley-carbon-trading-project/offsets-database",
    summary: "Documents the combined public project, issuance and retirement database used to cross-check registry records.",
  },
  berkeleyRaw2026: {
    id: "berkeleyRaw2026", date: "2026-06", publisher: "Berkeley Carbon Trading Project",
    title: "VROD registry-source workbook, version 2026-06",
    url: "https://10edb8fc77.nxcli.io/assets/uploads/page/VROD-registry-files--2026-06.xlsx",
    summary: "Preserves beneficiary, retirement-detail, vintage, date and quantity fields used in the Kariba extraction.",
  },
  carbonplanDocs: {
    id: "carbonplanDocs", date: "2026", publisher: "CarbonPlan",
    title: "Offsets database: data processing documentation",
    url: "https://offsets-db-data.readthedocs.io/en/latest/data-processing.html",
    summary: "Documents how public registry files are normalized into a reproducible offsets dataset.",
  },
  carbonplanDataset: {
    id: "carbonplanDataset", date: "2026-08-22", publisher: "CarbonPlan",
    title: "Offsets database: latest production dataset",
    url: "https://carbonplan-offsets-db.s3.us-west-2.amazonaws.com/production/latest/offsets-db.csv.zip",
    summary: "Machine-readable source for the VCS 902 retirement rows; this latest-version link changes over time.",
  },
  verraRegistry902: {
    id: "verraRegistry902", date: "2026", publisher: "Verra Registry",
    title: "VCS project 902: Kariba REDD+ Project",
    url: "https://registry.verra.org/verra/public/program/VCS/projects/902",
    summary: "Official project record identifying Kariba, its proponent, methodology, status and documents.",
  },
  verraReview2025: {
    id: "verraReview2025", date: "2025-09-23", publisher: "Verra",
    title: "Verra acts on Kariba project and cancels excess credits",
    url: "https://verra.org/verra-acts-on-kariba-project-cancels-excess-credits-advances-independent-review/",
    summary: "Verra's review determined that 15,220,520 credits were excess and explains the cancellation process.",
  },
  verraReview2026: {
    id: "verraReview2026", date: "2026", publisher: "Verra",
    title: "Second part of Verra's quality-control review of Kariba",
    url: "https://verra.org/verra-releases-results-from-second-part-of-quality-control-review-of-kariba-project/",
    summary: "Official follow-up describing monitoring-period verification work and the bodies involved.",
  },
  carbonGreenAfrica: {
    id: "carbonGreenAfrica", date: "2026", publisher: "Carbon Green Africa",
    title: "Kariba REDD+ Project", url: "https://carbongreenafrica.net/kariba-redd-project/",
    summary: "The local operator describes work with the four participating Rural District Councils and leaseholders.",
  },
  southPoleStatement2023: {
    id: "southPoleStatement2023", date: "2023-10-27", publisher: "South Pole",
    title: "Statement on the Kariba REDD+ project", url: "https://www.southpole.com/news/statement-27october",
    summary: "Describes South Pole's certification-management and marketing role and the end of the relationship.",
  },
  verraMethodology: {
    id: "verraMethodology", date: "2026", publisher: "Verra",
    title: "VM0009 Methodology for Avoided Ecosystem Conversion",
    url: "https://verra.org/methodologies/vm0009-methodology-for-avoided-ecosystem-conversion-v3-0/",
    summary: "Official methodology page recording VM0009's development history and inactive status.",
  },
  greenchoicePrimary: {
    id: "greenchoicePrimary", date: "2023", publisher: "Greenchoice", title: "Greenchoice on the Kariba forest project",
    url: "https://www.greenchoice.nl/nieuws/artikelen/greenchoice-over-kariba/",
    summary: "Greenchoice's statement addressing its Kariba involvement and the later project controversy.",
  },
  gucciPrimary: {
    id: "gucciPrimary", date: "2020", publisher: "Gucci", title: "Gucci Equilibrium Impact Report 2020",
    url: "https://www.gucci.com/componentsfront/_public/equilibrium/impact-report/Gucci-Equilibrium-Impact-Report-2020_interactive.pdf",
    summary: "Primary context for Gucci's climate claims and offsetting program during the retirement period.",
  },
  volkswagenPrimary: {
    id: "volkswagenPrimary", date: "2023", publisher: "Volkswagen", title: "Volkswagen Commercial Vehicles climate-project disclosure",
    url: "https://media.volkswagen.fr/volkswagen-vehicules-utilitaires-contribue-au-developpement-des-energies-renouvelables-en-sengageant-dans-un-projet-de-centrales-solaires-en-espagne/",
    summary: "Primary context for the brand's residual-emissions program; Kariba quantities come from retirement records.",
  },
  nestlePrimary: {
    id: "nestlePrimary", date: "2022", publisher: "Nestle", title: "Nestle CDP climate-change response 2022",
    url: "https://www.nestle.com/sites/default/files/2022-12/cdp-nestle-answers-climate-change-2022.pdf",
    summary: "Primary disclosure describing the parent company's climate and carbon-credit program.",
  },
  nespressoPrimary: {
    id: "nespressoPrimary", date: "2022-12", publisher: "Nespresso", title: "Qualifying explanatory statement on carbon neutrality 2022",
    url: "https://nestle-nespresso.com/sites/site.prod.nestle-nespresso.com/files/Qualifying-Explainatory-Statement-Carbon-Neutrality-2022_December-2022.pdf",
    summary: "Primary context for the Nespresso aliases and carbon-neutrality claims.",
  },
  mckinseyPrimary: {
    id: "mckinseyPrimary", date: "2022", publisher: "McKinsey & Company", title: "McKinsey CDP climate report submitted in 2022",
    url: "https://www.mckinsey.com/spContent/bespoke/esg-2023-sean/pdfs/2021-cdp-climate-report-submitted-in-2022.pdf",
    summary: "Primary context for McKinsey's offsetting approach.",
  },
  lorealPrimary: {
    id: "lorealPrimary", date: "2021", publisher: "L'Oreal Paris", title: "L'Oreal Paris carbon-neutrality announcement",
    url: "https://es.lorealparisusa.com/-/media/project/loreal/brand-sites/oap/americas/us/articles/the-other-side/pr-loral-paris-2021page.pdf?hash=EF49368362559C382180F848E403EB768722D447&la=es-us",
    summary: "Company disclosure of 26,667 Kariba credits; the matching unnamed registry row remains an inference.",
  },
  palantirPrimary: {
    id: "palantirPrimary", date: "2023-12", publisher: "Palantir", title: "Carbon offset purchases disclosure",
    url: "https://www.palantir.com/assets/xrfr7uokpv1b/5PqLQ3QjQT4Yxs0nVll2FN/6956350c76484bd23bbbc017da824ffb/Palantir_-_Carbon_Offset_Purchases__12.2023_.pdf",
    summary: "Discloses 5,000 Kariba credits bought from South Pole USA, despite no Palantir text match in retirement fields.",
  },
};

export const KARIBA_RECORD = {
  projectId: "KARIBA-902", registryProgram: "Verified Carbon Standard (VCS)", registryProjectId: 902,
  name: "Kariba REDD+ Project", country: "Zimbabwe", projectType: "Agriculture, Forestry and Other Land Use",
  methodology: "VM0009 v1.1", status: "Withdrawn from the Verra registry in May 2024",
  proponent: "Carbon Green Investments (Guernsey)", primarySourceId: "verraRegistry902",
  dataScope: "Known exposure to this project only; not a complete company carbon-credit portfolio",
  retrievedAt: "2026-08-22",
};

export const KARIBA_DATA_QUALITY = {
  mapCoverage: { total: 21, registered: 1, illustrative: 20 },
  issuedCredits: 26822953, datedCredits: 25706781, datedRetirementRows: 6967,
  namedBeneficiaryCredits: 12674312, usableNamedRows: 982, namedCoveragePct: 49.30338,
  unnamedPlaceholderCredits: 13032469, unnamedPlaceholderRows: 5985, undatedOrUnallocatedCredits: 1116172,
  excessCredits: 15220520, excessSharePct: 56.7444, supportedCredits: 11602433, supportedSharePct: 43.2556,
  serialMappingAvailable: false, rankingReadiness: "Project exposure only",
  caveat: "No serial-level mapping connects Verra's excess-credit determination to individual retirement rows, so buyer-specific supported or excess shares cannot be assigned.",
};

export const KARIBA_SUPPLY_CHAIN = [
  { role: "Project proponent / owner / developer", entity: "Carbon Green Investments (Guernsey)", note: "Official Verra project proponent for VCS 902.", sourceId: "verraRegistry902", sourceUrl: PUBLIC_SOURCES.verraRegistry902.url },
  { role: "Local project operator", entity: "Carbon Green Africa", note: "Works with Binga, Hurungwe, Nyaminyami and Mbire Rural District Councils and leaseholders.", sourceId: "carbonGreenAfrica", sourceUrl: PUBLIC_SOURCES.carbonGreenAfrica.url },
  { role: "Carbon asset developer / marketer", entity: "South Pole", note: "Managed certification and marketing/sales; its relationship ended October 27, 2023.", sourceId: "southPoleStatement2023", sourceUrl: PUBLIC_SOURCES.southPoleStatement2023.url },
  { role: "Standard and registry", entity: "Verra VCS", note: "Registered the project and issued the official excess-credit determination.", sourceId: "verraReview2025", sourceUrl: PUBLIC_SOURCES.verraReview2025.url },
  { role: "Baseline methodology", entity: "VM0009 v1.1", note: "Originally developed by Wildlife Works and now inactive.", sourceId: "verraMethodology", sourceUrl: PUBLIC_SOURCES.verraMethodology.url },
  { role: "Validation / verification bodies", entity: "Environmental Services Inc.; SCS Global Services; Aster Global; AENOR Internacional", note: "ESI reviewed monitoring period 1, SCS periods 2-3, Aster period 4 and AENOR period 5.", sourceId: "verraReview2026", sourceUrl: PUBLIC_SOURCES.verraReview2026.url },
];

const REGISTRY_EVIDENCE = ["berkeleyRaw2026", "carbonplanDataset"];

const projectExposure = ({ relationshipSourceIds, articleIds, ...record }) => ({
  ...record,
  projectId: KARIBA_RECORD.projectId,
  relationship: `Known exposure to ${KARIBA_RECORD.name}`,
  relationshipSourceIds,
  articleIds,
  articles: articleIds.map((sourceId) => PUBLIC_SOURCES[sourceId]),
  confidence: record.evidenceLabel,
});

const PROJECT_EXPOSURES = [
  projectExposure({
    id: "public-greenchoice", name: "Greenchoice", knownCredits: 4286368,
    evidenceKind: "registry-beneficiary-exact", evidenceLabel: "Exact registry beneficiary aggregation",
    aliases: ["Greenchoice"], beneficiaryStrings: ["Greenchoice"], retirementRows: 51,
    vintageRange: "2011-07-01 to 2016-06-30", retirementRange: "2016-03-04 to 2022-01-31", registryMatch: "direct",
    note: "All 51 rows name Greenchoice directly. This is project exposure, not Greenchoice's complete offset portfolio.",
    relationshipSourceIds: [...REGISTRY_EVIDENCE, "greenchoicePrimary"],
    articleIds: ["greenchoicePrimary", "ftm2023", "verraReview2025"],
  }),
  projectExposure({
    id: "public-gucci", name: "Gucci", knownCredits: 2935000,
    evidenceKind: "registry-alias-group", evidenceLabel: "Registry aliases reconciled",
    aliases: ["Gucci", "Guccio Gucci S.p.A."], beneficiaryStrings: ["Guccio Gucci Spa", "Guccio Gucci S.p.a"], retirementRows: 10,
    vintageRange: "2013-01-01 to 2019-06-30", retirementRange: "2020-11-12 to 2022-06-17", registryMatch: "alias-grouped",
    note: "Two punctuation/capitalization variants were grouped once under Gucci; no Kering affiliate rows are included.",
    relationshipSourceIds: [...REGISTRY_EVIDENCE, "gucciPrimary"],
    articleIds: ["gucciPrimary", "ftm2023", "verraReview2025"],
  }),
  projectExposure({
    id: "public-volkswagen-brand", name: "Volkswagen brand", knownCredits: 1285000,
    evidenceKind: "registry-alias-group", evidenceLabel: "Brand aliases reconciled; affiliates separated",
    aliases: ["Volkswagen passenger cars", "Volkswagen Commercial Vehicles", "VW passenger cars"],
    beneficiaryStrings: ["Volkswagen Marke Pkw", "Marke Volkswagen", "Marke VW Pkw", "Volkswagen Nutzfahrzeuge"], retirementRows: 10,
    vintageRange: "2017-01-01 to 2019-06-30", retirementRange: "2021-02-05 to 2022-12-14", registryMatch: "alias-grouped",
    note: "Volkswagen passenger/commercial-vehicle brand aliases only. Audi, SEAT and SKODA are excluded and shown separately.",
    relationshipSourceIds: [...REGISTRY_EVIDENCE, "volkswagenPrimary"],
    articleIds: ["volkswagenPrimary", "ftm2023", "verraReview2025"],
  }),
  projectExposure({
    id: "public-nestle-linked", name: "Nestle-linked brands", knownCredits: 510500,
    evidenceKind: "registry-parent-group", evidenceLabel: "Parent-linked brand records grouped",
    aliases: ["Nespresso", "NAN Organic", "NAN NATURA", "NAN EKOLOGISK LUOMO", "BEBA Bio", "GUIGOZ Bio"],
    beneficiaryStrings: ["Nespresso S.A. - carbon offsetting", "Nespresso S.A.", "Nespresso", "NAN Organic, NAN NATURA, NAN EKOLOGISK LUOMO, BEBA Bio and GUIGOZ Bio"], retirementRows: 12,
    vintageRange: "2016-01-01 to 2019-06-30", retirementRange: "2021-08-26 to 2022-10-25", registryMatch: "parent-grouped",
    note: "Nespresso contributes 503,000 credits and Nestle infant-formula brands 7,500; neither is repeated as a separate row.",
    relationshipSourceIds: [...REGISTRY_EVIDENCE, "nestlePrimary", "nespressoPrimary"],
    articleIds: ["nespressoPrimary", "nestlePrimary", "finanz2023", "verraReview2025"],
  }),
  projectExposure({
    id: "public-skoda", name: "SKODA AUTO", knownCredits: 504000,
    evidenceKind: "registry-alias-group", evidenceLabel: "Registry aliases reconciled",
    aliases: ["SKODA AUTO a.s.", "SKODA AUTO a.s. (diacritic/encoding variant)"],
    beneficiaryStrings: ["SKODA AUTO a.s.", "SKODA AUTO a.s. (registry encoding variant)"], retirementRows: 6,
    vintageRange: "2012-01-01 to 2019-06-30", retirementRange: "2021-04-01 to 2022-05-06", registryMatch: "alias-grouped",
    note: "Six rows were normalized across plain-ASCII and diacritic/encoding variants; none is included in Volkswagen's row.",
    relationshipSourceIds: REGISTRY_EVIDENCE, articleIds: ["verraRegistry902", "verraReview2025"],
  }),
  projectExposure({
    id: "public-ey", name: "EY group", knownCredits: 384018,
    evidenceKind: "registry-beneficiary-and-detail", evidenceLabel: "Beneficiary aliases plus explicit retirement details",
    aliases: ["EY Global Services Limited", "EYGS"],
    beneficiaryStrings: ["EY Global Services Ltd.", "EYGS", "_ (details: retired on behalf of EY Global Services)"], retirementRows: 8,
    vintageRange: "2013-01-01 to 2019-06-30", retirementRange: "2020-12-30 to 2022-09-27", registryMatch: "alias-and-detail",
    note: "247,018 credits name EY/EYGS as beneficiary; 137,000 use a placeholder beneficiary but explicitly name EY in details.",
    relationshipSourceIds: REGISTRY_EVIDENCE, articleIds: ["verraRegistry902", "verraReview2025"],
  }),
  projectExposure({
    id: "public-nandos", name: "Nando's", knownCredits: 373975,
    evidenceKind: "registry-beneficiary-and-detail", evidenceLabel: "Beneficiary aliases plus explicit retirement details",
    aliases: ["Nando's Chickenland Limited", "Nando's Chickenland UK"],
    beneficiaryStrings: ["Nando's Chickenland Limited", "Nando's Chickenland UK", "_ (details name Nando's Chickenland Ltd)"], retirementRows: 5,
    vintageRange: "2013-01-01 to 2015-12-31", retirementRange: "2021-08-19 to 2023-02-03", registryMatch: "alias-and-detail",
    note: "Direct Nando's beneficiary rows and placeholder rows with explicit on-behalf-of details are grouped once.",
    relationshipSourceIds: REGISTRY_EVIDENCE, articleIds: ["verraRegistry902", "verraReview2025"],
  }),
  projectExposure({
    id: "public-seat", name: "SEAT", knownCredits: 247608,
    evidenceKind: "registry-beneficiary-exact", evidenceLabel: "Exact registry beneficiary record",
    aliases: ["SEAT S.A."], beneficiaryStrings: ["SEAT S.A."], retirementRows: 1,
    vintageRange: "2017-01-01 to 2017-12-31", retirementRange: "2022-11-11", registryMatch: "direct",
    note: "The SEAT retirement is separate from Volkswagen and other group brands to prevent parent/brand duplication.",
    relationshipSourceIds: REGISTRY_EVIDENCE, articleIds: ["verraRegistry902", "verraReview2025"],
  }),
  projectExposure({
    id: "public-supercell", name: "Supercell", knownCredits: 175789,
    evidenceKind: "registry-beneficiary-and-detail", evidenceLabel: "Direct, intermediary and detail records reconciled",
    aliases: ["Supercell Oy", "Supercell"],
    beneficiaryStrings: ["Supercell Oy", "Compensate Foundation (on behalf of Supercell)", "_ (details name Supercell)"], retirementRows: 6,
    vintageRange: "2013-01-01 to 2016-06-30", retirementRange: "2019-06-28 to 2022-06-01", registryMatch: "alias-and-detail",
    note: "Direct, explicit detail and Compensate Foundation on-behalf-of entries are grouped once.",
    relationshipSourceIds: REGISTRY_EVIDENCE, articleIds: ["verraRegistry902", "verraReview2025"],
  }),
  projectExposure({
    id: "public-bayer", name: "Bayer", knownCredits: 150000,
    evidenceKind: "registry-beneficiary-exact", evidenceLabel: "Exact registry beneficiary aggregation",
    aliases: ["Bayer AG"], beneficiaryStrings: ["Bayer AG"], retirementRows: 3,
    vintageRange: "2016-07-01 to 2017-12-31", retirementRange: "2022-05-20 to 2022-10-25", registryMatch: "direct",
    note: "Three registry rows name Bayer AG directly and reconcile to 150,000 credits.",
    relationshipSourceIds: REGISTRY_EVIDENCE, articleIds: ["verraRegistry902", "verraReview2025"],
  }),
  projectExposure({
    id: "public-mckinsey", name: "McKinsey & Company", knownCredits: 150000,
    evidenceKind: "registry-beneficiary-and-detail", evidenceLabel: "Exact beneficiary plus explicit retirement details",
    aliases: ["McKinsey & Co.", "McKinsey & Company"],
    beneficiaryStrings: ["On Behalf of McKinsey & Co.'s 2022 GHG Emissions", "_ (details name McKinsey & Co.)"], retirementRows: 5,
    vintageRange: "2017-01-01 to 2018-12-31", retirementRange: "2021-07-19 to 2022-12-05", registryMatch: "direct-and-detail",
    registryNamedCredits: 62632, registryDetailCredits: 87368,
    note: "62,632 credits are in directly named rows and 87,368 in placeholder-beneficiary rows whose details name McKinsey.",
    relationshipSourceIds: [...REGISTRY_EVIDENCE, "mckinseyPrimary"],
    articleIds: ["mckinseyPrimary", "finanz2023", "verraReview2025"],
  }),
  projectExposure({
    id: "public-delta", name: "Delta Air Lines", knownCredits: 106027,
    evidenceKind: "registry-alias-group", evidenceLabel: "Registry aliases reconciled",
    aliases: ["Delta Air Lines", "Delta Airlines"], beneficiaryStrings: ["Delta Air Lines", "Delta Airlines"], retirementRows: 6,
    vintageRange: "2013-01-01 to 2015-12-31", retirementRange: "2017-05-11 to 2018-08-16", registryMatch: "alias-grouped",
    note: "Six rows across the 'Air Lines' and 'Airlines' variants are grouped once.",
    relationshipSourceIds: REGISTRY_EVIDENCE, articleIds: ["verraRegistry902", "verraReview2025"],
  }),
  projectExposure({
    id: "public-audi", name: "Audi", knownCredits: 34959,
    evidenceKind: "registry-beneficiary-exact", evidenceLabel: "Exact registry beneficiary aggregation",
    aliases: ["AUDI AG"], beneficiaryStrings: ["AUDI AG"], retirementRows: 4,
    vintageRange: "2014-07-01 to 2017-12-31", retirementRange: "2022-11-11", registryMatch: "direct",
    note: "Four AUDI AG rows are separate from Volkswagen, SEAT and SKODA to avoid group-level double counting.",
    relationshipSourceIds: REGISTRY_EVIDENCE, articleIds: ["verraRegistry902", "verraReview2025"],
  }),
  projectExposure({
    id: "public-barclays", name: "Barclays", knownCredits: 30000,
    evidenceKind: "registry-beneficiary-exact", evidenceLabel: "Exact registry beneficiary record",
    aliases: ["Barclays Bank PLC"], beneficiaryStrings: ["Barclays Bank PLC"], retirementRows: 1,
    vintageRange: "2016-07-01 to 2016-12-31", retirementRange: "2022-12-12", registryMatch: "direct",
    note: "One registry row names Barclays Bank PLC directly and retires 30,000 credits.",
    relationshipSourceIds: REGISTRY_EVIDENCE, articleIds: ["verraRegistry902", "verraReview2025"],
  }),
  projectExposure({
    id: "public-loreal-paris", name: "L'Oreal Paris", knownCredits: 26667,
    evidenceKind: "company-disclosure-registry-inference", evidenceLabel: "Company disclosure; registry-row match inferred",
    aliases: ["L'Oreal Paris"], beneficiaryStrings: ["No company text in the candidate registry row"], retirementRows: 1,
    vintageRange: "2019-01-01 to 2019-06-30", retirementRange: "2021-12-06", registryMatch: "inferred-quantity-date",
    note: "The company discloses 26,667 Kariba credits. A same-quantity unnamed row is compatible, but no text or serial link proves the match.",
    relationshipSourceIds: ["lorealPrimary", ...REGISTRY_EVIDENCE],
    articleIds: ["lorealPrimary", "finanz2023", "verraReview2025"],
  }),
  projectExposure({
    id: "public-palantir", name: "Palantir", knownCredits: 5000,
    evidenceKind: "company-disclosure-no-registry-match", evidenceLabel: "Company disclosure; no registry text match",
    aliases: ["Palantir Technologies"], beneficiaryStrings: [], retirementRows: 0,
    vintageRange: null, retirementRange: null, registryMatch: "none",
    note: "Palantir discloses 5,000 Kariba credits bought from South Pole USA, but its name does not appear in beneficiary, reason or detail fields.",
    relationshipSourceIds: ["palantirPrimary"], articleIds: ["palantirPrimary", "verraReview2025"],
  }),
];

export const PUBLIC_COMPANIES = PROJECT_EXPOSURES
  .sort((a, b) => b.knownCredits - a.knownCredits || a.name.localeCompare(b.name))
  .map((company, index) => ({
    ...company,
    exposureRank: index + 1,
    projectAnalysis: analysisById.get(company.projectId),
  }));

export function validateCompanyData() {
  const problems = [];
  const ids = new Set();
  for (const row of BUYER_LEADERBOARD) {
    if (ids.has(row.id)) problems.push(`duplicate buyer ${row.id}`);
    ids.add(row.id);
    if (row.score < 0 || row.score > 100) problems.push(`${row.id}: score outside 0-100`);
    if (row.supportedCredits + row.unsupportedCredits !== row.credits)
      problems.push(`${row.id}: portfolio credits do not reconcile`);
  }
  let previousExposure = Infinity;
  for (const [index, company] of PUBLIC_COMPANIES.entries()) {
    if (ids.has(company.id)) problems.push(`duplicate company ${company.id}`);
    ids.add(company.id);
    if (!company.projectAnalysis) problems.push(`${company.id}: linked project is missing`);
    if (company.projectId !== KARIBA_RECORD.projectId)
      problems.push(`${company.id}: public record is not linked to Kariba`);
    if (!Number.isInteger(company.knownCredits) || company.knownCredits <= 0)
      problems.push(`${company.id}: known credits must be a positive integer`);
    if (!company.evidenceKind || !company.evidenceLabel)
      problems.push(`${company.id}: evidence classification is missing`);
    if (!Array.isArray(company.aliases) || !Array.isArray(company.beneficiaryStrings))
      problems.push(`${company.id}: alias evidence must be an array`);
    if (!Number.isInteger(company.retirementRows) || company.retirementRows < 0)
      problems.push(`${company.id}: retirement row count is invalid`);
    if (company.knownCredits > previousExposure)
      problems.push(`${company.id}: public exposure order is not descending`);
    previousExposure = company.knownCredits;
    if (company.exposureRank !== index + 1)
      problems.push(`${company.id}: exposure rank does not match display order`);
    for (const sourceId of company.relationshipSourceIds) {
      if (!PUBLIC_SOURCES[sourceId]) problems.push(`${company.id}: unknown source ${sourceId}`);
    }
    if (!company.relationshipSourceIds.length) problems.push(`${company.id}: relationship is unsourced`);
    for (const sourceId of company.articleIds) {
      if (!PUBLIC_SOURCES[sourceId]) problems.push(`${company.id}: unknown article ${sourceId}`);
    }
  }
  if (KARIBA_DATA_QUALITY.datedCredits !==
      KARIBA_DATA_QUALITY.namedBeneficiaryCredits + KARIBA_DATA_QUALITY.unnamedPlaceholderCredits)
    problems.push("Kariba dated credit coverage does not reconcile");
  if (KARIBA_DATA_QUALITY.datedRetirementRows !==
      KARIBA_DATA_QUALITY.usableNamedRows + KARIBA_DATA_QUALITY.unnamedPlaceholderRows)
    problems.push("Kariba dated retirement rows do not reconcile");
  if (KARIBA_DATA_QUALITY.issuedCredits !==
      KARIBA_DATA_QUALITY.excessCredits + KARIBA_DATA_QUALITY.supportedCredits)
    problems.push("Kariba review outcome does not reconcile to issued credits");
  if (KARIBA_DATA_QUALITY.issuedCredits !==
      KARIBA_DATA_QUALITY.datedCredits + KARIBA_DATA_QUALITY.undatedOrUnallocatedCredits)
    problems.push("Kariba issued and dated credits do not reconcile");
  if (KARIBA_DATA_QUALITY.mapCoverage.total !==
      KARIBA_DATA_QUALITY.mapCoverage.registered + KARIBA_DATA_QUALITY.mapCoverage.illustrative)
    problems.push("Map project coverage does not reconcile");
  if (KARIBA_DATA_QUALITY.serialMappingAvailable !== false)
    problems.push("Kariba serial-mapping limitation must remain explicit");
  for (const link of KARIBA_SUPPLY_CHAIN) {
    if (!PUBLIC_SOURCES[link.sourceId]) problems.push(`${link.entity}: unknown supply-chain source`);
    if (PUBLIC_SOURCES[link.sourceId]?.url !== link.sourceUrl)
      problems.push(`${link.entity}: supply-chain source URL is inconsistent`);
  }
  return problems;
}
