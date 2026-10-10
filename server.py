from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import math
import mimetypes
import io
import sys
import struct
import uuid
import zipfile
import base64
import re
from urllib.parse import unquote, urlsplit


# 兼容层：str.removeprefix / str.removesuffix 是 Python 3.9 才有的，
# 本机与部分演示环境只有 3.8（本机为 3.8.8），直接用会让
# 「数据集切换 / 删除 / 单数据集查询」三个接口 500。
# 下面两个函数是等价实现，在 3.9+ 上行为完全一致。
def remove_prefix(text, prefix):
    return text[len(prefix):] if text.startswith(prefix) else text


def remove_suffix(text, suffix):
    if suffix and text.endswith(suffix):
        return text[: -len(suffix)]
    return text


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "features.geojson"
UPLOAD_DIR = DATA_DIR / "uploads"
CATALOG_FILE = DATA_DIR / "catalog.json"
ACTIVE_DATASET_FILE = DATA_DIR / "active_dataset.json"
MAX_IMPORT_BYTES = 20 * 1024 * 1024
MAX_FEATURES = 10000
MAX_ZIP_MEMBERS = 32
MAX_REQUEST_BYTES = 32 * 1024 * 1024


SAMPLE_DATA = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "id": "pt-campus-gate",
            "properties": {"name": "校园入口", "layer": "兴趣点", "kind": "point"},
            "geometry": {"type": "Point", "coordinates": [180, 760]},
        },
        {
            "type": "Feature",
            "id": "ln-main-road",
            "properties": {"name": "主干道", "layer": "道路", "kind": "line"},
            "geometry": {
                "type": "LineString",
                "coordinates": [[90, 640], [260, 610], [430, 580], [720, 520], [910, 460]],
            },
        },
        {
            "type": "Feature",
            "id": "pg-lake",
            "properties": {"name": "中心湖", "layer": "水域", "kind": "polygon"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [[430, 720], [610, 690], [680, 800], [600, 910], [420, 880], [360, 790], [430, 720]]
                ],
            },
        },
        {
            "type": "Feature",
            "id": "pg-teaching-area",
            "properties": {"name": "教学区", "layer": "功能区", "kind": "polygon"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [[150, 180], [430, 150], [490, 330], [390, 480], [160, 440], [90, 260], [150, 180]]
                ],
            },
        },
    ],
}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def validate_feature_collection(payload):
    if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection":
        raise ValueError("payload must be a GeoJSON FeatureCollection")
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError("features must be a list")
    if len(features) > MAX_FEATURES:
        raise ValueError(f"feature count cannot exceed {MAX_FEATURES}")
    for feature in features:
        validate_feature(feature)
    return payload


def validate_feature(feature):
    if not isinstance(feature, dict) or feature.get("type") != "Feature":
        raise ValueError("feature must be a GeoJSON Feature")
    if not feature.get("id"):
        raise ValueError("feature must include id")
    if not isinstance(feature.get("geometry"), dict):
        raise ValueError("feature must include geometry")
    if not isinstance(feature.get("properties", {}), dict):
        raise ValueError("feature properties must be an object")
    geometry_type = feature["geometry"].get("type")
    if geometry_type not in {
        "Point",
        "LineString",
        "Polygon",
        "MultiLineString",
        "MultiPolygon",
    }:
        raise ValueError("unsupported geometry type")
    validate_geometry_coordinates(geometry_type, feature["geometry"].get("coordinates"))
    return feature


def validate_position(position):
    if (
        not isinstance(position, list)
        or len(position) < 2
        or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in position[:2])
    ):
        raise ValueError("coordinates must contain finite numeric positions")


def validate_geometry_coordinates(geometry_type, coordinates):
    if geometry_type == "MultiPolygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError("MultiPolygon must contain polygon parts")
        for polygon in coordinates:
            validate_geometry_coordinates("Polygon", polygon)
        return
    if geometry_type == "Point":
        validate_position(coordinates)
        return
    if geometry_type == "LineString":
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            raise ValueError("LineString must contain at least two positions")
        for position in coordinates:
            validate_position(position)
        return
    if geometry_type == "MultiLineString":
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError("MultiLineString must contain line parts")
        for line in coordinates:
            validate_geometry_coordinates("LineString", line)
        return
    if geometry_type == "Polygon":
        if (
            not isinstance(coordinates, list)
            or not coordinates
            or any(not isinstance(ring, list) or len(ring) < 4 for ring in coordinates)
        ):
            raise ValueError("Polygon must contain rings with at least four positions")
        for ring in coordinates:
            for position in ring:
                validate_position(position)
            if ring[0][:2] != ring[-1][:2]:
                raise ValueError("Polygon rings must be closed")
        return
    raise ValueError("unsupported geometry type")


def normalise_feature_collection(payload):
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError("features must be a list")
    seen_ids = set()
    for feature in features:
        if not isinstance(feature, dict):
            raise ValueError("each item in features must be a GeoJSON Feature")
        feature.setdefault("id", f"ft-{uuid.uuid4().hex[:10]}")
        while feature["id"] in seen_ids:
            feature["id"] = f"ft-{uuid.uuid4().hex[:10]}"
        feature.setdefault("properties", {})
        seen_ids.add(feature["id"])
    validate_feature_collection(payload)
    return payload


def iter_positions(value):
    if isinstance(value, list):
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            yield value
            return
        for child in value:
            yield from iter_positions(child)


def calculate_bbox(payload):
    positions = []
    for feature in payload.get("features", []):
        geometry = feature.get("geometry") or {}
        positions.extend(iter_positions(geometry.get("coordinates", [])))
    if not positions:
        return None
    return [
        min(position[0] for position in positions),
        min(position[1] for position in positions),
        max(position[0] for position in positions),
        max(position[1] for position in positions),
    ]


EARTH_RADIUS_M = 6371008.8
BUFFER_CIRCLE_STEPS = 48


def geometry_positions(geometry):
    return list(iter_positions((geometry or {}).get("coordinates", [])))


def dataset_is_geographic(dataset, payload):
    bbox = calculate_bbox(payload)
    if not bbox or bbox[0] < -180 or bbox[2] > 180 or bbox[1] < -90 or bbox[3] > 90:
        return False
    crs_name = str(dataset.get("crs") or "Unknown")
    return crs_name == "Unknown" or bool(re.search(r"WGS[ _]?84|EPSG:?4326|CRS:?84", crs_name, re.I))


