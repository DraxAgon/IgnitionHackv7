// carbonNetwork.js — normalized, real-only carbon-credit relationships.
//
// This module is deliberately derived from the sourced Kariba records in
// companyData.js. Illustrative buyer, developer and project fixtures are never
// imported, so they cannot become nodes in the public relationship explorer.

import {
  KARIBA_DATA_QUALITY,
  KARIBA_RECORD,
  KARIBA_SUPPLY_CHAIN,
  PUBLIC_COMPANIES,
  PUBLIC_SOURCES,
} from "./companyData.js";

const PROJECT_ID = "project:vcs-902";

const slug = (value) => String(value)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

const companyId = (legacyId) => `company:${slug(legacyId.replace(/^public-/, ""))}`;
const actorId = (entity) => `actor:${slug(entity)}`;
const sourcesFor = (sourceIds) => sourceIds.map((sourceId) => PUBLIC_SOURCES[sourceId]);

const EXPOSURE_CLASSIFICATION = {
  "registry-beneficiary-exact": {
    relationshipType: "retirement_beneficiary",
    quantityBasis: "registry_retirement_quantity_sum",
    confidence: "high",
    mappingExact: true,
  },
  "registry-alias-group": {
    relationshipType: "retirement_beneficiary",
    quantityBasis: "registry_retirement_quantity_sum",
    confidence: "high",
    mappingExact: true,
  },
  "registry-parent-group": {
    relationshipType: "retirement_beneficiary",
    quantityBasis: "registry_retirement_quantity_sum",
    confidence: "qualified",
    mappingExact: false,
  },
  "registry-beneficiary-and-detail": {
    relationshipType: "other_verified_relationship",
    quantityBasis: "registry_beneficiary_and_retirement_detail_sum",
    confidence: "high",
    mappingExact: true,
  },
  "company-disclosure-registry-inference": {
    relationshipType: "company_disclosure",
    quantityBasis: "company_disclosed_quantity",
    confidence: "qualified",
    mappingExact: false,
  },
  "company-disclosure-no-registry-match": {
    relationshipType: "direct_purchaser",
    quantityBasis: "company_disclosed_purchase_quantity",
    confidence: "high",
    mappingExact: false,
  },
};

const ACTOR_CLASSIFICATION = {
  "Project proponent / owner / developer": {
    role: "project_developer",
    rootNode: true,
    evidenceContext: false,
  },
  "Local project operator": {
    role: "local_operator",
    rootNode: true,
    evidenceContext: false,
  },
  "Carbon asset developer / marketer": {
    role: "carbon_asset_developer_marketer",
    rootNode: true,
    evidenceContext: false,
  },
  "Standard and registry": {
    role: "standard_registry",
    rootNode: false,
    evidenceContext: true,
  },
  "Baseline methodology": {
    role: "baseline_methodology",
    rootNode: false,
    evidenceContext: true,
  },
  "Validation / verification bodies": {
    role: "validation_verification_body",
    rootNode: false,
    evidenceContext: true,
  },
};

export const REAL_COMPANIES = PUBLIC_COMPANIES.map((company) => ({
  id: companyId(company.id),
  legacyId: company.id,
  name: company.name,
  country: null,
  real: true,
}));

const projectAnalysis = PUBLIC_COMPANIES.find(
  (company) => company.projectId === KARIBA_RECORD.projectId
)?.projectAnalysis ?? null;

const projectSourceIds = [
  KARIBA_RECORD.primarySourceId,
  "berkeleyVrod2026",
  "berkeleyRaw2026",
  "verraReview2025",
];

export const REAL_PROJECTS = [{
  id: PROJECT_ID,
  legacyId: KARIBA_RECORD.projectId,
  registryId: "VCS-902",
  registryProgram: KARIBA_RECORD.registryProgram,
  registryProjectId: KARIBA_RECORD.registryProjectId,
  name: KARIBA_RECORD.name,
  shortName: "Kariba REDD+",
  country: KARIBA_RECORD.country,
  projectType: KARIBA_RECORD.projectType,
  methodology: KARIBA_RECORD.methodology,
  status: KARIBA_RECORD.status,
  proponent: KARIBA_RECORD.proponent,
  real: true,
  creditsIssued: KARIBA_DATA_QUALITY.issuedCredits,
  excessCreditsProjectWide: KARIBA_DATA_QUALITY.excessCredits,
  excessSharePctProjectWide: KARIBA_DATA_QUALITY.excessSharePct,
  tracedCredits: 11204911,
  exposureCount: 16,
  informativeBeneficiaryCoveragePct: KARIBA_DATA_QUALITY.namedCoveragePct,
  noCompanyExcessAllocation: true,
  projectAnalysis,
  record: KARIBA_RECORD,
  dataQuality: KARIBA_DATA_QUALITY,
  sourceIds: projectSourceIds,
  sources: sourcesFor(projectSourceIds),
}];

