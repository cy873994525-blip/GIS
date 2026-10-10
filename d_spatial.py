# D group GIS spatial analysis extension. Works with Python 3.8+ standard library.
# This file extends the existing server.py without replacing any A/B/C group code.
import json
import math
import re
import uuid
from urllib.parse import urlsplit

EARTH_RADIUS_M = 6371008.8
BUFFER_CIRCLE_STEPS = 48

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


def geometry_positions(geometry):
    return list(iter_positions((geometry or {}).get("coordinates", [])))


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



def dataset_is_geographic(dataset, payload):
    """Use metadata first; never treat a declared projected CRS as longitude/latitude."""
    bbox = calculate_bbox(payload)
    if bbox is None or not (-180 <= bbox[0] <= bbox[2] <= 180 and
                            -90 <= bbox[1] <= bbox[3] <= 90):
        return False
    kind = str(dataset.get('crs_kind') or 'unknown').lower()
    if kind == 'projected':
        return False
    if kind == 'geographic':
        return True
    label = str(dataset.get('crs') or '').lower()
    if 'projcs' in label or 'projected' in label:
        return False
    if re.search(r'wgs[ _-]?84|epsg:?4326|crs:?84', label):
        return True
    # RFC 7946 GeoJSON coordinates are WGS84 unless declared otherwise.
    return str(dataset.get('format') or 'GeoJSON').lower() == 'geojson' and label in ('', 'unknown')


def _read_analysis_geometry(body, data, validator):
    feature_id = body.get('feature_id')
    if feature_id:
        feature = resolve_analysis_feature(data, feature_id)
        return feature['geometry'], feature['id']
    geometry = body.get('geometry')
    if not isinstance(geometry, dict):
        raise ValueError('Please select a feature (feature_id) or provide geometry.')
    validator({'type': 'Feature', 'id': 'analysis-input', 'geometry': geometry, 'properties': {}})
    return geometry, None


def _compute_measure(body, dataset, data, validator):
    operation = str(body.get('operation') or '').lower()
    if operation not in ('distance', 'area'):
        raise ValueError('operation must be distance or area')
    geometry, feature_id = _read_analysis_geometry(body, data, validator)
    geographic = dataset_is_geographic(dataset, data)
    other_id = body.get('other_feature_id')
    if operation == 'area':
        value = geometry_area(geometry, geographic)
        unit = 'm²' if geographic else 'map units²'
    elif other_id:
        other = resolve_analysis_feature(data, other_id)['geometry']
        if geometry.get('type') != 'Point' or other.get('type') != 'Point':
            raise ValueError('Two-feature distance currently supports Point-to-Point only')
        a = geometry['coordinates']
        b = other['coordinates']
        value = geodesic_segment_length(a, b) if geographic else math.hypot(a[0]-b[0], a[1]-b[1])
        unit = 'm' if geographic else 'map units'
    else:
        value = geometry_length(geometry, geographic)
        unit = 'm' if geographic else 'map units'
    if not math.isfinite(value):
        raise ValueError('Could not obtain a finite measurement')
    return {'ok': True, 'operation': operation, 'feature_id': feature_id,
            'other_feature_id': other_id, 'value': value, 'unit': unit,
            'geographic': geographic,
            'coordinate_system': 'WGS 84 经纬度' if geographic else '平面坐标/未知 CRS'}


def _compute_buffer(body, dataset, data, validator, writer):
    source = resolve_analysis_feature(data, body.get('feature_id'))
    try:
        distance = float(body.get('distance'))
    except (TypeError, ValueError):
        raise ValueError('distance must be a positive number')
    if not math.isfinite(distance) or not (0 < distance <= 10000000):
        raise ValueError('distance must be greater than zero and <= 10000000')
    geographic = dataset_is_geographic(dataset, data)
    source_geometry = source['geometry']
    if geographic:
        center = local_projection_center(source_geometry)
        local = map_coordinates(source_geometry['coordinates'],
                                lambda p: azimuthal_equidistant_forward(p, center))
        generated = buffer_geometry({'type': source_geometry['type'], 'coordinates': local}, distance)
        result_geometry = {'type': generated['type'],
                           'coordinates': map_coordinates(generated['coordinates'],
                                lambda p: azimuthal_equidistant_inverse(p, center))}
    else:
        result_geometry = buffer_geometry(source_geometry, distance)
    feature = {
        'type': 'Feature', 'id': 'buffer-' + uuid.uuid4().hex[:10],
        'properties': {
            'name': '缓冲区 · ' + str((source.get('properties') or {}).get('name') or source['id']),
            'layer': '空间分析', 'kind': 'buffer', 'analysis': 'buffer',
            'source_id': source['id'], 'distance': distance,
            'distance_unit': 'm' if geographic else 'map units',
        },
        'geometry': result_geometry,
    }
    validator(feature)
    data['features'].append(feature)
    writer(data, dataset['id'])
    return {'ok': True, 'feature': feature, 'source_id': source['id'],
            'unit': 'm' if geographic else 'map units', 'distance': distance,
            'geographic': geographic}


