"""Offline GeoJSON road-network routing, Python 3.8+, standard library only.

Graphs connect road segments ONLY at shared GeoJSON vertices, which avoids
mistaking a bridge and the road underneath for an intersection. Pedestrian-like,
undirected network distance; ignores turns, restrictions and real-time traffic.
"""
import heapq
import json
import math
from functools import lru_cache
from pathlib import Path

EARTH_RADIUS_M = 6371008.8
MAX_WAYS = 5000
MAX_VERTICES = 60000
MAX_SNAP_METERS = 100.0
MAX_OBSTACLES = 20
MAX_OBSTACLE_VERTICES = 500
GEOMETRY_EPS = 1e-10


def _orientation(a, b, c):
    dx, dy = b[0] - a[0], b[1] - a[1]
    ex, ey = c[0] - a[0], c[1] - a[1]
    cross = dx * ey - dy * ex
    tolerance = GEOMETRY_EPS * max(abs(dx), abs(dy), abs(ex), abs(ey), 1e-6)
    return 1 if cross > tolerance else -1 if cross < -tolerance else 0


def _point_on_segment(p, a, b):
    return (_orientation(a, b, p) == 0
            and min(a[0], b[0]) - GEOMETRY_EPS <= p[0] <= max(a[0], b[0]) + GEOMETRY_EPS
            and min(a[1], b[1]) - GEOMETRY_EPS <= p[1] <= max(a[1], b[1]) + GEOMETRY_EPS)


def _segments_intersect(a, b, c, d):
    if (max(a[0], b[0]) + GEOMETRY_EPS < min(c[0], d[0])
            or max(c[0], d[0]) + GEOMETRY_EPS < min(a[0], b[0])
            or max(a[1], b[1]) + GEOMETRY_EPS < min(c[1], d[1])
            or max(c[1], d[1]) + GEOMETRY_EPS < min(a[1], b[1])):
        return False
    o1, o2 = _orientation(a, b, c), _orientation(a, b, d)
    o3, o4 = _orientation(c, d, a), _orientation(c, d, b)
    return (o1 * o2 < 0 and o3 * o4 < 0
            or o1 == 0 and _point_on_segment(c, a, b)
            or o2 == 0 and _point_on_segment(d, a, b)
            or o3 == 0 and _point_on_segment(a, c, d)
            or o4 == 0 and _point_on_segment(b, c, d))


def _ring_position(point, ring):
    """Return 0 on boundary, 1 inside, -1 outside (ring is closed)."""
    inside = False
    x, y = point
    for a, b in zip(ring, ring[1:]):
        if _point_on_segment(point, a, b):
            return 0
        if (a[1] > y) != (b[1] > y):
            crossing_x = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            if x < crossing_x:
                inside = not inside
    return 1 if inside else -1


def _rings_intersect(first, second):
    return any(_segments_intersect(a, b, c, d)
               for a, b in zip(first, first[1:])
               for c, d in zip(second, second[1:]))


