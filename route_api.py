"""Optional routing endpoints. Everything outside /api/routing/* is untouched.

Python 3.8+, standard library. Import from server.py and call once at the
beginning of do_GET/do_POST/do_DELETE. No GIS storage/catalog edits.
"""
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from routing import Network, load_network, network_bounds

ROOT = Path(__file__).resolve().parent
DEMO_ROADS = ROOT / 'sample_data' / 'seoul_roads_subset.geojson'
USER_ROADS = ROOT / 'data' / 'routing_network.geojson'


def _get_graph():
    return load_network(USER_ROADS if USER_ROADS.exists() else DEMO_ROADS)


def _load_graph(dataset_id=None):
    """从 A 组数据集管线加载路网；dataset_id 为空时退回固定路网文件。

    数据集中导入时的 T1 投影转换已把投影坐标系数据转成 WGS84 经纬度存储，
    因此这里直接读 payload 构建 Network；若数据集仍标注为投影坐标系则拒绝。
    """
    if dataset_id:
        import server as core  # 延迟导入避免与 server.py 循环依赖

        dataset, payload = core.read_dataset(dataset_id)
        if dataset.get('crs_kind') == 'projected':
            raise ValueError(
                f'数据集“{dataset.get("name")}”仍是投影坐标系，'
                '请先通过坐标转换（T1）转成 WGS84 经纬度后再用于路网'
            )
        geometry_types = {
            (feature.get('geometry') or {}).get('type')
            for feature in payload.get('features', [])
        }
        if not geometry_types or not geometry_types.issubset({'LineString', 'MultiLineString'}):
            raise ValueError(
                f'数据集“{dataset.get("name")}”包含 {"/".join(sorted(geometry_types))} '
                '要素；路网只支持 LineString/MultiLineString 线要素'
            )
        graph = Network(payload)
        return graph, {
            'from_dataset': True,
            'dataset_id': dataset['id'],
            'dataset_name': dataset['name'],
        }
    return _get_graph(), {'from_dataset': False}


def _write_network(payload):
    USER_ROADS.parent.mkdir(parents=True, exist_ok=True)
    file_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w', encoding='utf-8', suffix='.geojson', prefix='.routing-',
            dir=USER_ROADS.parent, delete=False
        ) as handle:
            file_name = handle.name
            json.dump(payload, handle, ensure_ascii=False, allow_nan=False)
        os.replace(file_name, USER_ROADS)
    finally:
        if file_name and os.path.exists(file_name):
            os.unlink(file_name)


def handle_routing_request(handler, method):
    """Return True iff this request is handled, so existing APIs remain intact."""
    path = urlsplit(handler.path).path
    if not path.startswith('/api/routing/'):
        return False
    try:
        if path == '/api/routing/network' and method == 'GET':
            query = parse_qs(urlsplit(handler.path).query)
            dataset_id = (query.get('dataset_id') or [None])[0] or None
            graph, meta = _load_graph(dataset_id)
            demo = meta['from_dataset'] is False and not USER_ROADS.exists()
            handler.send_json({
                'ok': True, 'geojson': graph.geojson,
                'info': {
                    'name': (meta.get('dataset_name')
                             or graph.geojson.get('name')
                             or ('首尔道路网（OSM 节选）' if demo else '自定义路网')),
                    'ways': len(graph.geojson['features']),
                    'nodes': len(graph.coords), 'edges': len(graph.edges),
                    'bbox': network_bounds(graph), 'demo': demo,
                    'from_dataset': meta['from_dataset'],
                    'dataset_id': meta.get('dataset_id'),
                    'attribution': graph.geojson.get('attribution', '© OpenStreetMap contributors' if demo else '上传者提供'),
                }
            })
        elif path == '/api/routing/solve' and method == 'POST':
            payload = handler.read_json_body()
            if not isinstance(payload, dict) or not isinstance(payload.get('start'), list) or not isinstance(payload.get('end'), list):
                raise ValueError('请先在道路上选择起点和终点')
            query = parse_qs(urlsplit(handler.path).query)
            dataset_id = (query.get('dataset_id') or [None])[0] or None
            graph, _meta = _load_graph(dataset_id)
            handler.send_json(graph.shortest_path(payload['start'], payload['end'], payload.get('obstacles', [])))
        elif path == '/api/routing/network' and method == 'POST':
            payload = handler.read_json_body()
            graph = Network(payload)  # validation occurs before replacing stored road data
            _write_network(payload)
            handler.send_json({'ok': True, 'ways': len(payload['features']),
                               'nodes': len(graph.coords), 'edges': len(graph.edges)})
        elif path == '/api/routing/network' and method == 'DELETE':
            try:
                USER_ROADS.unlink()
            except FileNotFoundError:
                pass
            handler.send_json({'ok': True})
        else:
            handler.send_error_json('unknown routing endpoint', status=404)
    except (ValueError, TypeError, OverflowError, json.JSONDecodeError) as error:
        handler.send_error_json(str(error), status=400)
    except (OSError, KeyError) as error:
        handler.send_error_json('路网文件读取失败：' + str(error), status=500)
    except Exception as error:
        handler.send_error_json('最短路径请求失败：' + str(error), status=500)
    return True
