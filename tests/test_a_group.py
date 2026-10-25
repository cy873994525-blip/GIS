"""A 组功能测试：T1 投影转换、Shapefile 解析/导出、多图层接口、MultiPoint、字段类型推断。

与 tests/test_field_types.py 相同的模式：import server 后直接调用函数，
存储相关用例通过 mock.patch.multiple 隔离到临时目录。
"""
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def isolated_server():
    """返回一个把存储目录隔离到临时目录的 mock 上下文。"""
    directory = tempfile.TemporaryDirectory()
    data_dir = Path(directory.name)
    return directory, mock.patch.multiple(
        server,
        DATA_DIR=data_dir,
        DATA_FILE=data_dir / "features.geojson",
        UPLOAD_DIR=data_dir / "uploads",
        CATALOG_FILE=data_dir / "catalog.json",
        ACTIVE_DATASET_FILE=data_dir / "active_dataset.json",
    )


def make_fc(features, **extra):
    payload = {"type": "FeatureCollection", "features": features}
    payload.update(extra)
    return payload


def point_feature(fid, x, y, **props):
    return {"type": "Feature", "id": fid, "properties": props,
            "geometry": {"type": "Point", "coordinates": [x, y]}}


class T1ProjectionTests(unittest.TestCase):
    def test_transform_coordinates_recurses_into_nested_structures(self):
        transformer = None
        # 无法构造 transformer 时递归应原样返回
        coords = [[[1, 2], [3, 4]], [5, 6]]
        self.assertEqual(server.transform_coordinates(coords, transformer), coords)

    def test_transform_position_keeps_extra_dimensions(self):
        # 未提供 transformer（None）时坐标原样返回，Z 等附加维度保留
        position = [1.0, 2.0, 123.0]
        self.assertEqual(server.transform_position(position, None), position)

    def test_projected_payload_is_converted_when_pyproj_available(self):
        if not server.HAS_PYPROJ:
            self.skipTest("pyproj 不可用")
        # EPSG:2338 = Xian 1980 / Gauss-Kruger CM 75E（6 度带）；真实 .prj 常带 EPSG 编号
        payload = make_fc([point_feature("p", 500000.0, 4000000.0)])
        converted, label = server.project_geojson_to_wgs84(payload, None, "2338", "Xian 1980")
        self.assertIsNotNone(converted)
        self.assertIn("已从", label)
        lon, lat = converted["features"][0]["geometry"]["coordinates"]
        # 中央经线 75E、赤道北 4000000m：经度≈75，纬度≈36.13
        self.assertAlmostEqual(lon, 75.0, delta=0.5, msg=f"经度异常: {lon}")
        self.assertAlmostEqual(lat, 36.13, delta=1.0, msg=f"纬度异常: {lat}")

    def test_unknown_wkt_returns_none_without_raising(self):
        # 无法识别的 Esri 风格 WKT：build_projection_transformer 应返回 None 而非抛错
        wkt = ('PROJCS["Xian_1980_3_Degree_GK_CM_120E",'
               'GEOGCS["GCS_Xian_1980",DATUM["D_Xian_1980",'
               'SPHEROID["Xian_1980",6378140.0,298.257]],'
               'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],'
               'UNIT["Meter",1.0]]')
        payload = make_fc([point_feature("p", 500000.0, 4000000.0)])
        converted, label = server.project_geojson_to_wgs84(payload, wkt, None, "Xian 1980")
        if server.HAS_PYPROJ:
            self.assertIsNone(converted)
            self.assertIsNone(label)


