import { useCallback, useEffect, useRef, useState } from "react";
import MapView, { YEARS, imageryYearFor, UNIFORM_REFERENCE_SHAPES } from "./MapView.jsx";
import YearSlider from "./YearSlider.jsx";
import { ProjectPanel, ProjectList, Settings } from "./Panels.jsx";
import { WINDOW } from "./baseline.js";

/** Respect a viewer who has asked for less movement: no auto-play for them. */
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function App() {
  const [selectedId, setSelectedId] = useState(null);
  const [year, setYear] = useState(WINDOW[1]);
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

  // The forest outlines of the comparable parcels, baked once from PRODES.
  // Only used when MapView is drawing measured outlines rather than the one
  // shape language; if the file is absent the map draws the synthetic outline,
  // which is inscribed in the box the measurement is taken over anyway.
  useEffect(() => {
    // Only fetched when the map is actually going to draw them: the file is
    // several megabytes, and by default every zone is drawn synthetically.
    if (UNIFORM_REFERENCE_SHAPES) return;
    let live = true;
    fetch(`${import.meta.env.BASE_URL}mapdata/parcels.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => live && setParcelShapes(doc?.parcels ?? null))
      .catch(() => {});
    return () => { live = false; };
  }, []);

  // Clearing polygons are large and only ever needed for the open project, so
  // they load on selection rather than up front.
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
    if (selectedId) setYear(WINDOW[0]);
    else setYear(WINDOW[1]);
  }, [selectedId]);

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

  const imageryYear = imageryYearFor(year);

  return (
    <div className="app">
      <MapView
        year={year}
        selectedId={selectedId}
        onSelect={setSelectedId}
        controls={matches}
        showControls={layers.controls}
        showLabels={layers.labels}
        parcelShapes={parcelShapes}
        lossData={lossData}
        onReady={(api) => { mapApi.current = api; }}
      />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PHANTOM</span>
          <span className="brand-sub">independent baseline verification</span>
        </div>
        <div className="spacer" />
        <button
          className="icon-btn"
          aria-expanded={settings}
          aria-label="Settings and data sources"
          onClick={() => setSettings((s) => !s)}
        >
          ⚙
        </button>
      </header>

      <Settings open={settings} layers={layers} setLayers={setLayers} onClose={() => setSettings(false)} />

      {selectedId ? (
        <ProjectPanel
          id={selectedId}
          year={year}
          onClose={() => setSelectedId(null)}
          onVerified={setMatches}
          snapshotMap={snapshotMap}
        />
      ) : (
        <ProjectList onSelect={setSelectedId} />
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
        Illustrative project records · real forest data ·{" "}
        <a href="https://terrabrasilis.dpi.inpe.br" target="_blank" rel="noreferrer">INPE PRODES</a>,{" "}
        <a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless by EOX</a>
      </footer>
    </div>
  );
}
