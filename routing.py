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

    def shortest_path(self, start, end):
        a = self.nearest_segment(start)
        b = self.nearest_segment(end)
        n = len(self.coords)
        # Extra vertices are attached to the 2 endpoints of each snapped edge.
        # The direct connector below handles BOTH clicks falling on the SAME edge.
        extra = {n: [], n+1: []}
        points = self.coords + [a['point'], b['point']]
        for idx, snap in ((n, a), (n+1, b)):
            u, v, w = self.edges[snap['edge_id']]
            t = snap['fraction']
            for neighbour, weight in ((u, w*t), (v, w*(1-t))):
                extra[idx].append((neighbour, weight))
                extra.setdefault(neighbour, []).append((idx, weight))
        if a['edge_id'] == b['edge_id']:
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
