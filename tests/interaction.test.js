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
  document: { getElementById: (id) => id === "mapCanvas" ? canvas :
    id === "nameInput" ? { value: "Test" } :
    id === "layerInput" ? { value: "Sample" } : {} },
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

test("new polygons reject crossing edges and zero area without rejecting concave shapes", () => {
  assert.match(evaluate('polygonDraftError([[0,0],[2,2],[0,2],[2,0]])'), /相交/);
  assert.match(evaluate('polygonDraftError([[0,0],[1,0],[2,0]])'), /面积为零/);
  assert.equal(evaluate('polygonDraftError([[0,0],[2,0],[2,2],[1,1],[0,2]])'), null);
});

test("attribute sorting is numeric, stable, and keeps empty values last", () => {
  evaluate(`
    state.data.features = [
      { id: "ten", geometry: { type: "Point", coordinates: [0,0] }, properties: { score: 10 } },
      { id: "empty", geometry: { type: "Point", coordinates: [0,0] }, properties: { score: null } },
      { id: "two", geometry: { type: "Point", coordinates: [0,0] }, properties: { score: 2 } },
      { id: "also-two", geometry: { type: "Point", coordinates: [0,0] }, properties: { score: 2 } }
    ];
    state.attributeFilter = "all";
    state.attributeSearch = "";
    state.attributeSort = { key: "field:score", direction: "asc" };
  `);
  assert.deepEqual(Array.from(evaluate('attributeRows().map((feature) => feature.id)')),
    ["two", "also-two", "ten", "empty"]);
  evaluate('state.attributeSort.direction = "desc"');
  assert.deepEqual(Array.from(evaluate('attributeRows().map((feature) => feature.id)')),
    ["ten", "two", "also-two", "empty"]);
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

test("field edits preserve numeric and boolean types and reject invalid values", () => {
  assert.equal(evaluate('coerceFieldValue(" 12.5 ", 1)'), 12.5);
  assert.equal(evaluate('coerceFieldValue("", 1)'), null);
  assert.throws(() => evaluate('coerceFieldValue("abc", 1)'), /数字字段/);
  assert.equal(evaluate('coerceFieldValue("false", true)'), false);
  assert.throws(() => evaluate('coerceFieldValue("yes", true)'), /布尔字段/);
  assert.equal(evaluate('coerceFieldValue("3", null, "number")'), 3);
  assert.equal(evaluate('coerceFieldValue("", null, "number")'), null);
  assert.equal(evaluate('coerceFieldValue("hello", "old", "text")'), "hello");
  evaluate('state.activeFieldTypes = { mixed: "text", score: "number" }; state.declaredFieldTypes = { score: "number" }');
  assert.equal(evaluate('fieldTypeForFeature({ properties: { mixed: 2 } }, "mixed")'), "number");
  assert.equal(evaluate('fieldTypeForFeature({ properties: { score: null } }, "score")'), "number");
  evaluate('state.declaredFieldDefaults = { score: 5 }');
  assert.equal(evaluate('makeFeature({ type: "Point", coordinates: [1, 2] }).properties.score'), 5);
});

test("new fields persist their declared type and default value", async () => {
  const requests = [];
  context.requests = requests;
  evaluate(`
    state.activeDataset = { id: "active", name: "Active layer" };
    state.selectedIds = new Set();
    state.editHistory = [];
    state.redoHistory = [];
    api = async (path, options) => {
      requests.push({ path, options });
      if (path.startsWith("/api/datasets/")) return { data: {
        type: "FeatureCollection", features: [{ id: "one", properties: { name: "P" },
          geometry: { type: "Point", coordinates: [1, 2] } }]
      } };
      return { ok: true };
    };
    loadData = async () => {};
    syncMapMode = () => {};
    setNotice = () => {};
  `);
  await evaluate('addField("score", "number", "0")');
  const saved = JSON.parse(requests.find((request) => request.path === "/api/save").options.body);
  assert.equal(saved.field_types.score, "number");
  assert.equal(saved.field_defaults.score, 0);
  assert.equal(saved.features[0].properties.score, 0);
  assert.equal(evaluate("state.editHistory.length"), 1);
  await assert.rejects(evaluate('addField("bad", "number", "abc")'), /数字字段/);
  assert.equal(requests.filter((request) => request.path === "/api/save").length, 1);
});

test("saved bulk edits can be undone, redone and invalidate redo after a new edit", async () => {
  context.rawData = {
    type: "FeatureCollection", features: [{ id: "one", properties: { score: 1 },
      geometry: { type: "Point", coordinates: [1, 2] } }],
  };
  evaluate(`
    state.activeDataset = { id: "active", name: "Active layer" };
    state.selectedIds = new Set(["one"]);
    state.mode = "pan";
    state.editHistory = [];
    state.redoHistory = [];
    state.historyBusy = false;
    api = async (path, options) => {
      if (path.startsWith("/api/datasets/")) return { data: JSON.parse(JSON.stringify(rawData)) };
      if (path === "/api/save") rawData = JSON.parse(options.body);
      return { ok: true };
    };
    loadData = async () => {};
    syncMapMode = () => {};
    draw = () => {};
    setNotice = () => {};
  `);
  await evaluate('persistActiveFeatures((data) => { data.features[0].properties.score = 2; }, "改分数")');
  assert.equal(context.rawData.features[0].properties.score, 2);
  assert.equal(evaluate("state.editHistory.length"), 1);
  await evaluate('replayEdit("undo")');
  assert.equal(context.rawData.features[0].properties.score, 1);
  assert.equal(evaluate("state.redoHistory.length"), 1);
  await evaluate('replayEdit("redo")');
  assert.equal(context.rawData.features[0].properties.score, 2);
  await evaluate('replayEdit("undo")');
  await evaluate('persistActiveFeatures((data) => { data.features[0].properties.score = 3; }, "再改分数")');
  assert.equal(evaluate("state.redoHistory.length"), 0);
  assert.equal(context.rawData.features[0].properties.score, 3);
});

test("undo refuses to overwrite externally changed data", async () => {
  context.rawData = {
    type: "FeatureCollection", features: [{ id: "one", properties: { score: 1 },
      geometry: { type: "Point", coordinates: [1, 2] } }],
  };
  evaluate('state.editHistory = []; state.redoHistory = []; state.selectedIds = new Set(["one"])');
  await evaluate('persistActiveFeatures((data) => { data.features[0].properties.score = 2; }, "改分数")');
  evaluate('rawData.features[0].properties.score = 4');
  await evaluate('replayEdit("undo")');
  assert.equal(context.rawData.features[0].properties.score, 4);
  assert.equal(evaluate("state.editHistory.length"), 0);
  assert.equal(evaluate("state.redoHistory.length"), 0);
});

test("deleted features and field declarations return on undo", async () => {
  context.rawData = {
    type: "FeatureCollection", field_types: { score: "number" },
    features: [{ id: "one", properties: { score: 1 },
      geometry: { type: "Point", coordinates: [1, 2] } }],
  };
  evaluate('state.editHistory = []; state.redoHistory = []; state.selectedIds = new Set(["one"])');
  await evaluate('persistActiveFeatures((data) => { data.features = []; }, "删除要素")');
  assert.equal(context.rawData.features.length, 0);
  await evaluate('replayEdit("undo")');
  assert.equal(context.rawData.features.length, 1);
  assert.equal(context.rawData.field_types.score, "number");
  assert.equal(evaluate('state.selectedIds.has("one")'), true);
});

test("failed save does not enter edit history", async () => {
  context.rawData = {
    type: "FeatureCollection", features: [{ id: "one", properties: { score: 1 },
      geometry: { type: "Point", coordinates: [1, 2] } }],
  };
  evaluate(`
    state.editHistory = [];
    state.redoHistory = [];
    api = async (path) => {
      if (path.startsWith("/api/datasets/")) return { data: JSON.parse(JSON.stringify(rawData)) };
      throw new Error("save rejected");
    };
  `);
  await assert.rejects(evaluate('persistActiveFeatures((data) => { data.features = []; }, "删除要素")'),
    /save rejected/);
  assert.equal(evaluate("state.editHistory.length"), 0);
  assert.equal(context.rawData.features.length, 1);
});