def validate_obstacles(obstacles):
    """Validate Polygon obstacles without modifying caller or cached graph data.

    Polygon holes are free space; every outer/hole boundary is impassable.
    Limits bound validation and intersection work for an interactive request.
    """
    if obstacles is None:
        obstacles = []
    if not isinstance(obstacles, list) or len(obstacles) > MAX_OBSTACLES:
        raise ValueError('障碍面必须是列表，最多添加 {} 个障碍面'.format(MAX_OBSTACLES))
    validated = []
    vertex_count = 0
    for obstacle in obstacles:
        geometry = obstacle.get('geometry') if isinstance(obstacle, dict) and obstacle.get('type') == 'Feature' else obstacle
        if not isinstance(geometry, dict) or geometry.get('type') != 'Polygon':
            raise ValueError('障碍面只支持 GeoJSON Polygon 多边形')
        coordinates = geometry.get('coordinates')
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError('障碍面至少需要一个闭合外环')
        rings = []
        for raw_ring in coordinates:
            if not isinstance(raw_ring, list) or len(raw_ring) < 4:
                raise ValueError('障碍面至少需要三个不同顶点并闭合')
            vertex_count += len(raw_ring)
            if vertex_count > MAX_OBSTACLE_VERTICES:
                raise ValueError('障碍面总顶点数不能超过 {}'.format(MAX_OBSTACLE_VERTICES))
            try:
                ring = [check_coord(point) for point in raw_ring]
            except ValueError as error:
                raise ValueError('障碍面坐标无效：' + str(error))
            if ring[0] != ring[-1]:
                raise ValueError('障碍面坐标环必须闭合（首尾坐标一致）')
            if any(a == b for a, b in zip(ring, ring[1:])):
                raise ValueError('障碍面不能有连续重复顶点')
            origin = ring[0]
            area2 = sum((a[0] - origin[0]) * (b[1] - origin[1])
                        - (b[0] - origin[0]) * (a[1] - origin[1])
                        for a, b in zip(ring, ring[1:]))
            span = max(max(p[0] for p in ring) - min(p[0] for p in ring),
                       max(p[1] for p in ring) - min(p[1] for p in ring), 1e-6)
            if abs(area2) <= GEOMETRY_EPS * span:
                raise ValueError('障碍面面积为零或过小，请重新绘制')
            size = len(ring) - 1
            for i in range(size):
                previous, current, following = ring[(i - 1) % size], ring[i], ring[(i + 1) % size]
                if (_orientation(previous, current, following) == 0
                        and (current[0] - previous[0]) * (following[0] - current[0])
                        + (current[1] - previous[1]) * (following[1] - current[1]) < 0):
                    raise ValueError('障碍面不能有折返或重叠边')
                for j in range(i + 1, size):
                    if j == i + 1 or i == 0 and j == size - 1:
                        continue
                    if _segments_intersect(ring[i], ring[i + 1], ring[j], ring[j + 1]):
                        raise ValueError('障碍面存在自相交，请重新绘制')
            rings.append(ring)
        for index, hole in enumerate(rings[1:], 1):
            if _ring_position(hole[0], rings[0]) != 1 or _rings_intersect(rings[0], hole):
                raise ValueError('障碍面的内环必须完全位于外环内部，且不能接触外环')
            for other in rings[1:index]:
                if (_rings_intersect(hole, other)
                        or _ring_position(hole[0], other) != -1
                        or _ring_position(other[0], hole) != -1):
                    raise ValueError('障碍面的内环不能相交、重叠或相互包含')
        outer = rings[0]
        validated.append({'rings': rings, 'bbox': [min(p[0] for p in outer), min(p[1] for p in outer),
                                                   max(p[0] for p in outer), max(p[1] for p in outer)]})
    return validated


def _point_in_obstacle(point, obstacle):
    rings = obstacle['rings']
    outer_position = _ring_position(point, rings[0])
    if outer_position == -1:
        return False
    if outer_position == 0:
        return True
    for hole in rings[1:]:
        position = _ring_position(point, hole)
        if position == 0:
            return True
        if position == 1:
            return False
    return True


def _segment_blocked(a, b, obstacles):
    for obstacle in obstacles:
        left, bottom, right, top = obstacle['bbox']
        if (max(a[0], b[0]) + GEOMETRY_EPS < left or min(a[0], b[0]) - GEOMETRY_EPS > right
                or max(a[1], b[1]) + GEOMETRY_EPS < bottom or min(a[1], b[1]) - GEOMETRY_EPS > top):
            continue
        if _point_in_obstacle(a, obstacle) or _point_in_obstacle(b, obstacle):
            return True
        if any(_segments_intersect(a, b, c, d)
               for ring in obstacle['rings'] for c, d in zip(ring, ring[1:])):
            return True
    return False


def check_coord(p):
    if not isinstance(p, list) or len(p) < 2 or any(
        not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x)
        for x in p[:2]
    ):
        raise ValueError('每个路网坐标必须是 [经度, 纬度] 数值')
    if abs(p[0]) > 180 or abs(p[1]) > 85:
        raise ValueError('仅支持 WGS84 经纬度数据（EPSG:4326，纬度需小于85度）')
    return [float(p[0]), float(p[1])]


