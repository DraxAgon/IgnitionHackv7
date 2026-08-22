import { useEffect, useState } from "react";
import MapView from "./MapView.jsx";
import { Controls, ProjectList, Detail, Buyers, Legend } from "./Panels.jsx";
import { buildChangeMosaic } from "./changeCanvas.js";
import { projectById, TOTALS, MEASUREMENT_META } from "./verdicts.js";
import { REGION } from "./data.js";
import { fmtCompact, fmtInt, useCountUp } from "./ui.jsx";

const DEFAULT_LAYERS = { loss: true, canopy: false, projects: true, rings: true, pins: true, change: true };

export default function App() {
  const [mode, setMode] = useState("index");
  const [selectedId, setSelectedId] = useState(null);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [year, setYear] = useState(MEASUREMENT_META.endYear);
  const [filters, setFilters] = useState({ grades: [], q: "" });
  const [sort, setSort] = useState("unsupported");
  const [mosaic, setMosaic] = useState(null);
  const [status, setStatus] = useState({ basemap: null, ready: false });
  const [loadingScene, setLoadingScene] = useState(false);

  // Build the decoded forest-change overlay for whichever project is selected.
  useEffect(() => {
    let dead = false;
    let built = null;
    setMosaic(null);
    if (!selectedId) return;
    setLoadingScene(true);
    setYear(MEASUREMENT_META.endYear);
    buildChangeMosaic(projectById[selectedId], { zoom: MEASUREMENT_META.zoom })
      .then((m) => {
        built = m;
        if (dead) return m.destroy();
        setMosaic(m);
      })
      .catch(() => {})
      .finally(() => !dead && setLoadingScene(false));
    return () => {
      dead = true;
      built?.destroy();
    };
  }, [selectedId]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && setSelectedId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const select = (id) => {
    setSelectedId(id);
    if (id) setMode("index");
  };

  const dollars = useCountUp(TOTALS.dollarsUnsupported, 1400);

  return (
    <div className="app">
      <MapView
        layers={layers}
        selectedId={selectedId}
        onSelect={select}
        mosaic={mosaic}
        year={year}
        onStatus={setStatus}
      />

      <div className="overlay">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">PHANTOM</span>
            <span className="brand-region">{REGION.name} · {REGION.sub}</span>
          </div>

          <div className="seg" role="tablist" aria-label="View">
            {[["index", "Index"], ["buyers", "Buyers"]].map(([k, label]) => (
              <button
                key={k} role="tab" className="seg-btn" aria-selected={mode === k}
                onClick={() => { setMode(k); if (k === "buyers") setSelectedId(null); }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="chip" title="Total credit value not supported by satellite evidence">
            <span className="num" style={{ color: "var(--danger)", fontSize: 14, fontWeight: 700 }}>
              {fmtCompact(dollars)}
            </span>
            unsupported across {TOTALS.projects} projects
          </div>

          <div className="spacer" />

          <div className="chip" title={MEASUREMENT_META.citation}>
            <i className={`dot ${status.basemap === false ? "dot-warn" : status.ready ? "dot-live" : "dot-off"}`} />
            {status.basemap === false ? "offline — basemap unavailable" : `real satellite data · ${fmtInt(TOTALS.pixels)} px measured`}
          </div>
        </header>

        <Controls
          layers={layers} setLayers={setLayers}
          year={year} setYear={setYear}
          filters={filters} setFilters={setFilters}
          selectedId={selectedId}
        />

        {mode === "buyers" ? (
          <Buyers onSelect={select} />
        ) : selectedId ? (
          <Detail id={selectedId} onBack={() => setSelectedId(null)} year={year} />
        ) : (
          <ProjectList onSelect={select} filters={filters} setFilters={setFilters} sort={sort} setSort={setSort} />
        )}

        <footer className="bottombar">
          <Legend selectedId={selectedId} />
          <div className="attrib">
            Forest data: UMD/Hansen GFC v1.11 via <a href="https://www.globalforestwatch.org" target="_blank" rel="noreferrer">Global Forest Watch</a>
            {" · "}Basemap © <a href="https://carto.com/" target="_blank" rel="noreferrer">CARTO</a>, OpenStreetMap
            <br />
            Projects, registry IDs and companies are <strong>fictional</strong>. Forest measurements are real.
          </div>
        </footer>
      </div>

      {loadingScene && (
        <div className="scene-loading">
          <i className="spin" /> decoding satellite tiles
        </div>
      )}
    </div>
  );
}
