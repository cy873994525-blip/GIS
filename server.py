from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import sys
import uuid
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "features.geojson"


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


def ensure_data_file():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text(json.dumps(SAMPLE_DATA, ensure_ascii=False, indent=2), encoding="utf-8")


def read_geojson():
    ensure_data_file()
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def validate_feature_collection(payload):
    if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection":
        raise ValueError("payload must be a GeoJSON FeatureCollection")
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError("features must be a list")
    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError("each item in features must be a GeoJSON Feature")
        if not isinstance(feature.get("geometry"), dict):
            raise ValueError("each feature must include geometry")
        if not isinstance(feature.get("properties", {}), dict):
            raise ValueError("feature properties must be an object")
    return payload


def write_geojson(payload):
    validate_feature_collection(payload)
    temp_file = DATA_FILE.with_suffix(".tmp")
    temp_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_file.replace(DATA_FILE)


class GisDemoHandler(SimpleHTTPRequestHandler):
    server_version = "GisVectorDemo/0.2"

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
        if self.path.startswith("/api/layers"):
            self.send_json(read_geojson())
            return

        if self.path.startswith("/api/export"):
            payload = read_geojson()
            body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/geo+json; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="gis-demo-export.geojson"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path.startswith("/api/status"):
            self.send_json(
                {
                    "ok": True,
                    "storage": "data/features.geojson",
                    "backend": "Python http.server",
                    "postgis": "未接入",
                    "shapefile": "未接入",
                }
            )
            return

        return super().do_GET()

    def do_POST(self):
        try:
            if self.path.startswith("/api/features"):
                payload = self.read_json_body()
                data = read_geojson()
                feature = payload.get("feature")
                if not feature or feature.get("type") != "Feature":
                    self.send_error_json("feature must be a GeoJSON Feature")
                    return
                feature.setdefault("id", f"ft-{uuid.uuid4().hex[:10]}")
                feature.setdefault("properties", {})
                data["features"].append(feature)
                write_geojson(data)
                self.send_json({"ok": True, "feature": feature})
                return

            if self.path.startswith("/api/save"):
                payload = self.read_json_body()
                write_geojson(payload)
                self.send_json({"ok": True, "count": len(payload.get("features", []))})
                return

            if self.path.startswith("/api/reset"):
                write_geojson(SAMPLE_DATA)
                self.send_json({"ok": True, "data": SAMPLE_DATA})
                return

            self.send_error_json("unknown endpoint", status=404)
        except Exception as exc:
            self.send_error_json(str(exc), status=500)


def main():
    ensure_data_file()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer(("127.0.0.1", port), GisDemoHandler)
    print(f"GIS demo running at http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
