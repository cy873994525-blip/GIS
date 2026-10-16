"""Optional routing endpoints. Everything outside /api/routing/* is untouched.

Python 3.8+, standard library. Import from server.py and call once at the
beginning of do_GET/do_POST/do_DELETE. No GIS storage/catalog edits.
"""
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from routing import Network, load_network, network_bounds

ROOT = Path(__file__).resolve().parent
DEMO_ROADS = ROOT / 'sample_data' / 'seoul_roads_subset.geojson'
USER_ROADS = ROOT / 'data' / 'routing_network.geojson'


def _get_graph():
    return load_network(USER_ROADS if USER_ROADS.exists() else DEMO_ROADS)


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
            graph = _get_graph()
            demo = not USER_ROADS.exists()
            handler.send_json({
                'ok': True, 'geojson': graph.geojson,
                'info': {
                    'name': graph.geojson.get('name') or ('首尔道路网（OSM 节选）' if demo else '自定义路网'),
                    'ways': len(graph.geojson['features']),
                    'nodes': len(graph.coords), 'edges': len(graph.edges),
                    'bbox': network_bounds(graph), 'demo': demo,
                    'attribution': graph.geojson.get('attribution', '© OpenStreetMap contributors' if demo else '上传者提供'),
                }
            })
        elif path == '/api/routing/solve' and method == 'POST':
            payload = handler.read_json_body()
            if not isinstance(payload, dict) or not isinstance(payload.get('start'), list) or not isinstance(payload.get('end'), list):
                raise ValueError('请先在道路上选择起点和终点')
            handler.send_json(_get_graph().shortest_path(payload['start'], payload['end']))
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