def map_coordinates(value, transform):
    if isinstance(value, list) and len(value) >= 2 and all(
        isinstance(item, (int, float)) for item in value[:2]
    ):
        return transform(value)
    if isinstance(value, list):
        return [map_coordinates(item, transform) for item in value]
    raise ValueError("invalid geometry coordinates")


def local_projection_center(geometry):
    positions = geometry_positions(geometry)
    if not positions:
        raise ValueError("geometry has no coordinates")
    longitude = math.radians(sum(point[0] for point in positions) / len(positions))
    latitude = math.radians(sum(point[1] for point in positions) / len(positions))
    return longitude, latitude


def azimuthal_equidistant_forward(point, center):
    longitude, latitude = math.radians(point[0]), math.radians(point[1])
    lon0, lat0 = center
    delta_lon = longitude - lon0
    cosine_c = max(-1.0, min(1.0,
        math.sin(lat0) * math.sin(latitude) +
        math.cos(lat0) * math.cos(latitude) * math.cos(delta_lon)
    ))
    angular_distance = math.acos(cosine_c)
    if angular_distance < 1e-12:
        return [0.0, 0.0]
    sine_c = math.sin(angular_distance)
    scale = angular_distance / sine_c if abs(sine_c) > 1e-12 else 1.0
    x = EARTH_RADIUS_M * scale * math.cos(latitude) * math.sin(delta_lon)
    y = EARTH_RADIUS_M * scale * (
        math.cos(lat0) * math.sin(latitude) -
        math.sin(lat0) * math.cos(latitude) * math.cos(delta_lon)
    )
    return [x, y]


def azimuthal_equidistant_inverse(point, center):
    x, y = point[:2]
    lon0, lat0 = center
    distance = math.hypot(x, y)
    if distance < 1e-9:
        return [math.degrees(lon0), math.degrees(lat0)]
    angular_distance = distance / EARTH_RADIUS_M
    sine_c, cosine_c = math.sin(angular_distance), math.cos(angular_distance)
    latitude = math.asin(
        cosine_c * math.sin(lat0) + y * sine_c * math.cos(lat0) / distance
    )
    longitude = lon0 + math.atan2(
        x * sine_c,
        distance * math.cos(lat0) * cosine_c - y * math.sin(lat0) * sine_c,
    )
    return [math.degrees(longitude), math.degrees(latitude)]


def cross_2d(a, b):
    return a[0] * b[1] - a[1] * b[0]


def subtract_2d(a, b):
    return [a[0] - b[0], a[1] - b[1]]


