// MapView.jsx — one map, five things on it.
//
// The map has one job: show that forest inside the project boundary was cleared
// on the same schedule as the land around it. Everything that does not serve
// that comparison is furniture, and furniture is what makes a map unreadable.
// So when a project is open there are exactly five kinds of mark on screen —
// the project boundary, its comparable parcels, the clearing, the scale, and
// the year — and the other projects' pins are removed entirely rather than
// dimmed.
//
// Three colours carry meaning and nothing else does:
//   amber   the selected project, the only gold on screen
//   slate   comparable parcels, quiet enough never to compete
//   red     forest loss, the only saturated red in the application
//
// The clearing polygons come from INPE PRODES via `scripts/bake-map-data.mjs`
// and are tagged with the year they were detected, so stepping the slider
// reveals what actually happened that year rather than cross-fading two similar
// satellite mosaics.

import { useCallback, useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, Marker, NavigationControl, ScaleControl, Popup, setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { projectFeature, boundaryLonLat, parcelRing, isRectangularOutline } from "./geometry.js";
import { purchaseRows, purchaseSummary } from "./actors.js";
import { lossFraction } from "./baseline.js";

setWorkerUrl(maplibreWorkerUrl);

export const COLORS = {
  project: "#F0B429",
  control: "#5B8A9A",
  loss: "#FF4D3D",
};

// Sentinel-2 cloudless annual mosaics, 10 m, free and keyless. EOX publishes
// 2018 onward; the analysis window opens in 2016, so earlier years borrow the
// nearest mosaic and the slider says so rather than implying imagery exists
// that does not.
export const IMAGERY_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

/** Every year in a [from, to] comparison window, inclusive. */
export const yearsFor = ([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const imageryYearFor = (year) =>
  IMAGERY_YEARS.reduce((best, y) => (Math.abs(y - year) < Math.abs(best - year) ? y : best), IMAGERY_YEARS[0]);

const s2 = (year) =>
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${imageryYearFor(year)}_3857/default/g/{z}/{y}/{x}.jpg`;
const LABELS = "https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png";
const PLACES = "https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png";

/**
 * Every zone on the map is drawn in one shape language: the same harmonic
 * outline, so a project and the parcels it is compared against differ by
 * COLOUR and not by kind. A box among blobs reads as a different sort of
 * object, which is a distinction this map is not trying to draw.
 *
 * Turn this off and each reference parcel is drawn with the PRODES forest
 * outline the bake produced for it instead - measured ground rather than a
 * synthetic shape. It is a real trade and it is not free either way: those
 * outlines are the parcel box less water, mapped non-forest and pre-window
 * clearing, so a parcel with little to subtract comes back as very nearly the
 * box, and the map goes back to reading as blobs beside rectangles.
 *
 * What does not change is where the numbers come from. Loss, similarity and
 * every figure in a parcel popup are summed over the parcel one-degree box in
 * both modes, and the popup says which of the two outlines is on screen so a
 * drawn shape never implies a precision the figures behind it do not have.
 * The synthetic outline is inscribed in that box: it can understate the ground
 * a figure covers, never overstate it.
 */
export const UNIFORM_REFERENCE_SHAPES = true;

const fc = (features) => ({ type: "FeatureCollection", features });
const EMPTY = fc([]);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Padding that keeps map content out from under the info panel.
 *
 * Measured off the panel rather than typed in: it is a 400px right-hand column
 * on a desktop layout and a bottom sheet under 900px, and a hard-coded number
 * goes stale the first time either changes — quietly, as markers sliding under
 * an opaque surface, which is the commonest way a map like this fails.
 *
 * `pins` are the measured marker boxes, and they are the second half of the same
 * problem. A pin is anchored at its centre and carries its name to both sides of
 * that point, so padding that clears the panel to the dot still slides the label
 * under it: the easternmost project sits about a third of a degree inside the
 * frame, which at the overview is some 17px, and no name on this map is that
 * narrow. Reserve the widest label actually on the page rather than a guess at
 * one — and cap that reserve at a twelfth of the axis, because past that the
 * label is eating more of the window than it is worth and the declutter pass has
 * collapsed it to a dot anyway.
 */
export function framePadding(pins = []) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pad = { top: 74, bottom: 104, left: 48, right: 48 };
  const el = document.querySelector(".side");
  const gap = 18;

  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      // Whichever edge the panel hugs is the edge that has to be cleared.
      if (r.width < w - 80) pad.right = Math.round(w - r.left) + gap;
      else pad.bottom = Math.round(h - r.top) + gap;
    }
  }

  // Room for the label a pin carries, not just the dot it is anchored at.
  let halfW = 0;
  let halfH = 0;
  for (const p of pins) {
    halfW = Math.max(halfW, p.w / 2);
    halfH = Math.max(halfH, p.h / 2);
  }
  halfW = Math.min(halfW, w / 12);
  halfH = Math.min(halfH, h / 12);
  pad.left += halfW;
  pad.right += halfW;
  pad.top += halfH;
  pad.bottom += halfH;

  // fitBounds fits into whatever the padding leaves, so padding that swallows
  // the viewport gives a NaN camera and a blank map. The floor is a fixed band
  // rather than a share of the axis: under 900px the panel is a bottom sheet
  // over well past half the window, and a proportional cap there hands the
  // bottom of the frame straight back to the panel it was meant to clear.
  const BAND = 150;
  if (w - pad.left - pad.right < BAND) pad.right = Math.max(0, w - BAND - pad.left);
  if (h - pad.top - pad.bottom < BAND) pad.bottom = Math.max(0, h - BAND - pad.top);
  return pad;
}

// Web-mercator y carried in the same degree units as longitude, so one pixel
// scale serves both axes. maplibre's world is 512px wide at zoom 0.
const MERC_LIMIT = 85.051129;
const mercY = (lat) =>
  (180 / Math.PI) *
  Math.log(Math.tan(Math.PI / 4 + (Math.min(MERC_LIMIT, Math.max(-MERC_LIMIT, lat)) * Math.PI) / 360));
const mercLat = (y) => (360 / Math.PI) * Math.atan(Math.exp((y * Math.PI) / 180)) - 90;

/**
 * How far a viewer may pan, sized from the frame rather than typed in.
 *
 * Two things have to be inside it, and each is a way the map breaks if it is not.
 *
 * The whole overview window — the window, not the strip the panel leaves —
 * because maplibre raises the zoom floor until maxBounds fills the viewport. A
 * barrier drawn tight around the data therefore forbids the very frame it was
 * drawn to protect: the camera hits the edge, gets pushed back, and slides the
 * southern projects under the panel the padding had just cleared. Deriving the
 * barrier from the camera this window asks for is what makes that unreachable
 * rather than merely unlikely, at any window size, sheet layout and all.
 *
 * And REGION.reach, because comparables are matched on covariates rather than on
 * distance: one can land on any parcel in the grid, and a viewer has to be able
 * to pan to whatever the map has drawn.
 *
 * Around that union, one slack of air — a few hundred kilometres past the frame
 * and about a third of a stop of pull-back. Room to move; not so much room that
 * a flick loses the Amazon off the side of the screen.
 */
function panBarrier(map, camera, region) {
  const rect = map.getContainer().getBoundingClientRect();
  const degPerPx = 360 / (512 * Math.pow(2, camera.zoom));
  const lng = camera.center.lng ?? camera.center[0];
  const lat = camera.center.lat ?? camera.center[1];
  const y = mercY(lat);

  const [[rw, rs], [re, rn]] = region.reach;
  const w = Math.min(rw, lng - (rect.width / 2) * degPerPx);
  const e = Math.max(re, lng + (rect.width / 2) * degPerPx);
  const s = Math.min(rs, mercLat(y - (rect.height / 2) * degPerPx));
  const n = Math.max(rn, mercLat(y + (rect.height / 2) * degPerPx));

  const dx = ((e - w) * region.slack) / 2;
  const dy = ((n - s) * region.slack) / 2;
  return [
    [w - dx, Math.max(-MERC_LIMIT, s - dy)],
    [e + dx, Math.min(MERC_LIMIT, n + dy)],
  ];
}

const baseStyle = (year) => ({
  version: 8,
  glyphs: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/{fontstack}/{range}.pbf",
  sources: {
    imagery: { type: "raster", tiles: [s2(year)], tileSize: 256, maxzoom: 14 },
    places: { type: "raster", tiles: [PLACES], tileSize: 256, maxzoom: 18 },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#06090b" } },
    { id: "imagery", type: "raster", source: "imagery", paint: { "raster-fade-duration": 250 } },
    // Place labels are useful for orientation on the overview and pure noise
    // once a project fills the screen, so they fade out as you zoom in.
    {
      id: "places",
      type: "raster",
      source: "places",
      paint: {
        "raster-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.8, 7.5, 0.45, 8.5, 0],
      },
    },
  ],
});

// Global Forest Watch's own public tile layer for Hansen tree-cover loss,
// color-coded by year — live, keyless, verified working. (GFW rebranded to
// Global Nature Watch in 2025; globalforestwatch.org now redirects there, but
// this tiles.globalforestwatch.org endpoint is unaffected and still live —
// re-verified directly rather than assumed.) Used in place of a baked
// per-year polygon overlay where a region has no equivalent to PRODES's
// vector WFS (see tools/gfw.mjs). One real limitation, confirmed by testing:
// this layer ignores year-range query params, so it always shows the full
// measured record rather than revealing loss up to the slider's year the way
// the baked Amazon overlay does.
const GFW_LOSS_TILES = "https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png";

export default function MapView({
  year, selectedId, onSelect, controls, showControls, showLabels, parcelShapes, lossData, onReady,
  REGION, PROJECTS, yearWindow, liveClearingTiles,
}) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  const ready = useRef(false);
  const markers = useRef([]);
  const pins = useRef([]);
  // Whether the viewer has taken the camera somewhere themselves, and whether
  // the map has been framed once already. Between them they decide when a
  // re-frame is help and when it is snatching the view back.
  const moved = useRef(false);
  const framed = useRef(false);
  // Mirrored into state as well as a ref. The ref keeps the effects cheap, but
  // a ref does not re-run them - and a viewer who clicks a project before the
  // first tiles arrive would otherwise get a camera that never moves and pins
  // that never hide, silently and only on a cold cache.
  const [loaded, setLoaded] = useState(false);

  /**
   * Collapse a pin to its dot when its label would sit on a neighbour's.
   *
   * There are thirteen projects and the overview is about eight degrees of
   * longitude to a label's width, so on the Pará frontier — where the projects
   * are — several labels land on top of each other. Three rules keep this from
   * making things worse than the overlap did:
   *
   *   Labels are dropped, never nudged. A label that slides off its dot has
   *   stopped saying which parcel it names, which is the only thing it is for.
   *
   *   Priority is fixed, not read off the current view: featured first, then the
   *   largest claims. So a pan does not hand a label back and forth between two
   *   neighbours, which reads as flicker even though each frame is correct.
   *
   *   Collision is tested against the label's FULL width even while it is
   *   collapsed. Testing the collapsed dot would free the space that put it
   *   back, and it would flip between the two states every frame.
   */
  const declutter = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const placed = [];
    for (const pin of pins.current) {
      if (!pin.el.isConnected) continue; // detached while a project is open
      // Measured while expanded, which the first pass always is. Re-measuring
      // then keeps the boxes right through a font swap or a resize.
      if (!pin.el.classList.contains("is-dot")) {
        pin.w = pin.el.offsetWidth || pin.w;
        pin.h = pin.el.offsetHeight || pin.h;
      }
      const { x, y } = map.project(pin.lngLat);
      const box = [x - pin.w / 2 - 4, y - pin.h / 2 - 2, x + pin.w / 2 + 4, y + pin.h / 2 + 2];
      const hit = placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]);
      pin.el.classList.toggle("is-dot", hit);
      if (!hit) placed.push(box);
    }
  }, []);

  useEffect(() => {
    const map = new MapLibreMap({
      container: ref.current,
      style: baseStyle(year),
      center: REGION.center,
      zoom: REGION.zoom,
      // A backstop, not the limit. maxBounds is what actually sets the floor:
      // maplibre raises the zoom until the bounds fill the window, so this only
      // has to sit below that floor at any window size and let geography, not a
      // magic number, decide how far back a viewer can stand.
      minZoom: 2.8,
      maxZoom: 13,
      // Only in force until the map loads and the first overview frame replaces
      // it with one measured off that frame — see `panBarrier`.
      maxBounds: REGION.maxBounds,
      renderWorldCopies: false,
      attributionControl: false,
      dragRotate: false,
      // Required so the PDF report can capture the canvas.
      preserveDrawingBuffer: true,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new ScaleControl({ maxWidth: 96, unit: "metric" }), "bottom-right");
    if (import.meta.env.DEV) {
      window.__map = map;
      // The camera the current window wants for the overview, without moving to
      // it. The one thing a barrier must never do is forbid this — and that is
      // not visible from the outside, because a clamped fit still looks like a
      // fit. Exposed so scripts/_check-frame.mjs can ask directly.
      window.__overview = () => map.cameraForBounds(REGION.bounds, { padding: framePadding(pins.current) });
    }

    map.on("load", () => {
      map.addSource("projects", { type: "geojson", data: fc(PROJECTS.map((p) => projectFeature(p, { id: p.id }))) });
      map.addSource("controls", { type: "geojson", data: EMPTY });
      map.addSource("loss-outside", { type: "geojson", data: EMPTY });
      map.addSource("loss-inside", { type: "geojson", data: EMPTY });

      // Live measured-loss tiles, for regions with no baked per-year polygon
      // overlay. liveClearingTiles is fixed for the lifetime of one mounted
      // MapView (the app remounts the whole map on a region switch), so this
      // only needs to be decided once, here.
      if (liveClearingTiles) {
        map.addSource("gfw-loss", { type: "raster", tiles: [GFW_LOSS_TILES], tileSize: 256, maxzoom: 12 });
        map.addLayer({
          id: "gfw-loss-tiles", type: "raster", source: "gfw-loss",
          paint: { "raster-opacity": 0.75 },
          // Starts hidden — it covers the whole visible map rather than one
          // project's footprint, so it's toggled on only once a project is
          // selected (see the selectedId effect below).
          layout: { visibility: selectedId ? "visible" : "none" },
        });
      }

      // Comparables sit under everything: present, never competing.
      map.addLayer({
        id: "control-fill", type: "fill", source: "controls",
        // Light enough that the satellite ground and the forest structure cut
        // out of the parcel both read through it. These are annotations on the
        // imagery, not tiles laid over it.
        paint: { "fill-color": COLORS.control, "fill-opacity": 0.22 },
      });
      map.addLayer({
        id: "control-line", type: "line", source: "controls",
        paint: {
          "line-color": COLORS.control, "line-width": 1.2, "line-opacity": 0.7,
        },
        layout: { "line-join": "round", "line-cap": "round" },
      });

      // Clearing around the project, shown quietly so the frontier is legible
      // without implying the project is answerable for its neighbours' land.
      map.addLayer({
        id: "loss-outside-fill", type: "fill", source: "loss-outside",
        paint: { "fill-color": COLORS.loss, "fill-opacity": 0.28 },
      });
      // Clearing inside the boundary, at full weight. This is the evidence.
      map.addLayer({
        id: "loss-inside-fill", type: "fill", source: "loss-inside",
        paint: { "fill-color": COLORS.loss, "fill-opacity": 0.82 },
      });

      map.addLayer({
        id: "project-fill", type: "fill", source: "projects",
        paint: { "fill-color": COLORS.project, "fill-opacity": 0.06 },
      });
      // Two strokes make the boundary readable over bright and dark ground
      // alike: a soft wide glow, then a crisp line on top.
      map.addLayer({
        id: "project-glow", type: "line", source: "projects",
        paint: { "line-color": COLORS.project, "line-width": 7, "line-opacity": 0.16, "line-blur": 5 },
        layout: { "line-join": "round" },
      });
      map.addLayer({
        id: "project-line", type: "line", source: "projects",
        paint: { "line-color": COLORS.project, "line-width": 2 },
        layout: { "line-join": "round" },
      });

      // Built in priority order, which is the order `declutter` walks: whichever
      // pins are created first keep their labels when labels have to go.
      const byPriority = [...PROJECTS].sort(
        (a, b) => Number(!!b.featured) - Number(!!a.featured) || b.claimedBaselineLoss - a.claimedBaselineLoss
      );
      for (const p of byPriority) {
        const el = document.createElement("button");
        el.className = "pin";
        el.type = "button";
        el.dataset.id = p.id;
        el.innerHTML = `<i></i><span></span>`;
        el.querySelector("span").textContent = p.shortName ?? p.name;
        const bought = purchaseSummary(p);
        const recordStatus = p.real === true
          ? "Real registered project"
          : "Illustrative project; parties, buyers, claims and credit figures are fictional";
        const purchaseDetail = bought
          ? ", " + bought.credits.toLocaleString("en-US") + " credits bought by " +
            bought.buyers + (bought.buyers === 1 ? " company" : " companies") + " in " + bought.region
          : "";
        el.title = `${recordStatus}: ${p.name}${purchaseDetail}`;
        el.setAttribute("aria-label", el.title);
        el.dataset.recordType = p.real === true ? "real" : "illustrative";
        el.addEventListener("click", (e) => { e.stopPropagation(); onSelect(p.id); });
        markers.current.push(new Marker({ element: el }).setLngLat(p.center).addTo(map));
        pins.current.push({ el, lngLat: p.center, w: 0, h: 0 });
      }
      declutter();
      map.on("move", declutter);

      map.on("click", "project-fill", (e) => onSelect(e.features[0].properties.id));
      for (const id of ["project-fill", "control-fill"]) {
        map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
      }

      map.on("click", "control-fill", (e) => {
        const p = e.features[0].properties;
        new Popup({ closeButton: false, maxWidth: "250px" })
          .setLngLat(e.lngLat)
          .setHTML(
            `<div class="pop-title">${esc(p.label || "Comparable parcel")}</div>` +
              `<div class="pop-row"><span>Lost ${yearWindow[0]}–${yearWindow[1]}</span><b style="color:${COLORS.loss}">${(Number(p.loss) * 100).toFixed(1)}%</b></div>` +
              `<div class="pop-row"><span>This project lost</span><b>${(Number(p.projectLoss) * 100).toFixed(1)}%</b></div>` +
              `<div class="pop-row"><span>Similarity</span><b>${Number(p.similarity).toFixed(0)}%</b></div>` +
              `<div class="pop-note">Unprotected · ${
              p.outline === "measured"
                ? "forest outline measured"
                : "outline indicative, figures measured over its 1° parcel"
            } · INPE PRODES</div>`
          )
          .addTo(map);
      });

      // Who bought the credits, on hover.
      //
      // The map is already good at "where" and says nothing about "who", which
      // is the half of the record a buyer can act on: a region cannot be asked
      // about its due diligence and a company can. The wording is the same
      // sentence the panel and the PDF use, from one function, so a reader
      // comparing the screen against the file they downloaded sees one claim.
      const buyPopup = new Popup({
        closeButton: false, closeOnClick: false, offset: 14, maxWidth: "300px", className: "pop-buy",
      });
      let hoveredProject = null;
      const showPurchases = (e) => {
        const id = e.features[0]?.properties?.id;
        const project = PROJECTS.find((p) => p.id === id);
        if (!project) return;
        if (id !== hoveredProject) {
          hoveredProject = id;
          const rows = purchaseRows(project);
          const statusNote = project.real === true
            ? "Real registered project · registry facts are sourced"
            : "Illustrative project · parties, buyers, baseline claims and credit figures are fictional; forest measurements are real";
          buyPopup.setHTML(
            `<div class="pop-title">${esc(project.name)}</div>` +
              rows.map((r) => `<div class="pop-line">${esc(r.sentence)}</div>`).join("") +
              (rows.length
                ? `<div class="pop-row"><span>Bought and retired</span><b>${rows
                    .reduce((t, r) => t + r.credits, 0)
                    .toLocaleString("en-US")}</b></div>`
                : "") +
              `<div class="pop-note">${statusNote}</div>`
          );
          buyPopup.addTo(map);
        }
        buyPopup.setLngLat(e.lngLat);
      };
      map.on("mouseenter", "project-fill", showPurchases);
      map.on("mousemove", "project-fill", showPurchases);
      map.on("mouseleave", "project-fill", () => { hoveredProject = null; buyPopup.remove(); });

      // A viewer who has taken the camera somewhere themselves keeps it: only
      // an untouched frame is re-fitted when the window changes size.
      map.on("movestart", (e) => { if (e.originalEvent) moved.current = true; });

      ready.current = true;
      setLoaded(true);

      /**
       * The map as a picture, for the PDF.
       *
       * `preserveDrawingBuffer` is what makes the frame still readable after it
       * has been composited, and redraw() makes sure the frame read is the
       * current one rather than whatever was on screen before the last state
       * change. Downscaled through a 2D canvas on the way out: a HiDPI map
       * canvas is five or six megapixels and would land in the report as
       * megabytes of JPEG for no visible gain on a printed page.
       */
      const snapshot = (maxWidth = 1600) => {
        try {
          map.redraw();
          const src = map.getCanvas();
          if (!src.width || !src.height) return null;
          const scale = Math.min(1, maxWidth / src.width);
          const out = document.createElement("canvas");
          out.width = Math.round(src.width * scale);
          out.height = Math.round(src.height * scale);
          out.getContext("2d").drawImage(src, 0, 0, out.width, out.height);
          return { dataUrl: out.toDataURL("image/jpeg", 0.9), width: out.width, height: out.height };
        } catch {
          return null; // a tainted or lost context is a report without a map, not a crash
        }
      };
      onReady?.({ map, snapshot });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      ready.current = false;
      markers.current = [];
      pins.current = [];
    };
  }, []);

  // Imagery year. maplibre cross-fades raster sources on its own, so swapping
  // the tile template is all that is needed for a clean transition.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    map.getSource("imagery")?.setTiles?.([s2(year)]);
  }, [year, loaded]);

  // Reveal clearing up to and including the active year. Because the source
  // holds every year at once, this is a filter rather than a refetch — scrubbing
  // costs nothing and the red area can only grow as the year advances.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const upTo = ["<=", ["get", "y"], year];
    for (const id of ["loss-inside-fill", "loss-outside-fill"]) {
      if (map.getLayer(id)) map.setFilter(id, upTo);
    }
  }, [year, lossData, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    map.getSource("loss-inside")?.setData(lossData?.inside ?? EMPTY);
    map.getSource("loss-outside")?.setData(lossData?.outside ?? EMPTY);
  }, [lossData, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current || !map.getLayer("places")) return;
    map.setLayoutProperty("places", "visibility", showLabels ? "visible" : "none");
  }, [showLabels, loaded]);

  // Comparable parcels. Where the bake produced a real forest outline it is used;
  // otherwise the parcel falls back to its own one-degree box, which is what the
  // measurement is actually taken over.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const projectLoss = selectedId
      ? lossFraction(PROJECTS.find((p) => p.id === selectedId).parcel, yearWindow[0], yearWindow[1])
      : 0;

    const feats = (showControls && controls ? controls : []).map((m) => {
      const baked = UNIFORM_REFERENCE_SHAPES ? null : parcelShapes?.[m.cell.id];
      // A baked outline that is only the parcel box says nothing the box did not,
      // and it is the one case that still lands on the map as a rectangle. Draw it
      // the way every other zone is drawn.
      const shape = isRectangularOutline(baked) ? null : baked;
      return {
        type: "Feature",
        properties: {
          id: m.cell.id,
          label: m.cell.label,
          similarity: m.similarity,
          loss: lossFraction(m.cell, yearWindow[0], yearWindow[1]),
          projectLoss,
          // Which outline this is, so the popup can say so rather than let a
          // drawn shape imply a precision the figures behind it do not have.
          outline: shape ? "measured" : "indicative",
        },
        // The fallback is no longer the parcel's bare one-degree box. It is the
        // same harmonic outline the project boundary is drawn with, inscribed
        // in that box so it can only ever understate the ground the numbers
        // were summed over, never claim any outside it.
        geometry: shape ?? { type: "Polygon", coordinates: [parcelRing(m.cell)] },
      };
    });
    map.getSource("controls")?.setData(fc(feats));
  }, [controls, showControls, parcelShapes, selectedId, loaded]);

  // Camera. Everything the viewer is meant to read is fitted into the space the
  // panel leaves rather than into the window: a marker drawn under an opaque
  // panel is a marker that is not on the map, and that is the commonest way a
  // map like this quietly fails.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const project = PROJECTS.find((x) => x.id === selectedId);

    // Pins are taken off the map while a project is open, not dimmed. Twelve
    // competing labels around the one polygon a viewer is meant to read is the
    // single biggest source of clutter here.
    //
    // Detached rather than hidden with a class: maplibre writes marker opacity
    // as an inline style for terrain occlusion, so any stylesheet rule loses to
    // it. Removing the marker is both what "hide entirely" should mean and the
    // only version that actually works.
    for (const marker of markers.current) {
      if (selectedId) marker.remove();
      else marker.addTo(map);
    }
    // Re-attached pins carry whatever collapsed state they had when they left,
    // and the camera has moved since. Settle them before the ease-out starts.
    if (!selectedId) declutter();

    // Size the pan barrier to the overview this window would produce.
    //
    // Down first: the standing barrier was built for the last window, and a
    // stale one clamps the very fit whose job it is to protect. Built before the
    // move rather than after it, so a fit travels inside its final barrier and
    // never has to be corrected mid-flight.
    const rebuild = (padding) => {
      map.setMaxBounds(null);
      const camera = map.cameraForBounds(REGION.bounds, { padding });
      if (camera) map.setMaxBounds(panBarrier(map, camera, REGION));
    };

    const frame = (duration) => {
      const padding = framePadding(pins.current);
      moved.current = false;

      if (!project) {
        // The overview fits the projects rather than easing to a fixed centre
        // and zoom. A fixed zoom cannot know how much of the window the panel is
        // covering — and maxBounds was quietly overriding it anyway, so the
        // region was never actually framed the way the numbers here said.
        rebuild(padding);
        map.fitBounds(REGION.bounds, { padding, duration });
        return;
      }

      // Frame the project itself. The comparables are hundreds of kilometres
      // away by design — fitting them all would zoom out until the project is a
      // dot, so they are reachable on the overview rather than forced in here.
      const ring = boundaryLonLat(project);
      let w = 180, s = 90, e = -180, n = -90;
      for (const [lon, lat] of ring) {
        w = Math.min(w, lon); e = Math.max(e, lon);
        s = Math.min(s, lat); n = Math.max(n, lat);
      }
      map.fitBounds([[w, s], [e, n]], { padding, duration, maxZoom: 11 });
    };

    // The opening frame is where the map already is, so it is placed rather
    // than travelled to; everything after it is a move the viewer can follow.
    frame(framed.current ? (project ? 1200 : 900) : 0);
    framed.current = true;

    // A resize changes both how much map there is and how much of it the panel
    // covers, so a frame that cleared the panel before it can hide markers
    // after. Re-fit — unless the viewer has moved the camera themselves since,
    // in which case the frame is theirs and not ours to take back.
    //
    // The barrier is rebuilt either way, because it is a function of the window
    // and not of the frame. Left alone, one sized for a smaller window survives
    // into a larger one, and then shoves the viewer's camera around to satisfy a
    // limit computed for a window that no longer exists.
    const onResize = () => {
      if (moved.current) rebuild(framePadding(pins.current));
      else frame(0);
    };
    map.on("resize", onResize);
    return () => map.off("resize", onResize);
  }, [selectedId, loaded, declutter]);

  // Only the selected project is drawn. The others are not context here, they
  // are distraction.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const only = selectedId ? ["==", ["get", "id"], selectedId] : null;
    for (const id of ["project-fill", "project-line", "project-glow"]) {
      if (map.getLayer(id)) map.setFilter(id, only);
    }
    map.setPaintProperty("project-fill", "fill-opacity", selectedId ? 0.06 : 0.1);
    map.setPaintProperty("project-line", "line-width", selectedId ? 2 : 1.4);

    // The live clearing-tile layer (liveClearingTiles regions only) covers
    // the whole visible map, not just a project's footprint — unlike the
    // Amazon's baked loss-inside/loss-outside sources, which are only
    // populated once a project is selected. Left always-on, it renders as a
    // wall of red across the entire overview. Match the Amazon's behaviour:
    // hidden until a project is open.
    if (map.getLayer("gfw-loss-tiles")) {
      map.setLayoutProperty("gfw-loss-tiles", "visibility", selectedId ? "visible" : "none");
    }
  }, [selectedId, loaded]);

  return <div ref={ref} className="map" />;
}
