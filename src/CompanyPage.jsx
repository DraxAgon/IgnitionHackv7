import { useEffect, useMemo, useRef, useState } from "react";
import {
  CARBON_NETWORK,
  CREDIT_EXPOSURES,
  REAL_COMPANIES,
  REAL_PROJECTS,
} from "./carbonNetwork.js";

const number = new Intl.NumberFormat("en-US");
const formatCredits = (value) => `${number.format(value)} Kariba credits`;
const trimNumber = (value) => value.replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1");
const compactCredits = (value) => {
  if (value >= 10_000_000) return `${trimNumber((Math.round(value / 100_000) / 10).toFixed(1))}M`;
  if (value >= 1_000_000) return `${trimNumber((Math.round(value / 10_000) / 100).toFixed(2))}M`;
  if (value >= 1_000) return `${trimNumber((Math.round(value / 100) / 10).toFixed(1))}K`;
  return number.format(value);
};

const LEAF_SLOTS = [
  [112, 330], [175, 226], [270, 135], [380, 85],
  [490, 135], [555, 74], [660, 80], [760, 116],
  [865, 96], [974, 170], [1080, 270], [990, 346],
  [850, 298], [735, 225], [470, 250], [310, 315],
];
const BALANCED_SLOT_ORDER = [15, 12, 14, 13, 4, 7, 3, 8, 2, 9, 1, 10, 0, 11, 5, 6];

const ROOT_ROLES = {
  project_developer: "project developer",
  local_operator: "local operator",
  carbon_asset_developer_marketer: "sold and marketed the credits",
};

const ROOT_EXPLANATIONS = {
  project_developer: "Carbon Green Investments owned and developed the Kariba project.",
  local_operator: "Carbon Green Africa ran the project with local councils and communities.",
  carbon_asset_developer_marketer: "South Pole helped certify, market, and sell Kariba credits.",
};

const splitLabel = (name) => {
  if (name.length <= 17) return [name];
  const words = name.split(" ");
  const midpoint = Math.ceil(words.length / 2);
  return [words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" ")].filter(Boolean);
};

const evidenceSentence = (company, exposure) => {
  if (exposure.evidenceKind === "company-disclosure-registry-inference")
    return `${company.name} says it used ${number.format(exposure.knownCredits)} Kariba credits.`;
  if (exposure.evidenceKind === "company-disclosure-no-registry-match")
    return `${company.name} says it bought ${number.format(exposure.knownCredits)} Kariba credits from South Pole USA.`;
  if (exposure.evidenceKind === "registry-parent-group")
    return `Registry records name Nespresso and other Nestlé brands on ${number.format(exposure.knownCredits)} Kariba credits.`;
  if (exposure.evidenceKind === "registry-beneficiary-and-detail")
    return `The registry names ${company.name} in the buyer field or in the notes attached to the credits.`;
  if (exposure.evidenceKind === "registry-alias-group")
    return `Kariba’s registry records use a few versions of ${company.name}’s name. Together they add up to ${number.format(exposure.knownCredits)} credits.`;
  return `The public registry lists ${company.name} next to these credits.`;
};

const evidenceLabel = (exposure) => exposure.evidenceKind.startsWith("company-disclosure")
  ? "Company disclosure"
  : "Registry record";

function SourceLink({ source, label = "Open source" }) {
  if (!source?.url) return null;
  return (
    <a className="simple-source-link" href={source.url} target="_blank" rel="noreferrer">
      <span>{label}</span>
      <small>{source.publisher}</small>
      <i aria-hidden="true">↗</i>
    </a>
  );
}

