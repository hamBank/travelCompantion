"""River-path estimation for the `river_transfer` item kind.

Queries OpenStreetMap's Overpass API for waterway=river geometry between two
points and greedily stitches the (often fragmented) way segments into one
"assumed path" polyline. This is explicitly a best-effort approximation, not
a routed/authoritative path — Overpass segments are frequently split at admin
boundaries or tag changes even when they represent one continuous river.

Network access goes through injectable `fetch_json`/`geocode` callables so
the logic is unit-tested without hitting the network (mirrors backend/weather.py).
"""
from __future__ import annotations

import json
import math
import re
import urllib.parse
import urllib.request

MAX_STRAIGHT_LINE_KM = 300
ENDPOINT_STITCH_TOLERANCE_KM = 0.3
# Locks and weirs on channelized rivers (e.g. the barrages on the Rhône)
# often split the `waterway=river` tag right at the structure, leaving a
# gap wider than the standard stitch tolerance between otherwise-continuous
# chains. Used only as a fallback pass when the strict tolerance fails to
# produce a path reaching both endpoints, so it doesn't loosely join
# unrelated waterways in the common case.
BRIDGE_STITCH_TOLERANCE_KM = 2.0
ORIGIN_DEST_SNAP_TOLERANCE_KM = 5
MAX_WAYS = 400
FINAL_SIMPLIFY_MAX_POINTS = 300

_OVERPASS = "https://overpass-api.de/api/interpreter"
_NOMINATIM = "https://nominatim.openstreetmap.org/search"
# Both services front their API with a CDN that rejects the default urllib
# User-Agent ("Python-urllib/3.x") as bot traffic (406 Not Acceptable) —
# Nominatim's usage policy requires a real one anyway, so share it.
_UA_HEADERS = {"User-Agent": "TravelCompanion/1.0 (personal travel planner)"}
_NOMINATIM_HEADERS = _UA_HEADERS


class NoPlausiblePath(Exception):
    """Raised when no plausible river path could be assembled. The message is
    a specific, actionable reason (which stage failed and why) rather than a
    generic "not found" — OSM waterway data can be fragmented in enough
    different ways (no data at all, unnamed and ambiguous, or found but too
    far from one endpoint) that a single generic message isn't enough to
    troubleshoot a real failure without server access."""


def haversine_km(a: tuple, b: tuple) -> float:
    """Great-circle distance in km between two (lat, lng) points."""
    r = 6371.0
    lat1, lng1 = a
    lat2, lng2 = b
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    x = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
    return r * 2 * math.atan2(math.sqrt(x), math.sqrt(1 - x))


