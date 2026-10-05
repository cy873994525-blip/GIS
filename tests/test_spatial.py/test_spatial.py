import unittest

import server


class SpatialGeometryTests(unittest.TestCase):
    def test_point_buffer_is_closed_polygon(self):
        geometry = server.buffer_geometry({"type": "Point", "coordinates": [0, 0]}, 10)
        ring = geometry["coordinates"][0]
        self.assertEqual(geometry["type"], "Polygon")
        self.assertEqual(ring[0], ring[-1])
        self.assertEqual(len(ring), 49)

    def test_line_buffer_and_planar_length(self):
        geometry = server.buffer_geometry(
            {"type": "LineString", "coordinates": [[0, 0], [10, 0]]}, 2
        )
        self.assertEqual(geometry["type"], "Polygon")
        self.assertGreater(len(geometry["coordinates"][0]), 10)
        self.assertAlmostEqual(
            server.geometry_length({"type": "LineString", "coordinates": [[0, 0], [3, 4]]}),
            5,
        )

    def test_polygon_area_and_intersection(self):
        polygon = {
            "type": "Polygon",
            "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
        }
        self.assertAlmostEqual(server.geometry_area(polygon), 100)
        self.assertTrue(server.geometries_intersect(polygon, {"type": "Point", "coordinates": [5, 5]}))
        self.assertTrue(server.geometries_intersect(
            polygon, {"type": "LineString", "coordinates": [[-1, 5], [5, 5]]}
        ))
        self.assertFalse(server.geometries_intersect(polygon, {"type": "Point", "coordinates": [20, 20]}))

    def test_geographic_measurement_uses_meters(self):
        geometry = {"type": "LineString", "coordinates": [[116.4, 39.9], [116.41, 39.9]]}
        self.assertGreater(server.geometry_length(geometry, geographic=True), 800)
        self.assertLess(server.geometry_length(geometry, geographic=True), 1000)


if __name__ == "__main__":
    unittest.main()