class ShapefileParseTests(unittest.TestCase):
    def test_parse_saved_province_and_capital_datasets(self):
        repo = Path(__file__).resolve().parents[1]
        province_path = repo / "data" / "uploads" / "be24a7c373.geojson"
        capital_path = repo / "data" / "uploads" / "3e2c715212.geojson"
        if not province_path.exists() or not capital_path.exists():
            self.skipTest("仓库示例数据集缺失")
        province = json.loads(province_path.read_text(encoding="utf-8"))
        capital = json.loads(capital_path.read_text(encoding="utf-8"))
        self.assertEqual(len(province["features"]), 34)
        self.assertEqual(len(capital["features"]), 34)
        types_p = {f["geometry"]["type"] for f in province["features"]}
        types_c = {f["geometry"]["type"] for f in capital["features"]}
        self.assertLessEqual(types_p, {"Polygon", "MultiPolygon"})
        self.assertEqual(types_c, {"Point"})

    def test_export_zip_roundtrip_keeps_geometry_and_properties(self):
        payload = make_fc([
            point_feature("a", 116.4074, 39.9042, name="北京", capital=True),
            point_feature("b", 121.4737, 31.2304, name="上海", capital=False),
        ])
        zip_bytes = server.export_shapefile_zip(payload)
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            names = archive.namelist()
            self.assertIn("export.shp", names)
            self.assertIn("export.shx", names)
            self.assertIn("export.dbf", names)
            self.assertIn("export.prj", names)
        back, _crs, _file, _fmt, *_ = server.convert_shapefile_zip("roundtrip.zip", zip_bytes)
        self.assertEqual(len(back["features"]), 2)
        names_back = {f["properties"].get("name") for f in back["features"]}
        self.assertEqual(names_back, {"北京", "上海"})
        capitals = {f["properties"].get("capital") for f in back["features"]}
        self.assertEqual(capitals, {True, False})

    def test_export_rejects_mixed_geometry(self):
        payload = make_fc([
            point_feature("a", 1, 2),
            {"type": "Feature", "id": "b", "properties": {},
             "geometry": {"type": "LineString", "coordinates": [[1, 2], [3, 4]]}},
        ])
        with self.assertRaisesRegex(ValueError, "混合几何类型"):
            server.export_shapefile_zip(payload)

    def test_export_empty_or_geometryless_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "没有可导出"):
            server.export_shapefile_zip(make_fc([]))


class MultiPointTests(unittest.TestCase):
    def test_multipoint_parse_and_export_roundtrip(self):
        payload = make_fc([
            {"type": "Feature", "id": "m", "properties": {"name": "多点点集"},
             "geometry": {"type": "MultiPoint", "coordinates": [[116.4, 39.9], [121.5, 31.2]]}},
        ])
        zip_bytes = server.export_shapefile_zip(payload)
        back, _crs, _file, _fmt, *_ = server.convert_shapefile_zip("multi.zip", zip_bytes)
        geometry = back["features"][0]["geometry"]
        self.assertEqual(geometry["type"], "MultiPoint")
        self.assertEqual(len(geometry["coordinates"]), 2)

    def test_multipoint_validation(self):
        server.validate_geometry_coordinates("MultiPoint", [[1, 2], [3, 4]])
        server.validate_feature_collection(make_fc([
            {"type": "Feature", "id": "m", "properties": {},
             "geometry": {"type": "MultiPoint", "coordinates": [[1, 2]]}},
        ]))
        with self.assertRaisesRegex(ValueError, "MultiPoint"):
            server.validate_geometry_coordinates("MultiPoint", [])


class FieldTypeInferenceTests(unittest.TestCase):
    def test_inference_rules(self):
        payload = make_fc([
            {"type": "Feature", "id": "a", "properties": {"n": 1, "s": "x", "b": True},
             "geometry": {"type": "Point", "coordinates": [0, 0]}},
            {"type": "Feature", "id": "b", "properties": {"n": 2.5, "s": "y", "b": False},
             "geometry": {"type": "Point", "coordinates": [0, 0]}},
        ])
        inferred = server.infer_field_types(payload)
        self.assertEqual(inferred, {"n": "number", "s": "text", "b": "boolean"})

    def test_mixed_values_fall_back_to_text(self):
        payload = make_fc([
            {"type": "Feature", "id": "a", "properties": {"m": 1},
             "geometry": {"type": "Point", "coordinates": [0, 0]}},
            {"type": "Feature", "id": "b", "properties": {"m": "2"},
             "geometry": {"type": "Point", "coordinates": [0, 0]}},
        ])
        self.assertEqual(server.infer_field_types(payload), {"m": "text"})

    def test_declared_field_types_take_priority_over_inference(self):
        # 用户显式声明 field_types（与 C 组一致）时，catalog 记录应使用声明值而非推断值
        payload = make_fc([
            {"type": "Feature", "id": "a", "properties": {"code": "001", "score": 1},
             "geometry": {"type": "Point", "coordinates": [0, 0]}},
        ], field_types={"code": "text", "score": "number"})
        summary = server.dataset_summary("d", "d.geojson", payload, 100, "uploads/d.geojson")
        self.assertEqual(summary["field_types"], {"code": "text", "score": "number"})
        # 未声明时按值推断（code 全是数字字符串但推断为 text，保持与 C 组类型系统一致）
        plain = make_fc([
            {"type": "Feature", "id": "a", "properties": {"score": 1},
             "geometry": {"type": "Point", "coordinates": [0, 0]}},
        ])
        self.assertEqual(server.dataset_summary("d", "d.geojson", plain, 100, "uploads/d.geojson")["field_types"], {"score": "number"})