def _compute_intersects(body, dataset, data):
    source = resolve_analysis_feature(data, body.get('feature_id'))
    matches = []
    for feature in data.get('features', []):
        if feature.get('id') == source['id']:
            continue
        if geometries_intersect(source['geometry'], feature['geometry']):
            matches.append(feature)
    return {'ok': True, 'source_id': source['id'], 'count': len(matches),
            'matches': matches,
            'coordinate_system': 'WGS 84 经纬度' if dataset_is_geographic(dataset, data) else '平面坐标/未知 CRS'}


# This UI intentionally does not touch static/app.js or the existing map's
# internal state. It uses an independent floating control and the current dataset.
D_SPATIAL_UI_JS = r'''
(function () {
  "use strict";
  if (document.getElementById("dgs-launcher")) return;
  const style = document.createElement("style");
  style.textContent = `
  #dgs-launcher {position:fixed;z-index:2147483645;right:22px;bottom:20px;border:0;
    border-radius:999px;padding:13px 19px;background:#145b62;color:#fff;
    font:600 15px system-ui,-apple-system,sans-serif;cursor:pointer;
    box-shadow:0 7px 24px #0d313850;letter-spacing:.02em}
  #dgs-launcher:hover{background:#104c52}
  #dgs-panel{position:fixed;z-index:2147483646;right:20px;bottom:80px;width:min(365px,calc(100vw - 32px));
    max-height:min(660px,calc(100vh - 110px));overflow-y:auto;box-sizing:border-box;
    color:#17383b;background:#fffdf8;border:1px solid #d6e4df;border-radius:18px;
    padding:20px;box-shadow:0 14px 50px #163b4650;font:14px/1.55 system-ui,-apple-system,sans-serif}
  #dgs-panel[hidden]{display:none!important}
  #dgs-panel *{box-sizing:border-box}
  #dgs-panel h2{font-size:19px;line-height:1.3;margin:0 25px 3px 0;color:#123e43}
  #dgs-panel .dgs-muted{font-size:12px;color:#627877;margin:0 0 16px}
  #dgs-panel label{display:block;font-weight:600;font-size:13px;margin-top:13px;margin-bottom:5px}
  #dgs-panel select,#dgs-panel input{display:block;width:100%;min-height:40px;padding:7px 11px;
    border:1px solid #c3d5d3;background:white;border-radius:10px;font:inherit;color:#153b40}
  #dgs-panel button:focus-visible,#dgs-launcher:focus-visible,#dgs-panel input:focus-visible,
  #dgs-panel select:focus-visible{outline:3px solid #81c8d0;outline-offset:2px}
  #dgs-panel .dgs-tabs{display:flex;gap:4px;margin:12px 0;padding:4px;background:#eaf2ef;border-radius:12px}
  #dgs-panel .dgs-tabs button{flex:1;border:0;border-radius:9px;cursor:pointer;background:transparent;
    padding:7px 4px;color:#486461;font-weight:600;font-size:13px}
  #dgs-panel .dgs-tabs button[aria-selected="true"]{background:white;color:#155d62;box-shadow:0 2px 6px #10333620}
  #dgs-panel .dgs-primary{display:block;width:100%;padding:11px 12px;margin-top:17px;
    border:0;border-radius:11px;background:#187078;color:white;font-weight:700;font-size:14px;cursor:pointer}
  #dgs-panel .dgs-primary:disabled{opacity:.55;cursor:wait}
  #dgs-panel .dgs-close{position:absolute;right:15px;top:12px;background:transparent;border:0;
    font-size:25px;line-height:1;cursor:pointer;color:#527172}
  #dgs-panel .dgs-result{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:13px;
    background:#edf7f4;border-left:3px solid #20777c;padding:11px 12px;border-radius:7px;font-size:13px}
  #dgs-panel .dgs-result.dgs-error{background:#fff0ed;border-left-color:#b84c3e}
  #dgs-panel .dgs-refresh{border:0;color:#18666d;text-decoration:underline;cursor:pointer;background:transparent;
    padding:9px 0 0;font-size:13px}
  @media(max-width:560px){#dgs-launcher{right:12px;bottom:12px}#dgs-panel{right:10px;bottom:72px}}
  `;
  document.head.appendChild(style);

  const launcher = document.createElement("button");
  launcher.id = "dgs-launcher";
  launcher.textContent = "◈ 空间分析";
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "dgs-panel");
  document.body.appendChild(launcher);

  const panel = document.createElement("section");
  panel.id = "dgs-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "D 组空间分析");
  panel.innerHTML = `
    <button type="button" class="dgs-close" aria-label="关闭空间分析">×</button>
    <h2>D 组 · 空间分析</h2>
    <p class="dgs-muted">对当前激活数据集执行空间计算</p>
    <div class="dgs-tabs" role="tablist" aria-label="分析类型">
      <button type="button" data-operation="distance" aria-selected="true">距离</button>
      <button type="button" data-operation="area" aria-selected="false">面积</button>
      <button type="button" data-operation="buffer" aria-selected="false">缓冲区</button>
      <button type="button" data-operation="intersects" aria-selected="false">相交</button>
    </div>
    <p id="dgs-dataset" class="dgs-muted" aria-live="polite">正在读取数据集...</p>
    <label for="dgs-feature">选择要素</label>
    <select id="dgs-feature"></select>
    <div id="dgs-other-wrap" hidden><label for="dgs-other">可选：另一点要素（计算两点距离）</label>
      <select id="dgs-other"><option value="">不选择：测量当前要素长度/周长</option></select></div>
    <div id="dgs-distance-wrap" hidden><label for="dgs-distance">缓冲距离（米或地图单位）</label>
      <input id="dgs-distance" type="number" min="0.000001" max="10000000" step="any" value="100" /></div>
    <button type="button" id="dgs-run" class="dgs-primary">开始测量</button>
    <div id="dgs-result" class="dgs-result" role="status" aria-live="polite" hidden></div>
    <button type="button" id="dgs-refresh" class="dgs-refresh" hidden>↻ 刷新地图显示缓冲区</button>
  `;
  document.body.appendChild(panel);
  const $ = (id) => panel.querySelector("#" + id);
  const tabs = Array.from(panel.querySelectorAll("[data-operation]"));
  let operation = "distance";
  let features = [];

  function message(text, error = false) {
    const result = $("dgs-result");
    result.textContent = text;
    result.hidden = false;
    result.classList.toggle("dgs-error", error);
  }
  function selectOptions(select, options, placeholder) {
    select.replaceChildren();
    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    select.appendChild(first);
    for (const f of options) {
      const option = document.createElement("option");
      option.value = String(f.id);
      option.textContent = `${f.name || f.id} (${f.type || "未知"})`;
      select.appendChild(option);
    }
  }
  function syncFields() {
    $("dgs-other-wrap").hidden = operation !== "distance";
    $("dgs-distance-wrap").hidden = operation !== "buffer";
    const text = {distance:"测量距离",area:"计算面积",buffer:"生成缓冲区",intersects:"查询相交要素"};
    $("dgs-run").textContent = text[operation];
    $("dgs-refresh").hidden = true;
    $("dgs-result").hidden = true;
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.operation === operation));
    // A second feature is only meaningful when the primary feature is a point.
    selectOptions($("dgs-other"), features.filter(f => f.type === "Point"),
      "不选择：测量当前要素长度/周长");
  }
  async function loadFeatures() {
    try {
      const response = await fetch("/api/spatial/features", {cache:"no-store"});
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "无法读取数据集");
      features = data.features || [];
      $("dgs-dataset").textContent = `当前数据集：${data.dataset_name} · ${features.length} 个要素 · ${data.geographic ? "WGS 84（米）" : "平面/未知坐标（地图单位）"}`;
      selectOptions($("dgs-feature"), features, "请选择一个要素");
      syncFields();
    } catch (error) { message(error.message, true); }
  }
  async function runAnalysis() {
    const feature_id = $("dgs-feature").value;
    if (!feature_id) { message("请先选择要素。", true); return; }
    const endpoint = operation === "distance" || operation === "area" ? "measure" : operation;
    const payload = {feature_id};
    if (endpoint === "measure") {
      payload.operation = operation;
      if (operation === "distance" && $("dgs-other").value) payload.other_feature_id = $("dgs-other").value;
    }
    if (operation === "buffer") payload.distance = Number($("dgs-distance").value);
    const button = $("dgs-run");
    button.disabled = true;
    button.textContent = "正在分析…";
    $("dgs-refresh").hidden = true;
    try {
      const response = await fetch("/api/spatial/" + endpoint, {
        method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "分析失败");
      if (operation === "distance" || operation === "area") {
        message(`${operation === "area" ? "面积" : "距离/长度"}：${Number(data.value).toLocaleString("zh-CN", {maximumFractionDigits:3})} ${data.unit}`);
      } else if (operation === "buffer") {
        message(`已生成缓冲区：${data.distance} ${data.unit}\n已写入当前数据集，刷新地图后可看到。`);
        $("dgs-refresh").hidden = false;
      } else {
        const matches = data.matches || [];
        const names = matches.slice(0, 30).map(f => (f.properties && f.properties.name) || f.id);
        message(`相交要素：${data.count} 个${names.length ? "\n" + names.join("、") : ""}${matches.length > 30 ? "\n（仅显示前 30 个名称）" : ""}`);
      }
    } catch (error) { message(error.message, true); }
    finally { button.disabled = false; $("dgs-run").textContent = {distance:"测量距离",area:"计算面积",buffer:"生成缓冲区",intersects:"查询相交要素"}[operation]; }
  }
  launcher.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    launcher.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) loadFeatures();
  });
  panel.querySelector(".dgs-close").addEventListener("click", () => {
    panel.hidden = true; launcher.setAttribute("aria-expanded", "false"); launcher.focus();
  });
  for (const tab of tabs) tab.addEventListener("click", () => { operation = tab.dataset.operation; syncFields(); });
  $("dgs-run").addEventListener("click", runAnalysis);
  $("dgs-refresh").addEventListener("click", () => window.location.reload());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) { panel.hidden = true; launcher.setAttribute("aria-expanded", "false"); launcher.focus(); }
  });
})();
'''