def validate_network(geojson):
    if not isinstance(geojson, dict) or geojson.get('type') != 'FeatureCollection':
        raise ValueError('请选择 GeoJSON FeatureCollection 路网文件')
    features = geojson.get('features')
    if not isinstance(features, list) or not features or len(features) > MAX_WAYS:
        raise ValueError('路网应包含 1–{} 条线状要素'.format(MAX_WAYS))
    if isinstance(geojson.get('crs'), dict):
        crs_name = str((geojson['crs'].get('properties') or {}).get('name', ''))
        if crs_name and not any(code in crs_name.upper() for code in ('4326', 'CRS84', 'WGS84')):
            raise ValueError('路网必须是 WGS84 (EPSG:4326)，请先进行坐标转换')
    count = 0
    ways = []
    for f in features:
        if not isinstance(f, dict) or not isinstance(f.get('geometry'), dict):
            raise ValueError('路网中含无效要素')
        geom = f['geometry']
        typ = geom.get('type')
        if typ == 'LineString':
            parts = [geom.get('coordinates')]
        elif typ == 'MultiLineString':
            parts = geom.get('coordinates')
        else:
            raise ValueError('路网只支持 LineString / MultiLineString；不能用面或点建路网')
        if not isinstance(parts, list) or not parts:
            raise ValueError('路网折线不能为空')
        for part in parts:
            if not isinstance(part, list) or len(part) < 2:
                raise ValueError('每条道路至少需要两个坐标点')
            line = [check_coord(p) for p in part]
            count += len(line)
            if count > MAX_VERTICES:
                raise ValueError('路网节点过多，上限为 {}'.format(MAX_VERTICES))
            ways.append(line)
    return ways


def haversine(a, b):
    lon1, lat1 = map(math.radians, a[:2])
    lon2, lat2 = map(math.radians, b[:2])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def key(p):
    return (round(p[0], 7), round(p[1], 7))