function CompanyDetail({ company, exposure }) {
  const project = REAL_PROJECTS[0];
  const audit = project.projectAnalysis?.audit;
  const primarySource = exposure.sources[0];
  return (
    <article className="simple-detail" aria-labelledby="company-detail-title">
      <header>
        <span>Company</span>
        <h2 id="company-detail-title">{company.name}</h2>
      </header>

      <p className="simple-answer">
        We found <strong>{number.format(exposure.knownCredits)}</strong> Kariba credits linked to {company.name}.
      </p>

      <section>
        <h3>How we know</h3>
        <p>{evidenceSentence(company, exposure)}</p>
        <SourceLink source={primarySource} label={evidenceLabel(exposure)} />
      </section>

      {audit && (
        <section>
          <h3>Why Kariba matters</h3>
          <p>
            Kariba said {(audit.claimed * 100).toFixed(0)}% of the forest would be lost without the project.
            Similar forests lost about {(audit.independent * 100).toFixed(0)}%.
          </p>
          <p>Verra later said Kariba issued too many credits. That finding was about the whole project, not this company.</p>
        </section>
      )}
    </article>
  );
}

function ProjectDetail({ project, onOpenProject }) {
  const audit = project.projectAnalysis?.audit;
  const registrySource = project.sources.find((source) => source.id === "verraRegistry902") ?? project.sources[0];
  const reviewSource = project.sources.find((source) => source.id === "verraReview2025");
  return (
    <article className="simple-detail" aria-labelledby="project-detail-title">
      <header>
        <span>Forest project</span>
        <h2 id="project-detail-title">Kariba REDD+</h2>
        <small>Zimbabwe · Verra VCS 902</small>
      </header>

      <p className="simple-answer">Kariba sold carbon credits for protecting forest in Zimbabwe.</p>

      {audit && (
        <section>
          <h3>What PHANTOM checked</h3>
          <p>
            Kariba said {(audit.claimed * 100).toFixed(0)}% of the forest would be lost without the project.
            Similar forests lost about {(audit.independent * 100).toFixed(0)}%.
          </p>
        </section>
      )}

      <section>
        <h3>What Verra found later</h3>
        <p>
          Verra called {compactCredits(project.excessCreditsProjectWide)} of Kariba’s {compactCredits(project.creditsIssued)} credits excess, more than the project should have issued.
          That result is for Kariba as a whole, not one company.
        </p>
      </section>

      <div className="simple-source-row">
        <SourceLink source={registrySource} label="Project record" />
        <SourceLink source={reviewSource} label="Verra review" />
      </div>

      <button className="simple-map-button" onClick={() => onOpenProject(project.legacyId, "kariba")}>
        See Kariba on the map <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

function ActorDetail({ actor }) {
  return (
    <article className="simple-detail" aria-labelledby="actor-detail-title">
      <header>
        <span>Kariba organization</span>
        <h2 id="actor-detail-title">{actor.name}</h2>
        <small>{ROOT_ROLES[actor.role]}</small>
      </header>

      <p className="simple-answer">{ROOT_EXPLANATIONS[actor.role]}</p>
      <SourceLink source={actor.sources[0]} />
    </article>
  );
}

function SelectedDetail({ selection, onOpenProject }) {
  const project = REAL_PROJECTS[0];
  if (selection.kind === "company") {
    const company = CARBON_NETWORK.companiesById[selection.id];
    const exposure = CREDIT_EXPOSURES.find((item) => item.companyId === selection.id);
    return <CompanyDetail company={company} exposure={exposure} />;
  }
  if (selection.kind === "actor")
    return <ActorDetail actor={CARBON_NETWORK.actorsById[selection.id]} />;
  return <ProjectDetail project={project} onOpenProject={onOpenProject} />;
}

function SimpleSearch({ onSelect }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const entries = useMemo(() => [
    ...REAL_COMPANIES.map((company) => ({ kind: "company", id: company.id, name: company.name })),
    { kind: "project", id: REAL_PROJECTS[0].id, name: "Kariba REDD+" },
    ...CARBON_NETWORK.rootActors.map((actor) => ({ kind: "actor", id: actor.id, name: actor.name })),
  ], []);
  const results = query.trim()
    ? entries.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase())).slice(0, 7)
    : [];

  const choose = (entry) => {
    setQuery(entry.name);
    setOpen(false);
    onSelect(entry.kind, entry.id);
  };

  return (
    <div className="companies-search">
      <label htmlFor="company-search">Find a company</label>
      <div>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
        <input
          id="company-search"
          value={query}
          placeholder="Search the tree"
          autoComplete="off"
          aria-expanded={open && results.length > 0}
          aria-controls="company-search-results"
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) { event.preventDefault(); choose(results[0]); }
            if (event.key === "Escape") { setOpen(false); event.currentTarget.blur(); }
          }}
        />
      </div>
      {open && results.length > 0 && (
        <div className="companies-search-results" id="company-search-results" role="listbox">
          {results.map((entry) => (
            <button key={`${entry.kind}:${entry.id}`} role="option" aria-selected="false" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(entry)}>
              {entry.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OrganicTree({ selection, onSelect }) {
  const project = REAL_PROJECTS[0];
  const roots = CARBON_NETWORK.rootActors;
  const shellRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const maxCredits = Math.max(...CREDIT_EXPOSURES.map((exposure) => exposure.knownCredits));
  const rows = useMemo(() => [...CREDIT_EXPOSURES]
    .sort((a, b) => b.knownCredits - a.knownCredits)
    .map((exposure, index) => {
      const [x, y] = LEAF_SLOTS[BALANCED_SLOT_ORDER[index]];
      const company = CARBON_NETWORK.companiesById[exposure.companyId];
      const side = x < 600 ? -1 : 1;
      const reach = Math.abs(x - 600);
      const startX = 600 + side * (14 + (index % 3) * 4);
      const startY = 500 + Math.min(92, reach * .16);
      const forkX = 600 + side * (90 + reach * .42);
      const forkY = y + 125;
      const branch = `M ${startX} ${startY} C ${startX + side * 30} ${startY - 70}, ${forkX - side * 65} ${forkY + 35}, ${forkX} ${forkY} C ${forkX + side * 70} ${forkY - 72}, ${x - side * 55} ${y + 34}, ${x} ${y}`;
      return { exposure, company, x, y, side, branch, index };
    }), []);

  const showTooltip = (event, row) => {
    const bounds = shellRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const rawX = event.clientX - bounds.left;
    const rawY = event.clientY - bounds.top;
    setTooltip({
      ...row,
      left: Math.max(120, Math.min(bounds.width - 120, rawX)),
      top: Math.max(16, Math.min(bounds.height - 120, rawY)),
    });
  };

  const showFocusTooltip = (event, row) => {
    const node = event.currentTarget.getBoundingClientRect();
    showTooltip({ clientX: node.left + node.width / 2, clientY: node.bottom }, row);
  };

  const activate = (event, kind, id) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(kind, id);
    }
  };

  return (
    <div className="organic-tree" ref={shellRef}>
      <svg viewBox="0 0 1200 855" role="img" aria-labelledby="organic-tree-title organic-tree-description">
        <title id="organic-tree-title">Companies connected to Kariba REDD+</title>
        <desc id="organic-tree-description">A tree with Kariba as its trunk, sixteen companies as leaves, and three project organizations as roots.</desc>

        <line className="tree-ground" x1="70" y1="675" x2="1130" y2="675" aria-hidden="true"/>

        <g className="tree-secondary-roots" aria-hidden="true">
          <path d="M 566 658 C 470 696, 385 701, 290 724"/>
          <path d="M 578 669 C 500 733, 460 756, 390 777"/>
          <path d="M 622 669 C 700 733, 760 758, 830 778"/>
          <path d="M 635 658 C 735 697, 830 704, 930 725"/>
        </g>

        <g className="tree-company-branches" aria-hidden="true">
          {rows.map((row) => {
            const selected = selection.kind === "company" && selection.id === row.company.id;
            const dimmed = selection.kind === "company" && !selected;
            const width = 1.4 + 7.6 * Math.sqrt(row.exposure.knownCredits / maxCredits);
            return <path key={row.exposure.id} className={`${selected ? "is-selected" : ""} ${dimmed ? "is-dimmed" : ""}`} d={row.branch} style={{ strokeWidth: width }} />;
          })}
        </g>

        <path
          className="tree-trunk"
          d="M 555 676 C 570 615 567 560 578 505 C 585 468 572 446 552 422 C 579 433 593 452 602 480 C 611 450 629 429 654 410 C 633 451 628 479 640 520 C 650 569 641 621 653 676 Z"
          aria-hidden="true"
        />
        <g className="tree-bark" aria-hidden="true">
          <path d="M 584 641 C 600 595, 594 544, 604 496"/>
          <path d="M 624 650 C 613 600, 624 556, 618 516"/>
        </g>

        <g className="tree-root-links">
          {roots.map((actor, index) => {
            const endpoints = [[205, 768], [600, 790], [995, 768]];
            const [x, y] = endpoints[index];
            const path = index === 0
              ? `M 575 660 C 500 706, 390 735, ${x} ${y}`
              : index === 1
                ? `M 600 665 C 594 714, 603 745, ${x} ${y}`
                : `M 625 660 C 700 706, 810 735, ${x} ${y}`;
            const selected = selection.kind === "actor" && selection.id === actor.id;
            const dimmed = selection.kind === "actor" && !selected;
            return (
              <g
                key={actor.id}
                className={`${selected ? "is-selected" : ""} ${dimmed ? "is-dimmed" : ""}`}
                role="button" tabIndex="0"
                aria-label={`${actor.name}, ${ROOT_ROLES[actor.role]}`}
                onClick={() => onSelect("actor", actor.id)}
                onKeyDown={(event) => activate(event, "actor", actor.id)}
              >
                <path className="tree-root-hit" d={path}/>
                <path className="tree-root" d={path}/>
                <circle cx={x} cy={y} r="4"/>
                <text x={x} y={y + 20}>
                  <tspan x={x}>{actor.name.replace(" (Guernsey)", "")}</tspan>
                  <tspan className="tree-root-role" x={x} dy="15">{ROOT_ROLES[actor.role]}</tspan>
                </text>
              </g>
            );
          })}
        </g>

        <g
          className={`tree-project-plaque ${selection.kind === "project" ? "is-selected" : ""}`}
          role="button" tabIndex="0"
          aria-label="View Kariba REDD+ project"
          onClick={() => onSelect("project", project.id)}
          onKeyDown={(event) => activate(event, "project", project.id)}
        >
          <rect x="521" y="544" width="158" height="58" rx="7"/>
          <text x="600" y="567"><tspan>Kariba REDD+</tspan><tspan x="600" dy="18">Zimbabwe · VCS 902</tspan></text>
        </g>

        <g className="tree-foliage" aria-hidden="true">
          {rows.flatMap((row) => [
            { key: `${row.exposure.id}-a`, x: row.x + row.side * 24, y: row.y + 8, rotate: row.side * 32, scale: .8 },
            { key: `${row.exposure.id}-b`, x: row.x - row.side * 18, y: row.y - 7, rotate: -row.side * 48, scale: .65 },
          ]).map((leaf) => (
            <path key={leaf.key} transform={`translate(${leaf.x} ${leaf.y}) rotate(${leaf.rotate}) scale(${leaf.scale})`} d="M 0 0 C 9 -13 27 -12 34 1 C 25 14 8 15 0 0 Z"/>
          ))}
        </g>

        <g className="tree-company-leaves">
          {rows.map((row) => {
            const selected = selection.kind === "company" && selection.id === row.company.id;
            const dimmed = selection.kind === "company" && !selected;
            const lines = splitLabel(row.company.name);
            const rotation = row.side < 0 ? 155 : -25;
            return (
              <g
                key={row.company.id}
                className={`${selected ? "is-selected" : ""} ${dimmed ? "is-dimmed" : ""}`}
                role="button" tabIndex="0"
                aria-label={`${row.company.name}, ${formatCredits(row.exposure.knownCredits)}`}
                onClick={() => onSelect("company", row.company.id)}
                onKeyDown={(event) => activate(event, "company", row.company.id)}
                onMouseMove={(event) => showTooltip(event, row)}
                onMouseLeave={() => setTooltip(null)}
                onFocus={(event) => showFocusTooltip(event, row)}
                onBlur={() => setTooltip(null)}
              >
                <circle className="tree-leaf-hit" cx={row.x} cy={row.y} r="34"/>
                <path className="tree-leaf" transform={`translate(${row.x} ${row.y}) rotate(${rotation})`} d="M 0 0 C 10 -15 30 -13 38 1 C 28 16 9 17 0 0 Z"/>
                <text x={row.x} y={row.y - 21}>
                  {lines.map((line, index) => <tspan key={line} x={row.x} dy={index ? 14 : 0}>{line}</tspan>)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <p className="tree-volume-note">A thicker branch means we found more Kariba credits.</p>

      {tooltip && (
        <div className="tree-tooltip" role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
          <strong>{tooltip.company.name}</strong>
          <span>{formatCredits(tooltip.exposure.knownCredits)}</span>
          <small>{evidenceLabel(tooltip.exposure)} · click to read</small>
        </div>
      )}

      <div className="mobile-company-tree">
        <div className="mobile-tree-mark" aria-hidden="true">
          <svg viewBox="0 0 120 92"><path d="M56 83C59 65 57 52 60 39C64 27 55 20 45 14C58 17 63 24 66 32C72 22 80 16 91 12C80 24 76 32 78 42C81 56 77 69 81 83Z"/><path d="M61 81C43 83 30 85 14 89M76 81C90 83 100 85 112 89"/></svg>
        </div>
        <p>Tap a company to see its Kariba credits.</p>
        <div>
          {[...rows].sort((a, b) => b.exposure.knownCredits - a.exposure.knownCredits).map((row) => (
            <button key={row.company.id} className={selection.kind === "company" && selection.id === row.company.id ? "is-selected" : ""} onClick={() => onSelect("company", row.company.id, true)}>
              <i aria-hidden="true"/>
              <span>{row.company.name}</span>
              <strong>{compactCredits(row.exposure.knownCredits)}</strong>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function CompanyPage({ onBack, onOpenProject }) {
  const project = REAL_PROJECTS[0];
  const [selection, setSelection] = useState({ kind: "project", id: project.id });

  useEffect(() => {
    const previous = document.title;
    document.title = "Kariba case · PHANTOM";
    return () => { document.title = previous; };
  }, []);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === "Escape") setSelection({ kind: "project", id: project.id });
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [project.id]);

  const select = (kind, id, scroll = false) => {
    setSelection({ kind, id });
    if (scroll) window.requestAnimationFrame(() => document.getElementById("company-detail")?.scrollIntoView({ block: "start" }));
  };

  const selectedName = selection.kind === "company"
    ? CARBON_NETWORK.companiesById[selection.id]?.name
    : selection.kind === "actor"
      ? CARBON_NETWORK.actorsById[selection.id]?.name
      : "Kariba REDD+";

  return (
    <div className="market-page companies-page">
      <header className="market-topbar companies-topbar">
        <button className="market-brand brand" onClick={onBack} aria-label="Return to Forest Explorer">
          <span className="brand-mark">PHANTOM</span><span className="brand-sub">forest carbon intelligence</span>
        </button>
        <nav className="market-nav" aria-label="Primary navigation">
          <button onClick={onBack}>Forest Explorer</button>
          <button className="is-active" aria-current="page">Kariba case</button>
        </nav>
      </header>

      <main className="companies-main">
        <section className="companies-hero">
          <div>
            <h1>The Kariba case.</h1>
            <p>
              Kariba is a forest project in Zimbabwe, and the one project in this build traced all the
              way from the parties that sold the credits to the companies that retired them. Public
              records link 16 companies to 11.2 million Kariba credits.
            </p>
          </div>
          <SimpleSearch onSelect={select} />
        </section>

        <section className="tree-section" aria-labelledby="tree-section-title">
          <header>
            <h2 id="tree-section-title">Who sold Kariba credits, and who bought them</h2>
            <p>Tap a leaf to see the company’s link to Kariba.</p>
          </header>

          <div className="tree-stage">
            <OrganicTree selection={selection} onSelect={select} />
            <aside id="company-detail">
              <div className="sr-only" aria-live="polite">Showing {selectedName}</div>
              <SelectedDetail selection={selection} onOpenProject={onOpenProject} />
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
}
