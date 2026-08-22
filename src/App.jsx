import { useCallback, useEffect, useRef, useState } from "react";
import MapView, { yearsFor, imageryYearFor, UNIFORM_REFERENCE_SHAPES } from "./MapView.jsx";
import YearSlider from "./YearSlider.jsx";
import { ProjectPanel, ProjectList, Settings } from "./Panels.jsx";
import { REGIONS, DEFAULT_REGION_KEY, regionByKey } from "./regions.js";
import CompanyPage from "./CompanyPage.jsx";

/** Respect a viewer who has asked for less movement: no auto-play for them. */
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function App() {
  const [surface, setSurface] = useState(() =>
    typeof window !== "undefined" && window.location.hash.startsWith("#companies")
      ? "companies"
      : "explorer"
  );
  const [regionKey, setRegionKey] = useState(DEFAULT_REGION_KEY);
  const region = regionByKey(regionKey);
  const [selectedId, setSelectedId] = useState(null);
  const [year, setYear] = useState(region.REGION.window[1]);
  const [playing, setPlaying] = useState(false);
  const [matches, setMatches] = useState(null);
  const [settings, setSettings] = useState(false);
  const [layers, setLayers] = useState({ labels: true, controls: true });
  const [lossData, setLossData] = useState(null);
  const [parcelShapes, setParcelShapes] = useState(null);
  // The map hands back a way to photograph itself once it has loaded. The
  // report needs the map as the viewer has it framed, and only the map knows
  // how to read its own canvas back.
  const mapApi = useRef(null);
  const snapshotMap = useCallback(() => mapApi.current?.snapshot() ?? null, []);

  useEffect(() => {
    const syncSurface = () => setSurface(
      window.location.hash.startsWith("#companies") ? "companies" : "explorer"
    );
    window.addEventListener("hashchange", syncSurface);
    return () => window.removeEventListener("hashchange", syncSurface);
  }, []);

  // The forest outlines of the comparable parcels, baked once from PRODES.
  // Only used when MapView is drawing measured outlines rather than the one
  // shape language; if the file is absent the map draws the synthetic outline,
  // which is inscribed in the box the measurement is taken over anyway. Only
  // baked for the Amazon pool today.
  useEffect(() => {
    if (UNIFORM_REFERENCE_SHAPES || regionKey !== "amazon") return;
    let live = true;
    fetch(`${import.meta.env.BASE_URL}mapdata/parcels.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => live && setParcelShapes(doc?.parcels ?? null))
      .catch(() => {});
    return () => { live = false; };
  }, [regionKey]);

  // Clearing polygons are large and only ever needed for the open project, so
  // they load on selection rather than up front. Not every region has a baked
  // overlay (Zimbabwe's clearing is shown as a live tile layer instead — see
  // MapView.jsx) — a missing file here just means no polygon overlay, handled
  // gracefully rather than as an error.
  useEffect(() => {
    if (!selectedId) { setLossData(null); return; }
    let live = true;
    setLossData(null);
    fetch(`${import.meta.env.BASE_URL}mapdata/loss-${selectedId}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => live && setLossData(doc))
      .catch(() => {});
    return () => { live = false; };
  }, [selectedId]);

  // Opening a project rewinds to the start of the window: the story is the
  // sequence, and dropping a viewer at the end of it gives away the ending.
  useEffect(() => {
    setPlaying(false);
    if (selectedId) setYear(region.REGION.window[0]);
    else setYear(region.REGION.window[1]);
  }, [selectedId, regionKey]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (settings) setSettings(false);
      else setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings]);

  const togglePlay = useCallback(() => {
    if (prefersReducedMotion()) return;
    setPlaying((p) => !p);
  }, []);

  const changeYear = useCallback((next) => {
    setYear((prev) => (typeof next === "function" ? next(prev) : next));
  }, []);

  // Switching regions swaps the whole dataset — map, project list, everything
  // mid-panel — rather than merging a second forest onto the same map. Reset
  // synchronously in the same handler that changes regionKey rather than via a
  // separate effect, so MapView never mounts fresh with a stale selectedId
  // from the region that just left.
  const switchRegion = useCallback((key) => {
    if (key === regionKey) return;
    setRegionKey(key);
    setSelectedId(null);
    setMatches(null);
    setLossData(null);
    setPlaying(false);
    setYear(regionByKey(key).REGION.window[1]);
  }, [regionKey]);

  const imageryYear = imageryYearFor(year);
  const YEARS = yearsFor(region.REGION.window);

  const navigate = (next) => {
    const hash = next === "companies" ? "#companies" : "#explorer";
    if (window.location.hash === hash) setSurface(next);
    else window.location.hash = hash;
    if (next === "companies") {
      setSettings(false);
      setPlaying(false);
    }
  };

  const openProjectFromCompany = (projectId, nextRegionKey) => {
    if (nextRegionKey !== regionKey) switchRegion(nextRegionKey);
    setSelectedId(projectId);
    navigate("explorer");
  };

  if (surface === "companies") {
    return (
      <CompanyPage
        onBack={() => navigate("explorer")}
        onOpenProject={openProjectFromCompany}
      />
    );
  }

  return (
    <div className="app">
      <MapView
        key={regionKey}
        year={year}
        selectedId={selectedId}
        onSelect={setSelectedId}
        controls={matches}
        showControls={layers.controls}
        showLabels={layers.labels}
        parcelShapes={parcelShapes}
        lossData={lossData}
        onReady={(api) => { mapApi.current = api; }}
        REGION={region.REGION}
        PROJECTS={region.PROJECTS}
        yearWindow={region.REGION.window}
        liveClearingTiles={regionKey === "kariba"}
      />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PHANTOM</span>
          <span className="brand-sub">independent baseline verification</span>
        </div>
        <div className="spacer" />
        <button className="explorer-nav-btn" onClick={() => navigate("companies")}>
          Kariba case
        </button>
        <div className="region-switch" role="group" aria-label="Showcase region">
          {REGIONS.map((r) => (
            <button
              key={r.key}
              className={`region-btn${r.key === regionKey ? " is-active" : ""}`}
              aria-pressed={r.key === regionKey}
              onClick={() => switchRegion(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          className="icon-btn"
          aria-expanded={settings}
          aria-label="Settings and data sources"
          onClick={() => setSettings((s) => !s)}
        >
          ⚙
        </button>
      </header>

      <Settings open={settings} layers={layers} setLayers={setLayers} onClose={() => setSettings(false)} region={region} />

      {selectedId ? (
        <ProjectPanel
          id={selectedId}
          year={year}
          onClose={() => setSelectedId(null)}
          onVerified={setMatches}
          snapshotMap={snapshotMap}
          region={region}
        />
      ) : (
        <ProjectList onSelect={setSelectedId} region={region} />
      )}

      {selectedId && (
        <>
          <YearSlider
            year={year}
            years={YEARS}
            onChange={changeYear}
            playing={playing}
            onPlayToggle={togglePlay}
            imageryNote={`Sentinel-2 ${imageryYear}`}
          />
          <div className="legend panel">
            <span><i style={{ background: "#F0B429" }} />project boundary</span>
            <span><i style={{ background: "#5B8A9A" }} />comparable parcels</span>
            <span><i style={{ background: "#FF4D3D" }} />forest cleared by {year}</span>
          </div>
        </>
      )}

      <footer className="footnote">
        {regionKey === "kariba" ? (
          <>Real project, sourced case study · real forest data ·{" "}
            <a href="https://globalnaturewatch.org" target="_blank" rel="noreferrer">Global Nature Watch</a>,{" "}
            <a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless by EOX</a>
          </>
        ) : (
          <>Illustrative project records · real forest data ·{" "}
            <a href="https://terrabrasilis.dpi.inpe.br" target="_blank" rel="noreferrer">INPE PRODES</a>,{" "}
            <a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless by EOX</a>
          </>
        )}
      </footer>
    </div>
  );
}
