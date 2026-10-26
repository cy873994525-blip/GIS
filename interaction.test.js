const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Only load the app's pure helpers; browser event registration and API requests stay out of this VM.
const appSource = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const helperSource = appSource.split('canvas.addEventListener("mousedown"')[0];
assert.notEqual(helperSource.length, appSource.length, "could not locate browser event registration");
const canvas = { getContext: () => ({}) };
const context = vm.createContext({
  document: { getElementById: (id) => id === "mapCanvas" ? canvas : {} },
});
vm.runInContext(helperSource, context, { filename: "static/app.js" });
const evaluate = (code) => vm.runInContext(code, context);

test("rectangle selection checks actual geometry, not only bounding boxes", () => {
  const feature = (type, coordinates) => ({ geometry: { type, coordinates } });
  const intersects = (item, box) => evaluate(
    `featureIntersectsBox(${JSON.stringify(item)}, ${JSON.stringify(box)})`);
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]];

  assert.equal(intersects(feature("LineString", [[0, 0], [10, 10]]),
    { minX: 0, minY: 8, maxX: 2, maxY: 10 }), false);
  assert.equal(intersects(feature("LineString", [[0, 0], [10, 10]]),
    { minX: 4, minY: 4, maxX: 6, maxY: 6 }), true);
  assert.equal(intersects(feature("Polygon", [outer, hole]),
    { minX: 4, minY: 4, maxX: 6, maxY: 6 }), false);
  assert.equal(intersects(feature("Polygon", [outer, hole]),
    { minX: 1, minY: 1, maxX: 2, maxY: 2 }), true);
  assert.equal(intersects(feature("Point", [2, 2]),
    { minX: 2, minY: 2, maxX: 3, maxY: 3 }), true);
});

test("snapping prefers vertices, falls back to edges, and excludes the edited feature", () => {
  evaluate(`
    state.data.features = [{
      id: "existing", properties: { layer: "test" },
      geometry: { type: "LineString", coordinates: [[10, 10], [20, 10]] }
    }];
    state.visibleLayers = new Set(["test"]);
    state.scale = 10;
    state.offsetX = 0;
    state.offsetY = 0;
    state.viewHeight = 200;
  `);
  const vertex = evaluate("findSnapTarget(103, 101)");
  assert.equal(vertex.kind, "节点");
  assert.deepEqual(Array.from(vertex.coord), [10, 10]);

  const edge = evaluate("findSnapTarget(150, 103)");
  assert.equal(edge.kind, "边");
  assert.ok(Math.abs(edge.coord[0] - 15) < 1e-9);
  assert.ok(Math.abs(edge.coord[1] - 10) < 1e-9);
  assert.equal(evaluate('findSnapTarget(103, 101, "existing")'), null);
  evaluate("state.snapEnabled = false");
  assert.equal(evaluate("findSnapTarget(103, 101)"), null);
});

test("selection modifiers map to replace, add, remove and toggle", () => {
  assert.equal(evaluate("selectionOperation({})"), "replace");
  assert.equal(evaluate("selectionOperation({shiftKey:true})"), "add");
  assert.equal(evaluate("selectionOperation({altKey:true})"), "remove");
  assert.equal(evaluate("selectionOperation({ctrlKey:true})"), "toggle");
});

test("finishing a sketch removes duplicate click vertices and closes polygons only once", () => {
  const line = evaluate("normaliseDraftCoordinates([[0,0],[1,1],[1,1],[2,2]])");
  assert.deepEqual(JSON.parse(JSON.stringify(line)), [[0, 0], [1, 1], [2, 2]]);
  const polygon = evaluate("normaliseDraftCoordinates([[0,0],[2,0],[2,2],[0,0]], true)");
  assert.deepEqual(JSON.parse(JSON.stringify(polygon)), [[0, 0], [2, 0], [2, 2]]);
});

test("only features from the active dataset may be edited", () => {
  evaluate('state.activeDataset = { id: "active", name: "Active layer" }');
  assert.equal(evaluate('isEditableFeature({properties:{dataset_id:"active"}})'), true);
  assert.equal(evaluate('isEditableFeature({properties:{dataset_id:"other"}})'), false);
  assert.throws(() => evaluate('assertEditableSelection([{properties:{dataset_id:"active"}}, {properties:{dataset_id:"other"}}])'),
    /不能跨数据集/);
});

test("Shapefile GCS_WGS_1984 is recognised as geographic data", () => {
  evaluate(`
    state.data.features = [{ geometry: { type: "Point", coordinates: [116.4, 39.9] } }];
    state.datasets = [{ id: "active", crs: "GCS_WGS_1984" }];
    state.visibleDatasetIds = new Set(["active"]);
  `);
  assert.equal(evaluate("isGeographicDataset()"), true);
  evaluate('state.datasets.push({ id: "other", crs: "EPSG:3857" }); state.visibleDatasetIds.add("other")');
  assert.equal(evaluate("isGeographicDataset()"), false);
});

test("bulk persistence saves only raw active data, never merged overlay features", async () => {
  const requests = [];
  context.requests = requests;
  evaluate(`
    api = async (path, options) => {
      requests.push({ path, options });
      if (path.startsWith("/api/datasets/")) return { data: {
        type: "FeatureCollection", features: [{ id: "active-1", properties: { name: "Old" },
          geometry: { type: "Point", coordinates: [1, 2] } }]
      } };
      return { ok: true };
    };
    loadData = async () => {};
    syncMapMode = () => {};
    setNotice = () => {};
    state.data.features = [{ id: "other-1", properties: { dataset_id: "other", layer: "Other" } }];
  `);
  await evaluate('persistActiveFeatures((data) => { data.features[0].properties.name = "New"; }, "Saved")');
  const save = requests.find((request) => request.path === "/api/save");
  assert.ok(save);
  assert.equal(requests[0].path, "/api/datasets/active");
  const body = JSON.parse(save.options.body);
  assert.equal(body.features.length, 1);
  assert.equal(body.features[0].id, "active-1");
  assert.equal(body.features[0].properties.name, "New");
  assert.equal(body.features[0].properties.dataset_id, undefined);
});

test("single-feature update keeps raw layer and omits overlay dataset metadata", async () => {
  const requests = [];
  context.requests = requests;
  evaluate(`
    api = async (path, options) => {
      requests.push({ path, options });
      if (path.startsWith("/api/datasets/")) return { data: {
        type: "FeatureCollection", features: [{ id: "active-1",
          properties: { name: "Old", layer: "Raw layer" },
          geometry: { type: "Point", coordinates: [1, 2] } }]
      } };
      return { feature: JSON.parse(options.body).feature };
    };
    renderLayers = () => {};
    renderAttributes = () => {};
    draw = () => {};
    state.data.features = [{ id: "active-1", properties: {
      name: "Old", layer: "Active layer", dataset_id: "active" },
      geometry: { type: "Point", coordinates: [1, 2] } }];
  `);
  await evaluate('updateFeature({ id: "active-1", properties: { name: "New", layer: "Active layer", dataset_id: "active" }, geometry: { type: "Point", coordinates: [3, 4] } })');
  const saved = JSON.parse(requests.find((request) => request.path === "/api/features/active-1").options.body).feature;
  assert.equal(saved.properties.name, "New");
  assert.equal(saved.properties.layer, "Raw layer");
  assert.equal(saved.properties.dataset_id, undefined);
  assert.deepEqual(saved.geometry.coordinates, [3, 4]);
});