class DatasetQualityTests(unittest.TestCase):
    def _store_quality_dataset(self, dataset_id, payload, declared):
        """坏数据无法通过 dataset_summary（正常入库会拦截），这里手工构造 catalog 记录，
        模拟手工编辑/外部写入产生的脏数据，验证质量检查能宽松识别。"""
        target = server.UPLOAD_DIR / f"{dataset_id}.geojson"
        server.write_json_atomic(target, payload)
        catalog = server.read_catalog()
        catalog["datasets"].append({
            "id": dataset_id, "name": "quality", "file_name": "quality.geojson",
            "format": "GeoJSON", "feature_count": len(payload["features"]),
            "geometry_types": ["Point"], "bbox": None, "size_bytes": target.stat().st_size,
            "created_at": server.utc_now(), "path": f"uploads/{dataset_id}.geojson",
            "crs": "WGS 84", "crs_kind": "geographic", "field_types": declared,
            "source_note": "test",
        })
        server.write_catalog(catalog)

    def test_quality_reports_duplicates_empty_and_type_mismatch(self):
        directory, patcher = isolated_server()
        with patcher:
            server.ensure_storage()
            dataset_id = "ds-quality01"
            payload = make_fc([
                {"type": "Feature", "id": "dup", "properties": {"n": 1},
                 "geometry": {"type": "Point", "coordinates": [1, 2]}},
                {"type": "Feature", "id": "dup", "properties": {"n": 2},
                 "geometry": {"type": "Point", "coordinates": [3, 4]}},
                {"type": "Feature", "id": "empty", "properties": {},
                 "geometry": None},
                {"type": "Feature", "id": "bad", "properties": {"n": "文本"},
                 "geometry": {"type": "Point", "coordinates": [5, 6]}},
            ], field_types={"n": "number"})
            self._store_quality_dataset(dataset_id, payload, {"n": "number"})

            report = server.assess_dataset_quality(dataset_id)
            quality = report["quality"]
            self.assertEqual(quality["duplicate_ids"], {"dup": 2})
            self.assertEqual(quality["empty_geometries"], 1)
            self.assertEqual(quality["type_mismatches"], 1)
            self.assertIn("发现", report["summary"])
            kinds = {issue["kind"] for issue in quality["issues"]}
            self.assertEqual(kinds, {"type_mismatch", "empty_geometry"})
        directory.cleanup()

    def test_quality_clean_dataset_summary(self):
        directory, patcher = isolated_server()
        with patcher:
            server.ensure_storage()
            dataset_id = "ds-quality02"
            payload = make_fc([point_feature("p", 1, 2)])
            self._store_quality_dataset(dataset_id, payload, {})
            report = server.assess_dataset_quality(dataset_id)
            self.assertEqual(report["quality"]["duplicate_ids"], {})
            self.assertEqual(report["quality"]["empty_geometries"], 0)
            self.assertIn("良好", report["summary"])
        directory.cleanup()


class MultiLayerApiTests(unittest.TestCase):
    def test_read_layers_merges_datasets_and_tags_layer(self):
        directory, patcher = isolated_server()
        with patcher:
            server.ensure_storage()
            # 先注册两个数据集（走正常入库路径）
            catalog = server.read_catalog()
            first = catalog["datasets"][0]
            second_payload = make_fc([point_feature("s1", 10, 20, note="second")])
            second_id = "ds-second01"
            target = server.UPLOAD_DIR / f"{second_id}.geojson"
            server.write_json_atomic(target, second_payload)
            imported = server.dataset_summary(
                second_id, "second.geojson", second_payload, target.stat().st_size,
                f"uploads/{second_id}.geojson", crs_name="WGS 84", crs_kind="geographic",
            )
            catalog["datasets"].append(imported)
            server.write_catalog(catalog)

            merged = server.read_layers([first["id"], second_id])
            expected_first = first["feature_count"]
            self.assertEqual(len(merged["features"]), expected_first + 1)
            tags = {f["properties"].get("layer") for f in merged["features"]}
            self.assertIn("second", tags)
            ids = {f["properties"].get("dataset_id") for f in merged["features"]}
            self.assertEqual(ids, {first["id"], second_id})
        directory.cleanup()


if __name__ == "__main__":
    unittest.main()
