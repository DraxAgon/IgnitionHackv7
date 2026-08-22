"""Geographic arithmetic that does not lie about area or distance.

Degrees are not a unit of length. A degree of longitude is 111 km at the equator
and 50 km at 63 degrees north, so any area or distance computed directly in
EPSG:4326 is wrong by a latitude-dependent factor. Everything here either
reprojects first or uses an explicitly spherical formula, and the one function
that works in degrees says so in its name.

`shapely`/`pyproj` are optional at this layer: the pipeline runs on tabular
forest histories and only needs them when a real polygon or raster is involved.
Import failures are surfaced as a clear error at the point of use rather than
taking down the whole engine at import time.
"""

from __future__ import annotations

import math
from typing import Any

EARTH_RADIUS_KM = 6371.0088

try:  # pragma: no cover - exercised by environment, not by tests
    from pyproj import CRS, Geod, Transformer

    _HAVE_PYPROJ = True
    _GEOD = Geod(ellps="WGS84")
except ImportError:  # pragma: no cover
    _HAVE_PYPROJ = False
    _GEOD = None


def _require_pyproj(what: str) -> None:
    if not _HAVE_PYPROJ:
        raise ImportError(
            f"{what} needs pyproj, which is not installed. Install the geospatial "
            f"extras (pip install -e 'backend[geo]') or use the tabular data adapters, "
            f"which do not require it."
        )


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance between two (lon, lat) points, in km.

    Used for the leakage buffer, where the question is "how far apart is this
    control from the project" and a spherical answer is accurate to well within
    the precision the buffer is specified at.
    """
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(min(1.0, h)))


def equal_area_crs_for(lon: float, lat: float) -> str:
    """An appropriate equal-area projection for measuring near a given point.

    Returns a Lambert Azimuthal Equal Area definition centred on the location.
    Centring on the data rather than using a single global projection keeps
    distortion negligible across a project-sized footprint, which a fixed
    continental projection cannot promise at its edges.
    """
    return (
        f"+proj=laea +lat_0={lat:.6f} +lon_0={lon:.6f} "
        f"+x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs"
    )


def utm_crs_for(lon: float, lat: float) -> str:
    """The UTM zone containing a point, as an EPSG code string.

    Preferred over LAEA when distances matter more than areas, since UTM is
    conformal. Both are offered because the right choice depends on what is
    being measured, and picking one silently would be the mistake.
    """
    zone = int((lon + 180.0) / 6.0) + 1
    epsg = (32600 if lat >= 0 else 32700) + zone
    return f"EPSG:{epsg}"


def polygon_area_ha(geometry: Any, crs: str | None = None) -> float:
    """Area of a shapely geometry in hectares, measured in a projected CRS.

    `geometry` is assumed to be in EPSG:4326 unless `crs` says otherwise. The
    geometry is reprojected to an equal-area projection centred on its own
    centroid before the area is taken - never measured in degrees.
    """
    _require_pyproj("polygon_area_ha")
    from shapely.ops import transform as shapely_transform

    source = crs or "EPSG:4326"
    centroid = geometry.centroid
    target = equal_area_crs_for(centroid.x, centroid.y)
    transformer = Transformer.from_crs(CRS.from_user_input(source), CRS.from_user_input(target), always_xy=True)
    projected = shapely_transform(transformer.transform, geometry)
    return float(projected.area) / 10_000.0


def geodesic_area_ha(geometry: Any) -> float:
    """Area of a lon/lat polygon in hectares, computed on the ellipsoid.

    An alternative to `polygon_area_ha` that avoids choosing a projection at all.
    Slower, and only defined for polygons, but it is the reference the projected
    calculation should agree with - `test_geo` asserts they do.
    """
    _require_pyproj("geodesic_area_ha")
    area_m2, _ = _GEOD.geometry_area_perimeter(geometry)
    return abs(area_m2) / 10_000.0


def bbox_area_km2(west: float, south: float, east: float, north: float) -> float:
    """Approximate area of a lon/lat bounding box, in km2.

    A closed-form spherical result, exact for a box on a sphere. Kept for
    aggregating gridded data where the parcel *is* a lon/lat box and reprojecting
    each one would be needless work.
    """
    lat_n, lat_s = math.radians(north), math.radians(south)
    return abs(
        (math.radians(east) - math.radians(west))
        * (math.sin(lat_n) - math.sin(lat_s))
        * EARTH_RADIUS_KM ** 2
    )


def km2_to_ha(km2: float) -> float:
    """1 km2 = 100 ha. Stated as a function because the conversion has been got
    wrong in enough carbon accounting to be worth never inlining."""
    return km2 * 100.0


def ha_to_km2(ha: float) -> float:
    return ha / 100.0


def bbox_separation_km(
    bbox_a: tuple[float, float, float, float] | None,
    centroid_a: tuple[float, float],
    bbox_b: tuple[float, float, float, float] | None,
    centroid_b: tuple[float, float],
) -> float:
    """Clear space between two parcels, in km. Zero if they touch or overlap.

    Centroid distance is the wrong measure for a leakage buffer and gets more
    wrong as the units get coarser. Two 1-degree parcels sharing an edge have
    centroids about 110 km apart, so a 25 km centroid buffer would happily accept
    a control that is physically adjacent to the project - exactly the parcel
    most likely to absorb displaced clearing, and therefore the one most likely
    to inflate the counterfactual in the project's favour.

    What the buffer is trying to express is "how much untouched land lies between
    the project and this control", which is edge-to-edge distance. Computed as
    the gap in each axis, zero where the boxes overlap, combined as a right
    triangle and converted at the mean latitude. Falls back to centroid distance
    when a unit has no bounding box, which is conservative in the wrong direction
    and so is worth knowing about.
    """
    if bbox_a is None or bbox_b is None:
        return haversine_km(centroid_a, centroid_b)
    w_a, s_a, e_a, n_a = bbox_a
    w_b, s_b, e_b, n_b = bbox_b
    gap_lon = max(0.0, w_b - e_a, w_a - e_b)
    gap_lat = max(0.0, s_b - n_a, s_a - n_b)
    if gap_lon == 0.0 and gap_lat == 0.0:
        return 0.0
    mean_lat = (max(s_a, s_b) + min(n_a, n_b)) / 2.0
    km_lon = gap_lon * 111.320 * max(math.cos(math.radians(mean_lat)), 1e-6)
    km_lat = gap_lat * 110.574
    return math.hypot(km_lon, km_lat)


def degrees_buffer_for_km(km: float, latitude: float) -> tuple[float, float]:
    """Longitude and latitude offsets spanning `km` at a given latitude.

    Only for cheap pre-filters where an exact distance is about to be computed
    anyway. The name says "degrees" because using the result as if it were a
    distance is the error this whole module exists to prevent.
    """
    dlat = km / 110.574
    cos_lat = max(math.cos(math.radians(latitude)), 1e-6)
    dlon = km / (111.320 * cos_lat)
    return dlon, dlat