def unit_vector(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    if length < 1e-9:
        raise ValueError("buffer input contains a zero-length segment")
    return [dx / length, dy / length]


def line_intersection(p, direction_a, q, direction_b):
    denominator = cross_2d(direction_a, direction_b)
    if abs(denominator) < 1e-10:
        return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
    amount = cross_2d(subtract_2d(q, p), direction_b) / denominator
    return [p[0] + amount * direction_a[0], p[1] + amount * direction_a[1]]


def sample_arc(center, start, end, direction, max_step=math.pi / 12, forced_delta=None):
    start_angle = math.atan2(start[1] - center[1], start[0] - center[0])
    end_angle = math.atan2(end[1] - center[1], end[0] - center[0])
    if forced_delta is None:
        delta = (end_angle - start_angle) % (2 * math.pi)
        if direction < 0:
            delta = -((start_angle - end_angle) % (2 * math.pi))
    else:
        delta = forced_delta
    radius = math.hypot(start[0] - center[0], start[1] - center[1])
    steps = max(1, int(math.ceil(abs(delta) / max_step)))
    return [
        [center[0] + radius * math.cos(start_angle + delta * index / steps),
         center[1] + radius * math.sin(start_angle + delta * index / steps)]
        for index in range(steps + 1)
    ]


def offset_polyline_side(points, distance, side):
    directions = [unit_vector(points[index], points[index + 1]) for index in range(len(points) - 1)]
    normals = [[-direction[1] * side, direction[0] * side] for direction in directions]
    result = [[points[0][0] + normals[0][0] * distance,
               points[0][1] + normals[0][1] * distance]]
    for index in range(1, len(points) - 1):
        previous, following = directions[index - 1], directions[index]
        turn = cross_2d(previous, following)
        before = [points[index][0] + normals[index - 1][0] * distance,
                  points[index][1] + normals[index - 1][1] * distance]
        after = [points[index][0] + normals[index][0] * distance,
                 points[index][1] + normals[index][1] * distance]
        if turn * side < -1e-10:
            arc = sample_arc(points[index], before, after, 1 if turn > 0 else -1)
            result.extend(arc[1:])
        else:
            join = line_intersection(before, previous, after, following)
            if math.hypot(join[0] - points[index][0], join[1] - points[index][1]) > distance * 12:
                result.extend([before, after])
            else:
                result.append(join)
    result.append([points[-1][0] + normals[-1][0] * distance,
                   points[-1][1] + normals[-1][1] * distance])
    return result, directions


def buffer_line_string(points, distance):
    if len(points) < 2:
        raise ValueError("line buffer requires at least two coordinates")
    left, directions = offset_polyline_side(points, distance, 1)
    right, _ = offset_polyline_side(points, distance, -1)
    end_direction = directions[-1]
    end_left = left[-1]
    end_right = right[-1]
    end_cap = sample_arc(
        points[-1], end_left, end_right, -1, forced_delta=-math.pi
    )
    start_direction = directions[0]
    start_right = right[0]
    start_left = left[0]
    start_cap = sample_arc(
        points[0], start_right, start_left, -1, forced_delta=-math.pi
    )
    ring = left + end_cap[1:] + list(reversed(right[:-1])) + start_cap[1:-1]
    if ring[0] != ring[-1]:
        ring.append(ring[0][:])
    return ring


def signed_ring_area(ring):
    return sum(
        ring[index - 1][0] * ring[index][1] - ring[index][0] * ring[index - 1][1]
        for index in range(1, len(ring))
    ) / 2


def offset_ring(ring, distance):
    points = ring[:-1] if ring[0][:2] == ring[-1][:2] else ring[:]
    if len(points) < 3:
        raise ValueError("polygon ring requires at least three distinct coordinates")
    orientation = 1 if signed_ring_area(points + [points[0]]) >= 0 else -1
    result = []
    for index, point in enumerate(points):
        previous = points[index - 1]
        following = points[(index + 1) % len(points)]
        incoming = unit_vector(previous, point)
        outgoing = unit_vector(point, following)
        normal_in = [incoming[1] * orientation, -incoming[0] * orientation]
        normal_out = [outgoing[1] * orientation, -outgoing[0] * orientation]
        before = [point[0] + normal_in[0] * distance,
                  point[1] + normal_in[1] * distance]
        after = [point[0] + normal_out[0] * distance,
                 point[1] + normal_out[1] * distance]
        turn = cross_2d(incoming, outgoing)
        if turn * orientation * distance > 1e-10:
            arc = sample_arc(point, before, after, orientation)
            result.extend(arc[:-1])
        else:
            join = line_intersection(before, incoming, after, outgoing)
            if math.hypot(join[0] - point[0], join[1] - point[1]) > abs(distance) * 12:
                result.extend([before, after])
            else:
                result.append(join)
    if len(result) < 3:
        raise ValueError("buffer distance collapses this polygon")
    result.append(result[0][:])
    if abs(signed_ring_area(result)) < 1e-8 or signed_ring_area(result) * signed_ring_area(ring) <= 0:
        raise ValueError("buffer distance collapses this polygon")
    return result


def buffer_polygon(polygon, distance):
    if not polygon or not polygon[0]:
        raise ValueError("polygon buffer requires an exterior ring")
    result = [offset_ring(polygon[0], distance)]
    for hole in polygon[1:]:
        try:
            result.append(offset_ring(hole, -distance))
        except ValueError:
            # A narrow hole may disappear when the positive buffer closes it.
            continue
    return result


def buffer_geometry(geometry, distance):
    kind = geometry.get("type")
    coords = geometry.get("coordinates")
    if kind == "Point":
        x, y = coords[:2]
        ring = [
            [x + distance * math.cos(2 * math.pi * index / BUFFER_CIRCLE_STEPS),
             y + distance * math.sin(2 * math.pi * index / BUFFER_CIRCLE_STEPS)]
            for index in range(BUFFER_CIRCLE_STEPS)
        ]
        ring.append(ring[0][:])
        return {"type": "Polygon", "coordinates": [ring]}
    if kind == "LineString":
        return {"type": "Polygon", "coordinates": [buffer_line_string(coords, distance)]}
    if kind == "MultiLineString":
        return {
            "type": "MultiPolygon",
            "coordinates": [[buffer_line_string(line, distance)] for line in coords],
        }
    if kind == "Polygon":
        return {"type": "Polygon", "coordinates": buffer_polygon(coords, distance)}
    if kind == "MultiPolygon":
        return {"type": "MultiPolygon", "coordinates": [buffer_polygon(poly, distance) for poly in coords]}
    raise ValueError(f"buffer does not support geometry type {kind}")


def geometries_intersect(first, second):
    def collect(geometry):
        kind, coordinates = geometry["type"], geometry["coordinates"]
        points, lines, polygons = [], [], []
        if kind == "Point":
            points.append(coordinates[:2])
        elif kind == "LineString":
            lines.append(coordinates)
        elif kind == "MultiLineString":
            lines.extend(coordinates)
        elif kind == "Polygon":
            polygons.append(coordinates)
            lines.extend(coordinates)
        elif kind == "MultiPolygon":
            polygons.extend(coordinates)
            lines.extend(ring for polygon in coordinates for ring in polygon)
        else:
            raise ValueError(f"intersection query does not support geometry type {kind}")
        points.extend(point for line in lines for point in line)
        return points, lines, polygons

    def orientation(a, b, c):
        return cross_2d(subtract_2d(b, a), subtract_2d(c, a))

    def on_segment(point, a, b):
        return abs(orientation(a, b, point)) <= 1e-10 and (
            min(a[0], b[0]) - 1e-10 <= point[0] <= max(a[0], b[0]) + 1e-10 and
            min(a[1], b[1]) - 1e-10 <= point[1] <= max(a[1], b[1]) + 1e-10
        )

    def segments_intersect(a, b, c, d):
        o1, o2 = orientation(a, b, c), orientation(a, b, d)
        o3, o4 = orientation(c, d, a), orientation(c, d, b)
        if ((o1 > 1e-10 and o2 < -1e-10) or (o1 < -1e-10 and o2 > 1e-10)) and \
           ((o3 > 1e-10 and o4 < -1e-10) or (o3 < -1e-10 and o4 > 1e-10)):
            return True
        return (abs(o1) <= 1e-10 and on_segment(c, a, b)) or \
            (abs(o2) <= 1e-10 and on_segment(d, a, b)) or \
            (abs(o3) <= 1e-10 and on_segment(a, c, d)) or \
            (abs(o4) <= 1e-10 and on_segment(b, c, d))

    def point_in_ring(point, ring):
        inside = False
        for index in range(len(ring) - 1):
            a, b = ring[index], ring[index + 1]
            if on_segment(point, a, b):
                return True
            if (a[1] > point[1]) != (b[1] > point[1]):
                crossing_x = (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
                if point[0] < crossing_x:
                    inside = not inside
        return inside

    def point_in_polygon(point, polygon):
        return bool(polygon and point_in_ring(point, polygon[0]) and
                    not any(point_in_ring(point, hole) for hole in polygon[1:]))

    points_a, lines_a, polygons_a = collect(first)
    points_b, lines_b, polygons_b = collect(second)
    for line_a in lines_a:
        for line_b in lines_b:
            if any(segments_intersect(a, b, c, d)
                   for a, b in zip(line_a, line_a[1:])
                   for c, d in zip(line_b, line_b[1:])):
                return True
    for point in points_a:
        if any(on_segment(point, a, b) for line in lines_b for a, b in zip(line, line[1:])):
            return True
        if any(point_in_polygon(point, polygon) for polygon in polygons_b):
            return True
    for point in points_b:
        if any(on_segment(point, a, b) for line in lines_a for a, b in zip(line, line[1:])):
            return True
        if any(point_in_polygon(point, polygon) for polygon in polygons_a):
            return True
    return any(point_in_polygon(point, polygon) for point in points_a for polygon in polygons_b) or \
        any(point_in_polygon(point, polygon) for point in points_b for polygon in polygons_a)


def planar_line_length(points):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1])
               for a, b in zip(points, points[1:]))


