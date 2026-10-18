"""Serve the real GIS app with disposable storage for browser tests."""

import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def main():
    with tempfile.TemporaryDirectory(prefix="gis-browser-test-") as directory:
        data_dir = Path(directory)
        server.DATA_DIR = data_dir
        server.DATA_FILE = data_dir / "features.geojson"
        server.UPLOAD_DIR = data_dir / "uploads"
        server.CATALOG_FILE = data_dir / "catalog.json"
        server.ACTIVE_DATASET_FILE = data_dir / "active_dataset.json"
        server.ensure_storage()
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.GisDemoHandler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        print(httpd.server_address[1], flush=True)
        try:
            sys.stdin.buffer.read()
        finally:
            httpd.shutdown()
            worker.join(timeout=5)
            httpd.server_close()


if __name__ == "__main__":
    main()
