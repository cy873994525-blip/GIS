from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import sys
import uuid
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "features.geojson"
UPLOAD_DIR = DATA_DIR / "uploads"
CATALOG_FILE = DATA_DIR / "catalog.json"
ACTIVE_DATASET_FILE = DATA_DIR / "active_dataset.json"


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
    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError("each item in features must be a GeoJSON Feature")
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or not geometry.get("type"):
            raise ValueError("each feature must include a geometry")
        if not isinstance(feature.get("properties", {}), dict):
            raise ValueError("feature properties must be an object")
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


def dataset_summary(dataset_id, file_name, payload, size_bytes, path_name, created_at=None):
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
        "format": "GeoJSON",
        "feature_count": len(payload.get("features", [])),
        "geometry_types": geometry_types,
        "bbox": calculate_bbox(payload),
        "size_bytes": size_bytes,
        "created_at": created_at or utc_now(),
        "path": path_name,
    }


def write_json_atomic(path, payload):
    temp_file = path.with_suffix(".tmp")
    temp_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
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
            )
            write_catalog(catalog)
            return catalog["datasets"][index]
    raise KeyError(f"dataset not found: {dataset_id}")


def write_geojson(payload, dataset_id=None):
    validate_feature_collection(payload)
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
            dataset_id = unquote(path.removeprefix("/api/datasets/")).strip("/")
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
                    "shapefile": "未接入",
                }
            )
            return

        return super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
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
                geojson = json.loads(raw_content) if isinstance(raw_content, str) else raw_content
                validate_feature_collection(geojson)
                original_name = Path(str(payload.get("file_name") or "imported.geojson")).name
                if not original_name.lower().endswith((".geojson", ".json")):
                    raise ValueError("only .geojson and .json files are supported in this demo")

                dataset_id = f"ds-{uuid.uuid4().hex[:10]}"
                stored_name = f"{dataset_id}.geojson"
                target = UPLOAD_DIR / stored_name
                serialized = json.dumps(geojson, ensure_ascii=False, indent=2)
                target.write_text(serialized, encoding="utf-8")
                imported = dataset_summary(
                    dataset_id,
                    original_name,
                    geojson,
                    target.stat().st_size,
                    f"uploads/{stored_name}",
                )
                catalog = read_catalog()
                catalog["datasets"].append(imported)
                write_catalog(catalog)
                set_active_id(dataset_id)
                self.send_json({"ok": True, "dataset": {**imported, "active": True}})
                return

            if path.startswith("/api/datasets/") and path.endswith("/activate"):
                dataset_id = unquote(path.removeprefix("/api/datasets/").removesuffix("/activate")).strip("/")
                find_dataset(dataset_id)
                set_active_id(dataset_id)
                dataset, data = read_dataset(dataset_id)
                self.send_json({"ok": True, "dataset": dataset, "data": data})
                return

            self.send_error_json("unknown endpoint", status=404)
        except json.JSONDecodeError as exc:
            self.send_error_json(f"invalid JSON: {exc}", status=400)
        except (KeyError, ValueError) as exc:
            self.send_error_json(str(exc), status=400)
        except Exception as exc:
            self.send_error_json(str(exc), status=500)

    def do_DELETE(self):
        path = urlsplit(self.path).path
        try:
            if not path.startswith("/api/datasets/"):
                self.send_error_json("unknown endpoint", status=404)
                return
            dataset_id = unquote(path.removeprefix("/api/datasets/")).strip("/")
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
        except Exception as exc:
            self.send_error_json(str(exc), status=500)


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
