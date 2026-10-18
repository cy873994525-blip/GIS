import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class FieldTypeValidationTests(unittest.TestCase):
    def make_data(self, value, kind="number"):
        return {
            "type": "FeatureCollection",
            "field_types": {"score": kind},
            "features": [{
                "type": "Feature",
                "id": "one",
                "geometry": {"type": "Point", "coordinates": [1, 2]},
                "properties": {"score": value},
            }],
        }

    def test_number_and_null_are_accepted(self):
        server.validate_feature_collection(self.make_data(12.5))
        server.validate_feature_collection(self.make_data(None))

    def test_invalid_number_and_boolean_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "field score must contain number"):
            server.validate_feature_collection(self.make_data("12.5"))
        with self.assertRaisesRegex(ValueError, "field score must contain number"):
            server.validate_feature_collection(self.make_data(True))
        with self.assertRaisesRegex(ValueError, "field score must contain boolean"):
            server.validate_feature_collection(self.make_data("true", "boolean"))

    def test_invalid_schema_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "field_types"):
            server.validate_feature_collection(self.make_data("x", "unsupported"))

    def test_default_must_match_declared_type(self):
        payload = self.make_data(1)
        payload["field_defaults"] = {"score": 5}
        server.validate_feature_collection(payload)
        payload["field_defaults"] = {"score": "bad"}
        with self.assertRaisesRegex(ValueError, "default for field score"):
            server.validate_feature_collection(payload)
        payload["field_defaults"] = {"missing": 1}
        with self.assertRaisesRegex(ValueError, "field_defaults"):
            server.validate_feature_collection(payload)

    def test_declared_types_survive_storage_and_reject_bad_write(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            with mock.patch.multiple(
                server,
                DATA_DIR=data_dir,
                DATA_FILE=data_dir / "features.geojson",
                UPLOAD_DIR=data_dir / "uploads",
                CATALOG_FILE=data_dir / "catalog.json",
                ACTIVE_DATASET_FILE=data_dir / "active_dataset.json",
            ):
                server.ensure_storage()
                payload = server.read_geojson()
                payload["field_types"] = {"score": "number"}
                payload["field_defaults"] = {"score": 3}
                for feature in payload["features"]:
                    feature["properties"]["score"] = 1
                server.write_geojson(payload)
                restored = server.read_geojson()
                self.assertEqual(restored["field_types"]["score"], "number")
                self.assertEqual(restored["field_defaults"]["score"], 3)
                self.assertEqual(restored["features"][0]["properties"]["score"], 1)
                restored["features"][0]["properties"]["score"] = "bad"
                with self.assertRaisesRegex(ValueError, "field score must contain number"):
                    server.write_geojson(restored)
                self.assertEqual(server.read_geojson()["features"][0]["properties"]["score"], 1)


if __name__ == "__main__":
    unittest.main()