export const REAL_PROJECT_ACTORS = KARIBA_SUPPLY_CHAIN.map((entry) => {
  const classification = ACTOR_CLASSIFICATION[entry.role];
  return {
    id: actorId(entry.entity),
    name: entry.entity,
    entity: entry.entity,
    role: classification?.role ?? "evidence_context",
    roleLabel: entry.role,
    rootNode: classification?.rootNode ?? false,
    evidenceContext: classification?.evidenceContext ?? true,
    real: true,
    note: entry.note,
    sourceIds: [entry.sourceId],
    sources: sourcesFor([entry.sourceId]),
  };
});

export const CREDIT_EXPOSURES = PUBLIC_COMPANIES.map((company) => {
  const classification = EXPOSURE_CLASSIFICATION[company.evidenceKind];
  const normalizedCompanyId = companyId(company.id);
  return {
    id: `exposure:${normalizedCompanyId.slice("company:".length)}:vcs-902`,
    companyId: normalizedCompanyId,
    projectId: PROJECT_ID,
    knownCredits: company.knownCredits,
    quantityKnown: Number.isInteger(company.knownCredits) && company.knownCredits > 0,
    quantityExact: true,
    quantityBasis: classification?.quantityBasis ?? "documented_quantity",
    relationshipType: classification?.relationshipType ?? "other_verified_relationship",
    evidenceKind: company.evidenceKind,
    evidenceLabel: company.evidenceLabel,
    confidence: classification?.confidence ?? "qualified",
    mappingExact: classification?.mappingExact ?? false,
    registryMatch: company.registryMatch,
    sourceIds: [...company.relationshipSourceIds],
    sources: sourcesFor(company.relationshipSourceIds),
    articleSourceIds: [...company.articleIds],
    articles: company.articleIds.map((sourceId) => PUBLIC_SOURCES[sourceId]),
    aliases: [...company.aliases],
    beneficiaryStrings: [...company.beneficiaryStrings],
    retirementRows: company.retirementRows,
    vintageRange: company.vintageRange,
    retirementRange: company.retirementRange,
    notes: company.note,
  };
});

export const PROJECT_ACTOR_RELATIONSHIPS = REAL_PROJECT_ACTORS.map((actor) => ({
  id: `project-actor:vcs-902:${actor.id.slice("actor:".length)}`,
  actorId: actor.id,
  projectId: PROJECT_ID,
  role: actor.role,
  roleLabel: actor.roleLabel,
  rootNode: actor.rootNode,
  evidenceContext: actor.evidenceContext,
  note: actor.note,
  sourceIds: [...actor.sourceIds],
  sources: [...actor.sources],
}));

const nodes = [
  ...REAL_COMPANIES.map((company) => ({ ...company, nodeType: "company" })),
  ...REAL_PROJECTS.map((project) => ({ ...project, nodeType: "project" })),
  ...REAL_PROJECT_ACTORS.map((actor) => ({ ...actor, nodeType: "actor" })),
];

const edges = [
  ...CREDIT_EXPOSURES.map((exposure) => ({
    id: exposure.id,
    edgeType: "credit_exposure",
    sourceId: exposure.projectId,
    targetId: exposure.companyId,
    relationshipType: exposure.relationshipType,
    knownCredits: exposure.knownCredits,
    quantityKnown: exposure.quantityKnown,
    confidence: exposure.confidence,
    mappingExact: exposure.mappingExact,
  })),
  ...PROJECT_ACTOR_RELATIONSHIPS.map((relationship) => ({
    id: relationship.id,
    edgeType: "project_actor_relationship",
    sourceId: relationship.actorId,
    targetId: relationship.projectId,
    relationshipType: relationship.role,
    rootNode: relationship.rootNode,
    evidenceContext: relationship.evidenceContext,
  })),
];