class Network:
    def __init__(self, geojson):
        ways = validate_network(geojson)
        self.coords = []
        self.edges = []  # (u, v, metres)
        self.adjacency = []
        lookup = {}
        for way in ways:
            prev = None
            for pos in way:
                k = key(pos)
                if k not in lookup:
                    lookup[k] = len(self.coords)
                    self.coords.append(pos)
                    self.adjacency.append([])
                current = lookup[k]
                if prev is not None and prev != current:
                    a, b = self.coords[prev], self.coords[current]
                    w = haversine(a, b)
                    if w > 0:
                        edge_id = len(self.edges)
                        self.edges.append((prev, current, w))
                        self.adjacency[prev].append((current, w))
                        self.adjacency[current].append((prev, w))
                prev = current
        if not self.edges:
            raise ValueError('道路均无有效长度，无法生成网络')
        self.geojson = geojson

    def nearest_segment(self, point):
        p = check_coord(point)
        # Tangent plane at click location, measured in metres. Accurate over this compact local dataset.
        lat_rad = math.radians(p[1])
        sx = EARTH_RADIUS_M * math.cos(lat_rad) * math.pi / 180
        sy = EARTH_RADIUS_M * math.pi / 180
        best = None
        for eid, (u, v, length) in enumerate(self.edges):
            a, b = self.coords[u], self.coords[v]
            ax, ay = (a[0]-p[0])*sx, (a[1]-p[1])*sy
            bx, by = (b[0]-p[0])*sx, (b[1]-p[1])*sy
            dx, dy = bx-ax, by-ay
            denom = dx*dx + dy*dy
            t = min(1., max(0., -(ax*dx+ay*dy)/denom)) if denom else 0.
            nx, ny = ax + t*dx, ay + t*dy
            d2 = nx*nx + ny*ny
            if best is None or d2 < best['distance_m']**2:
                best = {'edge_id': eid, 'fraction': t, 'point': [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])],
                        'distance_m': math.sqrt(d2)}
        if best is None or best['distance_m'] > MAX_SNAP_METERS:
            raise ValueError('请在道路附近点击（距离道路不超过 100 米）')
        return best

    def shortest_path(self, start, end, obstacles=None):
        barriers = validate_obstacles(obstacles)
        a = self.nearest_segment(start)
        b = self.nearest_segment(end)
        for label, snap in (('起点', a), ('终点', b)):
            if any(_point_in_obstacle(snap['point'], obstacle) for obstacle in barriers):
                raise ValueError(label + '位于障碍面内或边界上，请调整障碍面或重新选点')
        # Per-request filtering keeps the LRU-cached network safe for reuse.
        blocked_pairs = set()
        blocked_edges = 0
        if barriers:
            for u, v, _weight in self.edges:
                if _segment_blocked(self.coords[u], self.coords[v], barriers):
                    blocked_pairs.add((u, v))
                    blocked_pairs.add((v, u))
                    blocked_edges += 1
        n = len(self.coords)
        # Extra vertices are attached to the 2 endpoints of each snapped edge.
        # The direct connector below handles BOTH clicks falling on the SAME edge.
        extra = {n: [], n+1: []}
        points = self.coords + [a['point'], b['point']]
        for idx, snap in ((n, a), (n+1, b)):
            u, v, w = self.edges[snap['edge_id']]
            t = snap['fraction']
            for neighbour, weight in ((u, w*t), (v, w*(1-t))):
                # A snap can use a clear portion of an otherwise blocked edge.
                if not _segment_blocked(snap['point'], self.coords[neighbour], barriers):
                    extra[idx].append((neighbour, weight))
                    extra.setdefault(neighbour, []).append((idx, weight))
        if a['edge_id'] == b['edge_id'] and not _segment_blocked(a['point'], b['point'], barriers):
            w = self.edges[a['edge_id']][2]
            direct = w * abs(a['fraction'] - b['fraction'])
            extra[n].append((n+1, direct))
            extra[n+1].append((n, direct))

        distances = {n: 0.0}
        previous = {}
        queue = [(0.0, n)]
        settled = set()
        while queue:
            cost, u = heapq.heappop(queue)
            if u in settled:
                continue
            settled.add(u)
            if u == n+1:
                break
            for v, weight in self.adjacency[u] if u < n else []:
                if (u, v) in blocked_pairs:
                    continue
                next_cost = cost + weight
                if next_cost < distances.get(v, math.inf) - 1e-9:
                    distances[v] = next_cost
                    previous[v] = u
                    heapq.heappush(queue, (next_cost, v))
            for v, weight in extra.get(u, []):
                next_cost = cost + weight
                if next_cost < distances.get(v, math.inf) - 1e-9:
                    distances[v] = next_cost
                    previous[v] = u
                    heapq.heappush(queue, (next_cost, v))
        if n+1 not in distances:
            if barriers:
                raise ValueError('当前障碍面约束下无法找到可通行路径，请撤销或清空障碍面，或重新选择起终点。')
            raise ValueError('两点处于不连通的道路网，无法找到路径。请换到同一个连通路网中。')
        path = [n+1]
        while path[-1] != n:
            path.append(previous[path[-1]])
        path.reverse()
        coords = [points[u] for u in path]
        # Eliminate repeated zero-distance vertices caused by clicks exactly on junctions.
        cleaned = [coords[0]]
        for p in coords[1:]:
            if haversine(p, cleaned[-1]) > 0.001:
                cleaned.append(p)
        if len(cleaned) == 1:
            cleaned.append(cleaned[0])
        return {
            'ok': True,
            'start': a['point'], 'end': b['point'],
            'snapping_m': [round(a['distance_m'], 2), round(b['distance_m'], 2)],
            'distance_m': round(distances[n+1], 2),
            'visited_nodes': len(settled),
            'obstacle_count': len(barriers), 'blocked_edges': blocked_edges,
            'route': {'type': 'Feature', 'properties': {'kind': 'shortest_path', 'length_m': round(distances[n+1], 2)},
                      'geometry': {'type': 'LineString', 'coordinates': cleaned}},
        }


def _file_signature(path):
    stat = path.stat()
    return str(path), stat.st_mtime_ns, stat.st_size


@lru_cache(maxsize=4)
def _load_cached(path, mtime_ns, size):
    payload = json.loads(Path(path).read_text(encoding='utf-8'))
    return Network(payload)


def load_network(path):
    return _load_cached(*_file_signature(Path(path)))


def network_bounds(network):
    xs = [p[0] for p in network.coords]
    ys = [p[1] for p in network.coords]
    return [min(xs), min(ys), max(xs), max(ys)]