def geodesic_segment_length(first, second):
    longitude_a, latitude_a = math.radians(first[0]), math.radians(first[1])
    longitude_b, latitude_b = math.radians(second[0]), math.radians(second[1])
    delta_latitude = latitude_b - latitude_a
    delta_longitude = longitude_b - longitude_a
    haversine = math.sin(delta_latitude / 2) ** 2 + math.cos(latitude_a) * math.cos(latitude_b) * math.sin(delta_longitude / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(haversine)))


def geodesic_line_length(points):
    return sum(geodesic_segment_length(a, b) for a, b in zip(points, points[1:]))


def planar_ring_area(ring):
    return abs(sum(
        ring[index - 1][0] * ring[index][1] - ring[index][0] * ring[index - 1][1]
        for index in range(1, len(ring))
    ) / 2)


def geodesic_ring_area(ring):
    area = 0.0
    for first, second in zip(ring, ring[1:]):
        longitude_delta = math.radians(second[0] - first[0])
        while longitude_delta > math.pi:
            longitude_delta -= 2 * math.pi
        while longitude_delta < -math.pi:
            longitude_delta += 2 * math.pi
        area += longitude_delta * (2 + math.sin(math.radians(first[1])) + math.sin(math.radians(second[1])))
    return abs(area * EARTH_RADIUS_M ** 2 / 2)


def geometry_length(geometry, geographic=False):
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates")
    measure_line = geodesic_line_length if geographic else planar_line_length
    if kind == "Point":
        return 0.0
    if kind == "LineString":
        return measure_line(coordinates)
    if kind == "MultiLineString":
        return sum(measure_line(line) for line in coordinates)
    if kind == "Polygon":
        return sum(measure_line(ring) for ring in coordinates)
    if kind == "MultiPolygon":
        return sum(measure_line(ring) for polygon in coordinates for ring in polygon)
    raise ValueError(f"distance does not support geometry type {kind}")


def geometry_area(geometry, geographic=False):
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates")
    measure_ring = geodesic_ring_area if geographic else planar_ring_area
    if kind == "Polygon":
        if not coordinates:
            return 0.0
        return max(0.0, measure_ring(coordinates[0]) - sum(measure_ring(ring) for ring in coordinates[1:]))
    if kind == "MultiPolygon":
        return sum(geometry_area({"type": "Polygon", "coordinates": polygon}, geographic) for polygon in coordinates)
    raise ValueError(f"area does not support geometry type {kind}")


def resolve_analysis_feature(data, feature_id):
    if not feature_id:
        raise ValueError("feature_id is required")
    for feature in data.get("features", []):
        if str(feature.get("id")) == str(feature_id):
            return feature
    raise KeyError(f"feature not found: {feature_id}")


def analysis_geometry(payload, data):
    feature_id = payload.get("feature_id")
    if feature_id:
        return resolve_analysis_feature(data, feature_id)["geometry"], feature_id
    geometry = payload.get("geometry")
    if not isinstance(geometry, dict):
        raise ValueError("feature_id or geometry is required")
    validate_feature({"type": "Feature", "id": "analysis-input", "geometry": geometry, "properties": {}})
    return geometry, None


def dataset_summary(
    dataset_id,
    file_name,
    payload,
    size_bytes,
    path_name,
    created_at=None,
    source_format="GeoJSON",
    crs_name=None,
    source_note=None,
):
    validate_feature_collection(payload)
    geometry_types = sorted(
        {
            feature.get("geometry", {}).get("type", "Unknown")
            for feature in payload.get("features", [])
        }
    )
    return {
        "id": dataset_id,
        "name": Path(file_name).stem or "未命名数据",
        "file_name": file_name,
        "format": source_format,
        "feature_count": len(payload.get("features", [])),
        "geometry_types": geometry_types,
        "bbox": calculate_bbox(payload),
        "size_bytes": size_bytes,
        "created_at": created_at or utc_now(),
        "path": path_name,
        "crs": crs_name or "Unknown",
        "source_note": source_note or "坐标系未提供",
    }


def decode_dbf_value(raw_value, field_type, encoding="utf-8"):
    text_bytes = raw_value.rstrip(b" \x00")
    try:
        text = text_bytes.decode(encoding).strip()
    except UnicodeDecodeError:
        text = text_bytes.decode("gbk", errors="replace").strip()
    if not text:
        return None
    if field_type in {"N", "F"}:
        try:
            return float(text) if "." in text else int(text)
        except ValueError:
            return text
    if field_type == "L":
        return text.upper() in {"Y", "T", "1"}
    return text


def read_cpg_encoding(cpg_bytes):
    label = cpg_bytes.decode("ascii", errors="ignore").strip().lower()
    aliases = {
        "utf-8": "utf-8",
        "utf8": "utf-8",
        "65001": "utf-8",
        "gbk": "gbk",
        "936": "gbk",
        "gb2312": "gbk",
    }
    return aliases.get(label, "utf-8")


def read_dbf_records(dbf_bytes, encoding="utf-8"):
    if len(dbf_bytes) < 33:
        raise ValueError("DBF file is too short")
    record_count = struct.unpack_from("<I", dbf_bytes, 4)[0]
    header_length = struct.unpack_from("<H", dbf_bytes, 8)[0]
    record_length = struct.unpack_from("<H", dbf_bytes, 10)[0]
    fields = []
    offset = 32
    while offset + 32 <= header_length and dbf_bytes[offset] != 0x0D:
        descriptor = dbf_bytes[offset : offset + 32]
        field_name = descriptor[:11].split(b"\x00", 1)[0].decode(encoding, errors="replace")
        fields.append((field_name or f"field_{len(fields) + 1}", chr(descriptor[11]), descriptor[16]))
        offset += 32
    if record_length < 1:
        raise ValueError("DBF record length is invalid")

    records = []
    for index in range(record_count):
        start = header_length + index * record_length
        record = dbf_bytes[start : start + record_length]
        if len(record) != record_length:
            raise ValueError("DBF records are truncated")
        if record[:1] == b"*":
            records.append(None)
            continue
        cursor = 1
        properties = {}
        for name, field_type, field_length in fields:
            properties[name] = decode_dbf_value(
                record[cursor : cursor + field_length],
                field_type,
                encoding,
            )
            cursor += field_length
        records.append(properties)
    return records