export const CARBON_NETWORK = {
  schemaVersion: 1,
  mode: "real-only",
  companies: REAL_COMPANIES,
  projects: REAL_PROJECTS,
  actors: REAL_PROJECT_ACTORS,
  projectActors: REAL_PROJECT_ACTORS,
  exposures: CREDIT_EXPOSURES,
  projectActorRelationships: PROJECT_ACTOR_RELATIONSHIPS,
  rootActors: REAL_PROJECT_ACTORS.filter((actor) => actor.rootNode),
  contextActors: REAL_PROJECT_ACTORS.filter((actor) => actor.evidenceContext),
  nodes,
  edges,
  companiesById: Object.fromEntries(REAL_COMPANIES.map((company) => [company.id, company])),
  projectsById: Object.fromEntries(REAL_PROJECTS.map((project) => [project.id, project])),
  actorsById: Object.fromEntries(REAL_PROJECT_ACTORS.map((actor) => [actor.id, actor])),
  exposuresById: Object.fromEntries(CREDIT_EXPOSURES.map((exposure) => [exposure.id, exposure])),
};

export function validateCarbonNetwork() {
  const problems = [];
  const expectedCompanyLegacyIds = new Set(PUBLIC_COMPANIES.map((company) => company.id));
  const companyIds = new Set(REAL_COMPANIES.map((company) => company.id));
  const projectIds = new Set(REAL_PROJECTS.map((project) => project.id));
  const actorIds = new Set(REAL_PROJECT_ACTORS.map((actor) => actor.id));
  const normalizedId = /^(company|project|actor|exposure|project-actor):[a-z0-9][a-z0-9:-]*$/;

  const ensureUnique = (rows, label) => {
    const seen = new Set();
    for (const row of rows) {
      if (!normalizedId.test(row.id)) problems.push(`${label} ${row.id}: ID is not normalized`);
      if (seen.has(row.id)) problems.push(`${label} ${row.id}: duplicate ID`);
      seen.add(row.id);
    }
  };

  const validateSources = (record, label) => {
    if (!record.sourceIds?.length) problems.push(`${label}: relationship is unsourced`);
    if (record.sources?.length !== record.sourceIds?.length)
      problems.push(`${label}: source IDs and source objects do not reconcile`);
    for (const [index, sourceId] of (record.sourceIds ?? []).entries()) {
      const source = PUBLIC_SOURCES[sourceId];
      if (!source) problems.push(`${label}: unknown source ${sourceId}`);
      if (!source?.url) problems.push(`${label}: source ${sourceId} has no URL`);
      if (record.sources?.[index]?.id !== sourceId)
        problems.push(`${label}: source object does not match ${sourceId}`);
    }
  };

  ensureUnique(REAL_COMPANIES, "company");
  ensureUnique(REAL_PROJECTS, "project");
  ensureUnique(REAL_PROJECT_ACTORS, "actor");
  ensureUnique(CREDIT_EXPOSURES, "exposure");
  ensureUnique(PROJECT_ACTOR_RELATIONSHIPS, "project-actor relationship");

  if (REAL_COMPANIES.length !== 16) problems.push("real company count must be exactly 16");
  if (CREDIT_EXPOSURES.length !== 16) problems.push("credit exposure count must be exactly 16");
  if (REAL_PROJECTS.length !== 1) problems.push("only the sourced Kariba project may be exposed");

  for (const company of REAL_COMPANIES) {
    if (company.real !== true) problems.push(`${company.id}: company must be explicitly real`);
    if (!expectedCompanyLegacyIds.has(company.legacyId))
      problems.push(`${company.id}: company is not present in the sourced public dataset`);
    if (/illustrative/i.test(`${company.name} ${company.legacyId}`))
      problems.push(`${company.id}: illustrative company leaked into real graph`);
  }

  for (const project of REAL_PROJECTS) {
    if (project.real !== true) problems.push(`${project.id}: project must be explicitly real`);
    if (project.legacyId !== KARIBA_RECORD.projectId)
      problems.push(`${project.id}: illustrative or unknown project leaked into real graph`);
    if (project.creditsIssued !== KARIBA_DATA_QUALITY.issuedCredits)
      problems.push(`${project.id}: issued credits do not match Kariba source data`);
    if (project.excessCreditsProjectWide !== KARIBA_DATA_QUALITY.excessCredits)
      problems.push(`${project.id}: project-wide excess credits do not match Verra finding`);
    if (project.informativeBeneficiaryCoveragePct !== KARIBA_DATA_QUALITY.namedCoveragePct)
      problems.push(`${project.id}: beneficiary coverage does not match source data`);
    if (project.noCompanyExcessAllocation !== true)
      problems.push(`${project.id}: no-company-allocation limitation must remain explicit`);
    if (!project.projectAnalysis) problems.push(`${project.id}: PHANTOM analysis link is missing`);
    validateSources(project, project.id);
  }

  const allowedRelationshipTypes = new Set([
    "retirement_beneficiary",
    "direct_purchaser",
    "company_disclosure",
    "other_verified_relationship",
  ]);
  const duplicateEdges = new Set();
  let tracedCredits = 0;
  for (const exposure of CREDIT_EXPOSURES) {
    const pair = `${exposure.companyId}|${exposure.projectId}`;
    if (duplicateEdges.has(pair)) problems.push(`${exposure.id}: duplicate company-project edge`);
    duplicateEdges.add(pair);
    if (!companyIds.has(exposure.companyId)) problems.push(`${exposure.id}: unknown company`);
    if (!projectIds.has(exposure.projectId)) problems.push(`${exposure.id}: unknown project`);
    if (!allowedRelationshipTypes.has(exposure.relationshipType))
      problems.push(`${exposure.id}: unsupported relationship type`);
    if (!exposure.evidenceKind || !exposure.evidenceLabel)
      problems.push(`${exposure.id}: evidence classification is missing`);
    if (!exposure.confidence || typeof exposure.confidence !== "string")
      problems.push(`${exposure.id}: confidence must be a non-numeric string`);
    if (typeof exposure.mappingExact !== "boolean")
      problems.push(`${exposure.id}: mapping exactness must be explicit`);
    if (exposure.quantityKnown !== true || !Number.isInteger(exposure.knownCredits) || exposure.knownCredits <= 0)
      problems.push(`${exposure.id}: known quantity must be a positive integer`);
    if (!exposure.quantityBasis) problems.push(`${exposure.id}: quantity basis is missing`);
    if (!Array.isArray(exposure.aliases) || !Array.isArray(exposure.beneficiaryStrings))
      problems.push(`${exposure.id}: alias and beneficiary evidence must be arrays`);
    if (["excessCredits", "excessSharePct", "supportedCredits", "companyExcessCredits"]
      .some((field) => Object.hasOwn(exposure, field)))
      problems.push(`${exposure.id}: project-wide excess finding was allocated to a company`);
    validateSources(exposure, exposure.id);
    tracedCredits += exposure.knownCredits;
  }

  for (const actor of REAL_PROJECT_ACTORS) {
    if (actor.real !== true) problems.push(`${actor.id}: actor must be explicitly real`);
    if (actor.rootNode && actor.evidenceContext)
      problems.push(`${actor.id}: root actor cannot be evidence-only context`);
    if (!actor.rootNode && !actor.evidenceContext)
      problems.push(`${actor.id}: actor role is neither a root nor evidence context`);
    validateSources(actor, actor.id);
  }

  const allowedRootRoles = new Set([
    "project_developer",
    "local_operator",
    "carbon_asset_developer_marketer",
  ]);
  const rootActors = REAL_PROJECT_ACTORS.filter((actor) => actor.rootNode);
  if (rootActors.length !== 3) problems.push("Kariba must have exactly three sourced operational root actors");
  for (const actor of rootActors) {
    if (!allowedRootRoles.has(actor.role))
      problems.push(`${actor.id}: evidence-context actor cannot be a root node`);
  }

  for (const relationship of PROJECT_ACTOR_RELATIONSHIPS) {
    if (!actorIds.has(relationship.actorId)) problems.push(`${relationship.id}: unknown actor`);
    if (!projectIds.has(relationship.projectId)) problems.push(`${relationship.id}: unknown project`);
    const actor = CARBON_NETWORK.actorsById[relationship.actorId];
    if (actor && (actor.role !== relationship.role || actor.rootNode !== relationship.rootNode))
      problems.push(`${relationship.id}: actor edge does not reconcile with actor role`);
    validateSources(relationship, relationship.id);
  }

  const project = REAL_PROJECTS[0];
  if (project?.exposureCount !== CREDIT_EXPOSURES.length)
    problems.push("project exposure count does not reconcile");
  if (project?.tracedCredits !== tracedCredits)
    problems.push("project traced-credit total does not reconcile");
  if (tracedCredits !== 11204911)
    problems.push("real exposure total must reconcile to 11,204,911 credits");
  if (CARBON_NETWORK.nodes.length !==
      REAL_COMPANIES.length + REAL_PROJECTS.length + REAL_PROJECT_ACTORS.length)
    problems.push("graph node count does not reconcile");
  if (CARBON_NETWORK.edges.length !==
      CREDIT_EXPOSURES.length + PROJECT_ACTOR_RELATIONSHIPS.length)
    problems.push("graph edge count does not reconcile");

  return problems;
}