def install_d_spatial(handler_class, read_dataset, write_geojson, validate_feature, static_dir):
    """Attach the D module to the existing HTTP handler; do not replace it."""
    if getattr(handler_class, '_d_spatial_installed', False):
        return
    handler_class._d_spatial_installed = True
    original_get = handler_class.do_GET
    original_post = handler_class.do_POST

    def new_get(self):
        path = urlsplit(self.path).path
        if path == '/d-spatial-ui.js':
            payload = D_SPATIAL_UI_JS.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path in ('/', '/index.html', '/static/index.html'):
            try:
                html = (static_dir / 'index.html').read_text(encoding='utf-8')
            except (OSError, UnicodeError):
                return original_get(self)
            tag = '<script defer src="/d-spatial-ui.js"></script>'
            if '/d-spatial-ui.js' not in html:
                if re.search(r'</body\s*>', html, re.I):
                    html = re.sub(r'</body\s*>', lambda _: tag + '\n</body>', html, count=1, flags=re.I)
                else:
                    html += '\n' + tag
            payload = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == '/api/spatial/features':
            try:
                dataset, data = read_dataset()
                features = [
                    {'id': f.get('id'),
                     'name': (f.get('properties') or {}).get('name') or str(f.get('id')),
                     'type': (f.get('geometry') or {}).get('type')}
                    for f in data.get('features', [])
                ]
                self.send_json({'ok': True, 'dataset_id': dataset['id'],
                                'dataset_name': dataset.get('name') or dataset['id'],
                                'features': features,
                                'geographic': dataset_is_geographic(dataset, data)})
            except Exception as error:
                self.send_error_json(str(error), status=500)
            return
        return original_get(self)

    def new_post(self):
        path = urlsplit(self.path).path
        if path not in ('/api/spatial/measure', '/api/spatial/buffer', '/api/spatial/intersects'):
            return original_post(self)
        try:
            body = self.read_json_body()
            if not isinstance(body, dict):
                raise ValueError('Request JSON must be an object')
            dataset, data = read_dataset()
            if path.endswith('/measure'):
                output = _compute_measure(body, dataset, data, validate_feature)
            elif path.endswith('/buffer'):
                output = _compute_buffer(body, dataset, data, validate_feature, write_geojson)
            else:
                output = _compute_intersects(body, dataset, data)
            self.send_json(output)
        except KeyError as error:
            self.send_error_json(str(error), status=404)
        except (ValueError, TypeError) as error:
            self.send_error_json(str(error), status=400)
        except Exception as error:
            self.send_error_json('Spatial analysis failed: ' + str(error), status=500)

    handler_class.do_GET = new_get
    handler_class.do_POST = new_post