def split_shape_parts(parts, points):
    result = []
    for index, start in enumerate(parts):
        end = parts[index + 1] if index + 1 < len(parts) else len(points)
        result.append([[float(x), float(y)] for x, y in points[start:end]])
    return result


def read_shp_records(shp_bytes):
    if len(shp_bytes) < 100:
        raise ValueError("SHP file is too short")
    declared_type = struct.unpack_from("<i", shp_bytes, 32)[0]
    features = []
    offset = 100
    while offset < len(shp_bytes):
        if offset + 8 > len(shp_bytes):
            raise ValueError("SHP record header is truncated")
        record_number, content_words = struct.unpack_from(">ii", shp_bytes, offset)
        content_start = offset + 8
        content_end = content_start + content_words * 2
        if content_end > len(shp_bytes):
            raise ValueError(f"SHP record {record_number} is truncated")
        record_type = struct.unpack_from("<i", shp_bytes, content_start)[0]
        if record_type == 0:
            features.append(None)
            offset = content_end
            continue
        if record_type == 1:
            x, y = struct.unpack_from("<dd", shp_bytes, content_start + 4)
            geometry = {"type": "Point", "coordinates": [x, y]}
        elif record_type in {3, 5}:
            if content_start + 44 > content_end:
                raise ValueError(f"SHP record {record_number} has an invalid header")
            part_count, point_count = struct.unpack_from("<ii", shp_bytes, content_start + 36)
            if part_count == 0 and point_count == 0:
                features.append(None)
                offset = content_end
                continue
            if part_count < 1 or point_count < 2:
                raise ValueError(f"SHP record {record_number} has invalid coordinates")
            parts_offset = content_start + 44
            points_offset = parts_offset + part_count * 4
            expected_end = points_offset + point_count * 16
            if expected_end > content_end:
                raise ValueError(f"SHP record {record_number} coordinate data is truncated")
            parts = list(struct.unpack_from(f"<{part_count}i", shp_bytes, parts_offset))
            points = [
                struct.unpack_from("<dd", shp_bytes, points_offset + point_index * 16)
                for point_index in range(point_count)
            ]
            components = split_shape_parts(parts, points)
            if record_type == 3:
                geometry = {
                    "type": "LineString" if len(components) == 1 else "MultiLineString",
                    "coordinates": components[0] if len(components) == 1 else components,
                }
            else:
                rings = [ring for ring in components if len(ring) >= 4]
                if not rings:
                    raise ValueError(f"SHP record {record_number} has no valid polygon rings")
                for ring in rings:
                    if ring[0] != ring[-1]:
                        ring.append(ring[0][:])
                # The simple renderer and demo store rings as independent polygon parts.
                geometry = {
                    "type": "Polygon" if len(rings) == 1 else "MultiPolygon",
                    "coordinates": rings if len(rings) == 1 else [[ring] for ring in rings],
                }
        else:
            raise ValueError(f"unsupported Shapefile geometry type: {record_type}")
        features.append({"type": "Feature", "geometry": geometry, "properties": {}})
        offset = content_end
    if declared_type not in {1, 3, 5, 8, 11, 13, 15, 18}:
        raise ValueError(f"unsupported Shapefile geometry type: {declared_type}")
    return declared_type, features


def is_usable_archive_member(item):
    path = Path(item.filename)
    parts = {part.lower() for part in path.parts}
    return (
        not item.is_dir()
        and path.name.lower() not in {".ds_store"}
        and not path.name.startswith("._")
        and "__macosx" not in parts
    )


def convert_shapefile_zip(file_name, zip_bytes):
    if not zipfile.is_zipfile(io.BytesIO(zip_bytes)):
        raise ValueError("invalid ZIP archive")
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        members = [item for item in archive.infolist() if is_usable_archive_member(item)]
        if len(members) > MAX_ZIP_MEMBERS:
            raise ValueError(f"Shapefile ZIP cannot contain more than {MAX_ZIP_MEMBERS} files")
        if any(item.file_size > MAX_IMPORT_BYTES for item in members):
            raise ValueError(f"an extracted Shapefile component exceeds the {MAX_IMPORT_BYTES // (1024 * 1024)} MB limit")
        shp_files = [item for item in members if Path(item.filename).suffix.lower() == ".shp"]
        if not shp_files:
            geojson_files = [
                item
                for item in members
                if Path(item.filename).suffix.lower() in {".geojson", ".json"}
            ]
            if len(geojson_files) == 1:
                try:
                    payload = json.loads(archive.read(geojson_files[0]).decode("utf-8-sig"))
                    return (
                        normalise_feature_collection(payload),
                        None,
                        Path(geojson_files[0].filename).name,
                        "GeoJSON",
                    )
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ValueError("ZIP 内的 GeoJSON/JSON 文件无法读取") from exc
            if len(geojson_files) > 1:
                raise ValueError("ZIP 中包含多个 GeoJSON/JSON 文件，请只保留一个数据文件")
            raise ValueError("ZIP 中没有找到 .shp 文件；请压缩同名的 .shp/.dbf/.prj 文件")
        if len(shp_files) != 1:
            raise ValueError("ZIP 中必须只包含一个 Shapefile 图层（一个 .shp 文件）")
        shp_item = shp_files[0]
        stem = Path(shp_item.filename).stem.lower()
        matching = {
            Path(item.filename).suffix.lower(): item
            for item in members
            if Path(item.filename).stem.lower() == stem
        }
        shp_type, raw_features = read_shp_records(archive.read(shp_item))
        if shp_type not in {1, 3, 5}:
            raise ValueError("this demo supports Point, PolyLine, and Polygon Shapefiles")
        dbf_encoding = "utf-8"
        if matching.get(".cpg"):
            dbf_encoding = read_cpg_encoding(archive.read(matching[".cpg"]))
        if matching.get(".dbf"):
            dbf_records = read_dbf_records(archive.read(matching[".dbf"]), dbf_encoding)
            if len(dbf_records) != len(raw_features):
                raise ValueError("DBF record count does not match SHP feature count")
            for feature, properties in zip(raw_features, dbf_records):
                if feature is not None:
                    feature["properties"] = properties or {}

        features = [feature for feature in raw_features if feature is not None]
        payload = normalise_feature_collection({"type": "FeatureCollection", "features": features})
        prj_item = matching.get(".prj")
        crs_text = archive.read(prj_item).decode("utf-8", errors="replace") if prj_item else ""
        crs_name = None
        if crs_text:
            crs_name = "PRJ attached"
            if "WGS_1984" in crs_text or "WGS 84" in crs_text:
                crs_name = "WGS 84 (detected from .prj)"
        return payload, crs_name, Path(shp_item.filename).name, "Shapefile"


