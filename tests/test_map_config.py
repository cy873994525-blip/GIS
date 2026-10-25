"""高德官方地图配置与本地代理的隔离测试。"""

import json
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

import server


class FakeUpstream:
    status = 200
    headers = {"Content-Type": "application/json; charset=utf-8"}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return b'{"status":"1"}'


class MapConfigTests(unittest.TestCase):
    def setUp(self):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.GisDemoHandler)
        self.worker = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.worker.start()
        self.base = "http://127.0.0.1:{}".format(self.httpd.server_address[1])

    def tearDown(self):
        self.httpd.shutdown()
        self.worker.join(timeout=5)
        self.httpd.server_close()

    def test_config_does_not_expose_security_code(self):
        with patch.dict(os.environ, {"GIS_AMAP_JS_KEY": "public-key",
                                  "GIS_AMAP_SECURITY_JS_CODE": "private-code"}):
            with urlopen(self.base + "/api/map-config") as response:
                body = response.read()
        config = json.loads(body)
        self.assertTrue(config["enabled"])
        self.assertEqual(config["key"], "public-key")
        self.assertNotIn(b"private-code", body)

    def test_proxy_overrides_client_supplied_jscode(self):
        with patch.dict(os.environ, {"GIS_AMAP_JS_KEY": "public-key",
                                  "GIS_AMAP_SECURITY_JS_CODE": "private-code"}):
            with patch.object(server, "urlopen", return_value=FakeUpstream()) as upstream:
                with urlopen(self.base + "/_AMapService/v3/place/text?keywords=park&jscode=forged") as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read())["status"], "1")
        url = upstream.call_args.args[0].full_url
        self.assertEqual(urlsplit(url).netloc, "restapi.amap.com")
        self.assertEqual(parse_qs(urlsplit(url).query)["jscode"], ["private-code"])
        self.assertNotIn("forged", url)


if __name__ == "__main__":
    unittest.main()