def _default_fetch_overpass(query: str) -> dict:
    req = urllib.request.Request(
        _OVERPASS,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={**_UA_HEADERS, "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read())


def _default_geocode(q: str):
    url = _NOMINATIM + "?" + urllib.parse.urlencode({"q": q, "format": "json", "limit": 1})
    req = urllib.request.Request(url, headers=_NOMINATIM_HEADERS)
    with urllib.request.urlopen(req, timeout=8) as resp:
        results = json.loads(resp.read())
    if not results:
        return None
    return float(results[0]["lat"]), float(results[0]["lon"])


def _parse_point(s: str, geocode):
    """Accept 'lat,lng' or a free-text place name; return (lat, lng) or None."""
    s = (s or "").strip()
    if not s:
        return None
    parts = s.split(",")
    if len(parts) == 2:
        try:
            return float(parts[0].strip()), float(parts[1].strip())
        except ValueError:
            pass
    return geocode(s)


def _bbox(a: tuple, b: tuple, pad_km: float):
    lat1, lng1 = a
    lat2, lng2 = b
    lat_pad = pad_km / 111.0
    mid_lat = (lat1 + lat2) / 2
    lng_pad = pad_km / (111.0 * max(0.2, math.cos(math.radians(mid_lat))))
    south = min(lat1, lat2) - lat_pad
    north = max(lat1, lat2) + lat_pad
    west = min(lng1, lng2) - lng_pad
    east = max(lng1, lng2) + lng_pad
    return south, west, north, east


def build_overpass_query(bbox: tuple, river_name: str | None = None) -> str:
    south, west, north, east = bbox
    bbox_str = f"{south},{west},{north},{east}"
    if river_name:
        safe = re.sub(r'["\\]', '', river_name.strip())
        name_filter = f'["name"~"{safe}",i]'
    else:
        name_filter = ""
    # Also match waterway=canal: navigable rivers are frequently routed
    # through diversion canals around locks/dams (e.g. the Rhône's
    # "court-circuité" bypasses), which OSM tags separately from the
    # natural riverbed even though a boat travels straight through them.
    return (
        f'[out:json][timeout:20];'
        f'way["waterway"~"^(river|canal)$"]{name_filter}({bbox_str});'
        f'out geom;'
    )


def _ways_from_response(resp: dict) -> list[list[tuple]]:
    ways = []
    for el in (resp or {}).get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry") or []
        pts = [(g["lat"], g["lon"]) for g in geom if "lat" in g and "lon" in g]
        if len(pts) >= 2:
            ways.append(pts)
    return ways


def _merge_ways(ways: list, tolerance_km: float = ENDPOINT_STITCH_TOLERANCE_KM) -> list:
    """Greedily stitch way segments into longer continuous chains, snapping
    endpoints within `tolerance_km` of each other. Returns a list of merged
    polylines (each a list of (lat, lng)) — one per disjoint river branch."""
    remaining = [list(w) for w in ways]
    merged = []
    while remaining:
        chain = remaining.pop(0)
        extended = True
        while extended:
            extended = False
            for i, way in enumerate(remaining):
                head, tail = chain[0], chain[-1]
                w_head, w_tail = way[0], way[-1]
                if haversine_km(tail, w_head) <= tolerance_km:
                    chain = chain + way[1:]
                elif haversine_km(tail, w_tail) <= tolerance_km:
                    chain = chain + list(reversed(way))[1:]
                elif haversine_km(head, w_tail) <= tolerance_km:
                    chain = way[:-1] + chain
                elif haversine_km(head, w_head) <= tolerance_km:
                    chain = list(reversed(way))[:-1] + chain
                else:
                    continue
                remaining.pop(i)
                extended = True
                break
        merged.append(chain)
    return merged


def _nearest_index(polyline: list, point: tuple):
    best_i, best_d = 0, None
    for i, p in enumerate(polyline):
        d = haversine_km(p, point)
        if best_d is None or d < best_d:
            best_d, best_i = d, i
    return best_i, best_d


def _pick_best_polyline(polylines: list, origin: tuple, destination: tuple):
    """Return (polyline, i_origin, d_origin, i_dest, d_dest) for whichever
    candidate minimizes total distance to both endpoints, or None if given
    no candidates."""
    best, best_score = None, None
    for pl in polylines:
        i_o, d_o = _nearest_index(pl, origin)
        i_d, d_d = _nearest_index(pl, destination)
        score = d_o + d_d
        if best_score is None or score < best_score:
            best_score = score
            best = (pl, i_o, d_o, i_d, d_d)
    return best


def _slice_between(polyline: list, i0: int, i1: int) -> list:
    if i0 <= i1:
        return polyline[i0:i1 + 1]
    return list(reversed(polyline[i1:i0 + 1]))


def _simplify(points: list, max_points: int = FINAL_SIMPLIFY_MAX_POINTS) -> list:
    """Stride-decimate to at most `max_points`, always keeping the last point
    (mirrors the elevation-sampling decimation already used in routers/items.py)."""
    n = len(points)
    if n <= max_points:
        return points
    stride = max(1, n // max_points)
    sample = points[::stride]
    if sample[-1] != points[-1]:
        sample = sample + [points[-1]]
    return sample


def estimate_river_path(
    origin: str, destination: str, river_name: str | None = None, *,
    fetch_json=None, geocode=None,
) -> dict:
    """Return {"path": [[lat,lng],...], "distance_km": float, "river_name_used": str|None}.

    Raises ValueError for invalid input (points too far apart to plausibly be
    a river transfer) — the caller maps that to a 400. Raises NoPlausiblePath,
    with a specific reason, when geocoding or stitching didn't produce a
    usable path — the caller maps that to a 404. Network/parsing failures
    propagate as-is for the caller to map to a 503.
    """
    fetch_json = fetch_json or _default_fetch_overpass
    geocode = geocode or _default_geocode

    a = _parse_point(origin, geocode)
    b = _parse_point(destination, geocode)
    if a is None or b is None:
        bad = origin if a is None else destination
        raise NoPlausiblePath(f"Could not resolve '{bad}' to a location")

    straight_km = haversine_km(a, b)
    if straight_km > MAX_STRAIGHT_LINE_KM:
        raise ValueError(
            f"Origin and destination are {round(straight_km)} km apart — "
            f"too far for a river path estimate"
        )

    pad_km = max(10.0, straight_km * 0.25)
    bbox = _bbox(a, b, pad_km)

    def build_path(ways):
        """Try the strict stitch tolerance first, then a looser "bridge"
        tolerance (for gaps at locks/weirs) only if that fails. Returns
        (sub_path, None) on success, or (None, (d_o, d_d)) with the closest
        miss seen across both passes, or (None, None) if no candidate chain
        was produced at all."""
        closest = None
        for tolerance in (ENDPOINT_STITCH_TOLERANCE_KM, BRIDGE_STITCH_TOLERANCE_KM):
            merged = _merge_ways(ways, tolerance)
            if not merged:
                continue
            best = _pick_best_polyline(merged, a, b)
            if best is None:
                continue
            pl, i_o, d_o, i_d, d_d = best
            if closest is None or (d_o + d_d) < (closest[0] + closest[1]):
                closest = (d_o, d_d)
            if d_o > ORIGIN_DEST_SNAP_TOLERANCE_KM or d_d > ORIGIN_DEST_SNAP_TOLERANCE_KM:
                continue
            sub = _simplify(_slice_between(pl, i_o, i_d))
            if len(sub) >= 2:
                return sub, None
        return None, closest

    sub, used_name = None, None
    named_miss = None
    if river_name:
        named_ways = _ways_from_response(fetch_json(build_overpass_query(bbox, river_name)))
        if named_ways:
            sub, named_miss = build_path(named_ways)
        if sub is not None:
            used_name = river_name

    broad_miss = None
    if sub is None:
        # No river name given, named query came up empty, or the named ways
        # didn't stitch into a path reaching both endpoints — retry broad
        # (riskier, no name filter).
        broad_ways = _ways_from_response(fetch_json(build_overpass_query(bbox, None)))
        if not river_name and len(broad_ways) > MAX_WAYS:
            raise NoPlausiblePath(
                f"Found {len(broad_ways)} unnamed waterway segments near these points "
                f"(limit {MAX_WAYS}) — too ambiguous without a river name, try providing one"
            )
        if broad_ways:
            sub, broad_miss = build_path(broad_ways)
        used_name = None

    if sub is None:
        miss = broad_miss or named_miss
        if miss is None:
            raise NoPlausiblePath(
                f"No waterway data found near these points in OpenStreetMap "
                f"(searched a ~{pad_km:.0f} km-padded area)"
            )
        d_o, d_d = miss
        raise NoPlausiblePath(
            f"Found waterway data but couldn't connect a path reaching both points — "
            f"closest match was {d_o:.1f} km from the start and {d_d:.1f} km from the end "
            f"(tolerance is {ORIGIN_DEST_SNAP_TOLERANCE_KM} km). The origin/destination may "
            f"not be directly on a mapped waterway, or the river is fragmented in OSM here."
        )

    dist_km = sum(haversine_km(sub[i], sub[i + 1]) for i in range(len(sub) - 1))

    return {
        "path": [[round(lat, 6), round(lng, 6)] for lat, lng in sub],
        "distance_km": round(dist_km, 1),
        "river_name_used": used_name,
    }