def convert_shapefile_parts(file_name, main_bytes, sidecars):
    base_name = Path(file_name).stem.lower()
    files = {Path(name).suffix.lower(): content for name, content in sidecars.items()}
    files[".shp"] = main_bytes
    if ".shx" not in files or ".dbf" not in files:
        raise ValueError("Shapefile import requires matching .shx and .dbf files")
    shape_type, raw_features = read_shp_records(main_bytes)
    if shape_type not in {1, 3, 5}:
        raise ValueError("this demo supports Point, PolyLine, and Polygon Shapefiles")
    encoding = read_cpg_encoding(files[".cpg"]) if ".cpg" in files else "utf-8"
    dbf_records = read_dbf_records(files[".dbf"], encoding)
    if len(dbf_records) != len(raw_features):
        raise ValueError("DBF record count does not match SHP feature count")
    for feature, properties in zip(raw_features, dbf_records):
        if feature is not None:
            feature["properties"] = properties or {}
    features = [feature for feature in raw_features if feature is not None]
    payload = normalise_feature_collection({"type": "FeatureCollection", "features": features})
    crs_name = None
    if ".prj" in files:
        crs_text = files[".prj"].decode("utf-8", errors="replace")
        crs_name = "PRJ attached"
        if "WGS_1984" in crs_text or "WGS 84" in crs_text:
            crs_name = "WGS 84 (detected from .prj)"
    return payload, crs_name, f"{base_name}.shp"


def write_json_atomic(path, payload):
    temp_file = path.with_suffix(".tmp")
    temp_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_file.replace(path)


def ensure_storage():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text(json.dumps(SAMPLE_DATA, ensure_ascii=False, indent=2), encoding="utf-8")

    if not CATALOG_FILE.exists():
        initial_payload = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        initial = dataset_summary(
            "features",
            "features.geojson",
            initial_payload,
            DATA_FILE.stat().st_size,
            "features.geojson",
        )
        write_json_atomic(CATALOG_FILE, {"datasets": [initial]})

    catalog = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    if not catalog.get("datasets"):
        raise ValueError("dataset catalog cannot be empty")
    known_ids = {dataset["id"] for dataset in catalog["datasets"]}
    if not ACTIVE_DATASET_FILE.exists():
        write_json_atomic(ACTIVE_DATASET_FILE, {"active_id": catalog["datasets"][0]["id"]})
        return
    active_id = json.loads(ACTIVE_DATASET_FILE.read_text(encoding="utf-8")).get("active_id")
    if active_id not in known_ids:
        write_json_atomic(ACTIVE_DATASET_FILE, {"active_id": catalog["datasets"][0]["id"]})


def read_catalog():
    ensure_storage()
    return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))


def write_catalog(catalog):
    write_json_atomic(CATALOG_FILE, catalog)


def get_active_id():
    ensure_storage()
    return json.loads(ACTIVE_DATASET_FILE.read_text(encoding="utf-8"))["active_id"]


def set_active_id(dataset_id):
    write_json_atomic(ACTIVE_DATASET_FILE, {"active_id": dataset_id})


def find_dataset(dataset_id):
    for dataset in read_catalog()["datasets"]:
        if dataset["id"] == dataset_id:
            return dataset
    raise KeyError(f"dataset not found: {dataset_id}")


def dataset_path(dataset):
    path = (DATA_DIR / dataset["path"]).resolve()
    if DATA_DIR.resolve() not in path.parents:
        raise ValueError("invalid dataset storage path")
    return path


def read_dataset(dataset_id=None):
    dataset = find_dataset(dataset_id or get_active_id())
    path = dataset_path(dataset)
    payload = json.loads(path.read_text(encoding="utf-8"))
    validate_feature_collection(payload)
    return dataset, payload


def update_dataset_metadata(dataset_id, payload, file_size=None):
    catalog = read_catalog()
    for index, dataset in enumerate(catalog["datasets"]):
        if dataset["id"] == dataset_id:
            target = dataset_path(dataset)
            catalog["datasets"][index] = dataset_summary(
                dataset_id,
                dataset["file_name"],
                payload,
                file_size if file_size is not None else target.stat().st_size,
                dataset["path"],
                dataset.get("created_at"),
                dataset.get("format", "GeoJSON"),
                dataset.get("crs"),
                dataset.get("source_note"),
            )
            write_catalog(catalog)
            return catalog["datasets"][index]
    raise KeyError(f"dataset not found: {dataset_id}")


def write_geojson(payload, dataset_id=None):
    payload = normalise_feature_collection(payload)
    dataset_id = dataset_id or get_active_id()
    dataset = find_dataset(dataset_id)
    target = dataset_path(dataset)
    write_json_atomic(target, payload)
    update_dataset_metadata(dataset_id, payload, target.stat().st_size)


def read_geojson():
    return read_dataset()[1]


class GisDemoHandler(SimpleHTTPRequestHandler):
    server_version = "GisVectorDemo/0.3"

    def translate_path(self, path):
        clean_path = urlsplit(path).path
        if clean_path == "/":
            return str(STATIC_DIR / "index.html")
        if clean_path.startswith("/static/"):
            requested = (ROOT / clean_path.lstrip("/")).resolve()
            if STATIC_DIR.resolve() not in requested.parents:
                return str(STATIC_DIR / "index.html")
            return str(requested)
        return str(STATIC_DIR / clean_path.lstrip("/"))

    def log_message(self, fmt, *args):
        sys.stderr.write("[gis-demo] " + fmt % args + "\n")

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=400):
        self.send_json({"ok": False, "error": message}, status=status)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_REQUEST_BYTES:
            raise ValueError(f"request body cannot exceed {MAX_REQUEST_BYTES // (1024 * 1024)} MB")
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(raw or "{}")

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/layers":
            self.send_json(read_geojson())
            return

        if path == "/api/export":
            active_dataset, payload = read_dataset()
            body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/geo+json; charset=utf-8")
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{active_dataset["id"]}-export.geojson"',
            )
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/datasets":
            active_id = get_active_id()
            self.send_json(
                {
                    "ok": True,
                    "active_id": active_id,
                    "datasets": [
                        {**dataset, "active": dataset["id"] == active_id}
                        for dataset in read_catalog()["datasets"]
                    ],
                }
            )
            return

        if path.startswith("/api/datasets/"):
            dataset_id = unquote(remove_prefix(path, "/api/datasets/")).strip("/")
            if dataset_id:
                dataset, payload = read_dataset(dataset_id)
                self.send_json({"ok": True, "dataset": dataset, "data": payload})
                return

        if path == "/api/status":
            active_dataset, _ = read_dataset()
            catalog = read_catalog()
            self.send_json(
                {
                    "ok": True,
                    "storage": f"data/{active_dataset['path']}",
                    "backend": "Python http.server",
                    "active_dataset": active_dataset["name"],
                    "dataset_count": len(catalog["datasets"]),
                    "geojson": "已接入",
                    "postgis": "未接入",
                    "shapefile": "已接入（ZIP/成套文件转 GeoJSON）",
                }
            )
            return

        return super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            if path == "/api/spatial/measure":
                request = self.read_json_body()
                operation = str(request.get("operation") or "").lower()
                dataset, data = read_dataset()
                geometry, feature_id = analysis_geometry(request, data)
                geographic = dataset_is_geographic(dataset, data)
                if operation == "distance":
                    value = geometry_length(geometry, geographic)
                    unit = "m" if geographic else "map units"
                elif operation == "area":
                    value = geometry_area(geometry, geographic)
                    unit = "m²" if geographic else "map units²"
                else:
                    raise ValueError("operation must be distance or area")
                self.send_json({
                    "ok": True,
                    "operation": operation,
                    "value": value,
                    "unit": unit,
                    "feature_id": feature_id,
                    "geographic": geographic,
                    "coordinate_system": "WGS 84 经纬度" if geographic else "平面坐标",
                })
                return

            if path == "/api/spatial/buffer":
                request = self.read_json_body()
                dataset, data = read_dataset()
                source = resolve_analysis_feature(data, request.get("feature_id"))
                try:
                    distance = float(request.get("distance"))
                except (TypeError, ValueError) as exc:
                    raise ValueError("distance must be a number") from exc
                if not math.isfinite(distance) or distance <= 0:
                    raise ValueError("distance must be greater than zero")
                if distance > 1e8:
                    raise ValueError("distance is too large")
                geographic = dataset_is_geographic(dataset, data)
                if geographic:
                    center = local_projection_center(source["geometry"])
                    projected = map_coordinates(
                        source["geometry"].get("coordinates"),
                        lambda point: azimuthal_equidistant_forward(point, center),
                    )
                    projected_geometry = {
                        "type": source["geometry"]["type"],
                        "coordinates": projected,
                    }
                    buffered_projected = buffer_geometry(projected_geometry, distance)
                    buffered_coordinates = map_coordinates(
                        buffered_projected["coordinates"],
                        lambda point: azimuthal_equidistant_inverse(point, center),
                    )
                    buffered_geometry = {
                        "type": buffered_projected["type"],
                        "coordinates": buffered_coordinates,
                    }
                    distance_unit = "m"
                else:
                    buffered_geometry = buffer_geometry(source["geometry"], distance)
                    distance_unit = "map units"
                buffer_id = f"buffer-{uuid.uuid4().hex[:10]}"
                source_name = (source.get("properties") or {}).get("name") or source["id"]
                buffer_feature = {
                    "type": "Feature",
                    "id": buffer_id,
                    "properties": {
                        "name": f"缓冲区 · {source_name}",
                        "layer": "空间分析",
                        "kind": "buffer",
                        "analysis": "buffer",
                        "source_id": source["id"],
                        "distance": distance,
                        "distance_unit": distance_unit,
                    },
                    "geometry": buffered_geometry,
                }
                validate_feature(buffer_feature)
                data["features"].append(buffer_feature)
                write_geojson(data, dataset["id"])
                self.send_json({
                    "ok": True,
                    "feature": buffer_feature,
                    "source_id": source["id"],
                    "distance": distance,
                    "unit": distance_unit,
                    "geographic": geographic,
                })
                return

            if path == "/api/spatial/intersects":
                request = self.read_json_body()
                dataset, data = read_dataset()
                source = resolve_analysis_feature(data, request.get("feature_id"))
                matches = [
                    feature for feature in data.get("features", [])
                    if feature.get("id") != source.get("id") and
                    geometries_intersect(source["geometry"], feature["geometry"])
                ]
                self.send_json({
                    "ok": True,
                    "source_id": source["id"],
                    "matches": matches,
                    "count": len(matches),
                    "coordinate_system": "WGS 84 经纬度" if dataset_is_geographic(dataset, data) else "平面坐标",
                })
                return

            if path == "/api/features":
                payload = self.read_json_body()
                active_id = get_active_id()
                data = read_geojson()
                feature = payload.get("feature")
                if not feature or feature.get("type") != "Feature":
                    self.send_error_json("feature must be a GeoJSON Feature")
                    return
                feature.setdefault("id", f"ft-{uuid.uuid4().hex[:10]}")
                feature.setdefault("properties", {})
                existing_ids = {item.get("id") for item in data["features"]}
                while feature["id"] in existing_ids:
                    feature["id"] = f"ft-{uuid.uuid4().hex[:10]}"
                validate_feature(feature)
                data["features"].append(feature)
                write_geojson(data, active_id)
                self.send_json({"ok": True, "feature": feature})
                return

            if path == "/api/save":
                payload = self.read_json_body()
                write_geojson(payload, get_active_id())
                self.send_json({"ok": True, "count": len(payload.get("features", []))})
                return

            if path == "/api/reset":
                set_active_id("features")
                write_geojson(SAMPLE_DATA, "features")
                self.send_json({"ok": True, "data": SAMPLE_DATA})
                return

            if path == "/api/datasets/import":
                payload = self.read_json_body()
                raw_content = payload.get("content")
                original_name = Path(str(payload.get("file_name") or "imported.geojson")).name
                suffix = Path(original_name).suffix.lower()
                source_format = "GeoJSON"
                crs_name = None
                source_note = "JSON 文件直接存储"
                if suffix == ".zip":
                    try:
                        zip_bytes = base64.b64decode(str(raw_content), validate=True)
                    except Exception as exc:
                        raise ValueError("invalid base64 Shapefile ZIP content") from exc
                    if len(zip_bytes) > MAX_IMPORT_BYTES:
                        raise ValueError(f"Shapefile ZIP cannot exceed {MAX_IMPORT_BYTES // (1024 * 1024)} MB")
                    geojson, crs_name, source_name, source_format = convert_shapefile_zip(original_name, zip_bytes)
                    source_note = f"从 ZIP 内的 {source_name} 读取并转换为 GeoJSON"
                elif suffix == ".shp":
                    try:
                        main_bytes = base64.b64decode(str(raw_content), validate=True)
                        if len(main_bytes) > MAX_IMPORT_BYTES:
                            raise ValueError(
                                f"Shapefile component cannot exceed {MAX_IMPORT_BYTES // (1024 * 1024)} MB"
                            )
                        sidecar_payload = payload.get("sidecars") or []
                        sidecars = {}
                        for item in sidecar_payload:
                            sidecar_name = Path(str(item.get("file_name", ""))).name
                            sidecar_content = base64.b64decode(str(item.get("content", "")), validate=True)
                            if len(sidecar_content) > MAX_IMPORT_BYTES:
                                raise ValueError(
                                    f"Shapefile component cannot exceed {MAX_IMPORT_BYTES // (1024 * 1024)} MB"
                                )
                            sidecars[sidecar_name] = sidecar_content
                        geojson, crs_name, shp_name = convert_shapefile_parts(
                            original_name,
                            main_bytes,
                            sidecars,
                        )
                    except (KeyError, TypeError, ValueError) as exc:
                        raise ValueError(f"invalid Shapefile component upload: {exc}") from exc
                    source_format = "Shapefile"
                    source_note = f"从 {shp_name} 转换为 GeoJSON"
                else:
                    if suffix not in {".geojson", ".json"}:
                        raise ValueError("only .geojson, .json, or Shapefile .zip files are supported")
                    geojson = json.loads(raw_content) if isinstance(raw_content, str) else raw_content
                    geojson = normalise_feature_collection(geojson)

                dataset_id = f"ds-{uuid.uuid4().hex[:10]}"
                stored_name = f"{dataset_id}.geojson"
                target = UPLOAD_DIR / stored_name
                write_json_atomic(target, geojson)
                imported = dataset_summary(
                    dataset_id,
                    original_name,
                    geojson,
                    target.stat().st_size,
                    f"uploads/{stored_name}",
                    source_format=source_format,
                    crs_name=crs_name,
                    source_note=source_note,
                )
                catalog = read_catalog()
                catalog["datasets"].append(imported)
                write_catalog(catalog)
                set_active_id(dataset_id)
                self.send_json({"ok": True, "dataset": {**imported, "active": True}})
                return

            if path.startswith("/api/datasets/") and path.endswith("/activate"):
                dataset_id = unquote(remove_suffix(remove_prefix(path, "/api/datasets/"), "/activate")).strip("/")
                find_dataset(dataset_id)
                set_active_id(dataset_id)
                dataset, data = read_dataset(dataset_id)
                self.send_json({"ok": True, "dataset": dataset, "data": data})
                return

            self.send_error_json("unknown endpoint", status=404)
        except json.JSONDecodeError as exc:
            self.send_error_json(f"invalid JSON: {exc}", status=400)
        except KeyError as exc:
            self.send_error_json(str(exc), status=404)
        except ValueError as exc:
            self.send_error_json(str(exc), status=400)
        except Exception as exc:
            status = 404 if isinstance(exc, KeyError) else 400 if isinstance(exc, ValueError) else 500
            self.send_error_json(str(exc), status=status)

    def do_DELETE(self):
        path = urlsplit(self.path).path
        try:
            if path.startswith("/api/datasets/"):
                dataset_id = unquote(remove_prefix(path, "/api/datasets/")).strip("/")
                catalog = read_catalog()
                if len(catalog["datasets"]) <= 1:
                    self.send_error_json("至少保留一个数据集", status=409)
                    return
                if dataset_id == get_active_id():
                    self.send_error_json("请先切换到其他数据集，再删除当前数据集", status=409)
                    return
                dataset = find_dataset(dataset_id)
                target = dataset_path(dataset)
                if target.exists():
                    target.unlink()
                catalog["datasets"] = [item for item in catalog["datasets"] if item["id"] != dataset_id]
                write_catalog(catalog)
                self.send_json({"ok": True, "deleted": dataset_id})
                return

            feature_id = self.feature_id_from_path()
            if not feature_id:
                self.send_error_json("unknown endpoint", status=404)
                return
            data = read_geojson()
            remaining = [item for item in data["features"] if str(item.get("id")) != feature_id]
            if len(remaining) == len(data["features"]):
                self.send_error_json("feature not found", status=404)
                return
            data["features"] = remaining
            write_geojson(data)
            self.send_json({"ok": True, "id": feature_id})
        except Exception as exc:
            status = 404 if isinstance(exc, KeyError) else 400 if isinstance(exc, ValueError) else 500
            self.send_error_json(str(exc), status=status)

    def do_PUT(self):
        try:
            feature_id = self.feature_id_from_path()
            if not feature_id:
                self.send_error_json("feature id is required", status=404)
                return
            payload = self.read_json_body()
            feature = payload.get("feature")
            if not isinstance(feature, dict):
                self.send_error_json("feature is required")
                return
            feature["id"] = feature_id
            validate_feature(feature)
            data = read_geojson()
            for index, current in enumerate(data["features"]):
                if str(current.get("id")) == feature_id:
                    data["features"][index] = feature
                    write_geojson(data)
                    self.send_json({"ok": True, "feature": feature})
                    return
            self.send_error_json("feature not found", status=404)
        except Exception as exc:
            status = 404 if isinstance(exc, KeyError) else 400 if isinstance(exc, ValueError) else 500
            self.send_error_json(str(exc), status=status)

    def feature_id_from_path(self):
        path = urlsplit(self.path).path
        prefix = "/api/features/"
        if not path.startswith(prefix):
            return None
        feature_id = unquote(path[len(prefix):]).strip()
        return feature_id or None


def main():
    ensure_storage()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer(("127.0.0.1", port), GisDemoHandler)
    print(f"GIS demo running at http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
