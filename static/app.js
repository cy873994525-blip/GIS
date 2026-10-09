const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const tileLayer = document.getElementById("baseMapTiles");
const visibleTiles = new Map();
const MAX_MERCATOR_LAT = 85.05112878;
const TILE_SIZE = 256;
const MAX_TILE_ZOOM = 19;

// ---- 高德底图（GCJ-02 坐标系）配置 ----
const TILE_MIN_ZOOM = 1;    // 高德瓦片最小缩放级别（z=0 高德不提供）
const TILE_MAX_ZOOM = 18;   // 高德瓦片最大缩放级别（z=19 高德不提供）
const TILE_STYLE = 7;       // 7=基础底图（干净），8=路网+中文标注

const state = {
  data: { type: "FeatureCollection", features: [] },
  datasets: [],
  activeDataset: null,
  visibleDatasetIds: new Set(),
  visibleDatasetIdsInitialized: false,
  visibleLayers: new Set(),
  selectedIds: new Set(),
  mode: "pan",
  scale: 0.7,
  offsetX: 80,
  offsetY: 40,
  viewWidth: 1200,
  viewHeight: 780,
  dpr: 1,
  dragging: false,
  dragStart: null,
  boxStart: null,
  boxEnd: null,
  draft: [],
  draftHover: null,
  dirty: false,
  isSaving: false,
  // 属性表抽屉
  drawerOpen: true,
  attributeFilter: "all",
  attributeSearch: "",
  attributePage: 1,
  // 几何编辑
  editFeatureId: null,
  editGeometry: null,
  geometryHistory: [],
  vertexDrag: null,
  featureDrag: null,
  hoverVertexIndex: -1,
  lastRowClickId: null,
  // 拖拽结束后浏览器会补一个 click，用它吃掉那次点击。
  skipClickOnce: false,
  geographic: false,
  baseMapEnabled: true,
  baseMapErrorShown: false,
};

// 属性表每页渲染的行数。后端 MAX_FEATURES 是 10000，全量建 DOM 会把页面拖死。
const ATTRIBUTE_PAGE_SIZE = 100;
// 这两列由绘制/图层逻辑使用，排到属性表最前面；其余字段按首次出现顺序。
const PINNED_FIELDS = ["name", "layer"];
// 几何编辑的历史深度。
const GEOMETRY_HISTORY_LIMIT = 30;

const FIELD_LABELS = {
  name: "名称",
  layer: "图层",
  kind: "几何类别",
};

const layerColors = {
  "兴趣点": "#b6335c",
  "道路": "#bb6b2a",
  "水域": "#3579a6",
  "功能区": "#6b7d38",
  "自定义": "#176d6a",
};

const hints = {
  pan: "当前：漫游。拖拽移动地图，滚轮缩放。",
  select: "当前：点选。点击要素可以查看属性。",
  box: "当前：框选。按住拖拽形成选择框。",
  point: "当前：画点。点击地图新增点要素。",
  line: "当前：画线。连续点击添加节点，可撤销节点，完成后生成线。",
  polygon: "当前：画面。连续点击添加节点，可撤销节点，完成后生成面。",
  edit: "当前：编辑几何。选中一个要素后，拖节点改形状，拖要素本体整体平移，双击边插入节点，Alt+点击删除节点。",
};

// ---- WGS84 <-> GCJ-02（火星坐标）转换，用于矢量数据与高德底图对齐 ----
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina(lon, lat) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function wgs84ToGcj02(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat];
  const dLat = transformLat(lon - 105.0, lat - 35.0);
  const dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLatAdj = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
  const dLonAdj = (dLon * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lon + dLonAdj, lat + dLatAdj];
}

function gcj02ToWgs84(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat];
  let wLon = lon;
  let wLat = lat;
  for (let i = 0; i < 5; i++) {
    const g = wgs84ToGcj02(wLon, wLat);
    wLon += lon - g[0];
    wLat += lat - g[1];
  }
  return [wLon, wLat];
}

// 高德栅格瓦片 URL（标准 XYZ，y 自北向南递增，与当前瓦片模型一致）
function amapTileUrl(z, x, y) {
  const s = ((x * 2 + y + z) % 4) + 1; // 子域 webrd01~04 轮询，分散请求更稳定
  return `https://webrd0${s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=${TILE_STYLE}&x=${x}&y=${y}&z=${z}`;
}

function projectWorld(coord) {
  if (!state.geographic) return coord;
  const gcj = wgs84ToGcj02(coord[0], coord[1]);
  const latitude = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, gcj[1]));
  const radians = latitude * Math.PI / 180;
  return [gcj[0], Math.asinh(Math.tan(radians)) * 180 / Math.PI];
}

function unprojectWorld(coord) {
  if (!state.geographic) return coord;
  const latitude = Math.atan(Math.sinh(coord[1] * Math.PI / 180)) * 180 / Math.PI;
  return gcj02ToWgs84(coord[0], latitude);
}

function worldToScreen(coord) {
  const projected = projectWorld(coord);
  return {
    x: projected[0] * state.scale + state.offsetX,
    y: state.viewHeight - (projected[1] * state.scale + state.offsetY),
  };
}

function screenToWorld(x, y) {
  return unprojectWorld([
    (x - state.offsetX) / state.scale,
    ((state.viewHeight - y) - state.offsetY) / state.scale,
  ]);
}

function isGeographicDataset() {
  if (!state.data.features.length) return false;
  const bounds = getDataBounds();
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return false;
  if (bounds.minX < -180 || bounds.maxX > 180 ||
      bounds.minY < -MAX_MERCATOR_LAT || bounds.maxY > MAX_MERCATOR_LAT) return false;
  const crsList = state.datasets
    .filter((dataset) => state.visibleDatasetIds.has(dataset.id))
    .map((dataset) => dataset.crs || "Unknown");
  const crs = crsList.length ? crsList.join(" ") : "Unknown";
  return crs === "Unknown" || /WGS[ _]?84|EPSG:?4326|CRS:?84/i.test(crs);
}

function syncMapMode() {
  state.geographic = isGeographicDataset();
  state.baseMapErrorShown = false;
  const enabled = state.geographic && state.baseMapEnabled;
  const button = document.getElementById("baseMapBtn");
  button.disabled = !state.geographic;
  button.classList.toggle("active", enabled);
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = state.geographic ? (enabled ? "地图：开" : "地图：关") : "需经纬度";
  document.getElementById("mapBadgeText").textContent = state.geographic
    ? (enabled ? "WGS 84 经纬度 · 在线底图" : "WGS 84 经纬度 · 底图已关闭")
    : "模拟 / 投影坐标 · 平面画布";
  document.getElementById("mapAttribution").hidden = !enabled;
  canvas.classList.toggle("with-basemap", enabled);
  draw();
}

function renderBasemapTiles() {
  if (!state.geographic || !state.baseMapEnabled) {
    for (const image of visibleTiles.values()) image.remove();
    visibleTiles.clear();
    return;
  }

  const zoom = Math.max(TILE_MIN_ZOOM, Math.min(TILE_MAX_ZOOM,
    Math.floor(Math.log2(state.scale * 360 / TILE_SIZE))));
  const tilesPerSide = 2 ** zoom;
  const tileWorldSizeX = 360 / tilesPerSide;   // x：线性经度
  const tileWorldSizeY = 180 / tilesPerSide;   // y：Web Mercator 纬度（±85.05° → 0..2^z）
  const leftWorld = -state.offsetX / state.scale;
  const rightWorld = (state.viewWidth - state.offsetX) / state.scale;
  const topWorld = (state.viewHeight - state.offsetY) / state.scale;
  const bottomWorld = -state.offsetY / state.scale;
  const firstX = Math.max(0, Math.floor((leftWorld + 180) / tileWorldSizeX));
  const lastX = Math.min(tilesPerSide - 1, Math.floor((rightWorld + 180) / tileWorldSizeX));
  const topClamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, topWorld));
  const bottomClamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, bottomWorld));
  const firstY = Math.max(0, Math.floor((90 - topClamped) / tileWorldSizeY));
  const lastY = Math.min(tilesPerSide - 1, Math.floor((90 - bottomClamped) / tileWorldSizeY));
  const needed = new Set();

  for (let x = firstX; x <= lastX; x += 1) {
    for (let y = firstY; y <= lastY; y += 1) {
      const key = `${zoom}/${x}/${y}`;
      needed.add(key);
      let image = visibleTiles.get(key);
      if (!image) {
        image = document.createElement("img");
        image.alt = "";
        image.draggable = false;
        image.decoding = "async";
        image.addEventListener("error", () => {
          if (!state.geographic || !state.baseMapEnabled ||
              visibleTiles.get(key) !== image || state.baseMapErrorShown) return;
          state.baseMapErrorShown = true;
          document.getElementById("mapBadgeText").textContent = "底图暂时无法加载，请检查网络";
        });
        image.src = amapTileUrl(zoom, x, y);
        visibleTiles.set(key, image);
        tileLayer.appendChild(image);
      }
      const tilePixels = tileWorldSizeX * state.scale;
      image.style.left = `${(x * tileWorldSizeX - 180) * state.scale + state.offsetX}px`;
      image.style.top = `${state.viewHeight - ((90 - y * tileWorldSizeY) * state.scale + state.offsetY)}px`;
      image.style.width = `${tilePixels + 0.5}px`;
      image.style.height = `${tilePixels + 0.5}px`;
    }
  }

  for (const [key, image] of visibleTiles) {
    if (needed.has(key)) continue;
    image.remove();
    visibleTiles.delete(key);
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.viewWidth = Math.max(300, Math.floor(rect.width));
  state.viewHeight = Math.max(300, Math.floor(rect.height));
  canvas.width = Math.floor(state.viewWidth * state.dpr);
  canvas.height = Math.floor(state.viewHeight * state.dpr);
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  draw();
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = await response.text();
    try {
      message = JSON.parse(message).error || message;
    } catch (error) {
      // Keep the raw response when the server does not return JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatBbox(bbox) {
  if (!bbox) return "范围：暂无坐标";
  return `范围：${bbox.map((value) => Number(value).toFixed(1)).join(", ")}`;
}

function renderDatasets() {
  const list = document.getElementById("datasetList");
  const countLabel = document.getElementById("datasetCountLabel");
  const meta = document.getElementById("activeDatasetMeta");
  countLabel.textContent = `${state.datasets.length} FILES`;
  list.innerHTML = "";

  for (const dataset of state.datasets) {
    const row = document.createElement("div");
    row.className = `dataset-row${dataset.active ? " active" : ""}`;
    const info = document.createElement("div");
    info.className = "dataset-info";
    const name = document.createElement("strong");
    name.textContent = dataset.name;
    const detail = document.createElement("span");
    detail.textContent = `${dataset.file_name} · ${dataset.feature_count} 个要素`;
    info.append(name, detail);

    const actions = document.createElement("div");
    actions.className = "dataset-actions";

    const showLabel = document.createElement("label");
    showLabel.className = "dataset-show";
    showLabel.title = "在地图上显示/隐藏这个数据集";
    const showCheck = document.createElement("input");
    showCheck.type = "checkbox";
    showCheck.checked = state.visibleDatasetIds.has(dataset.id);
    showCheck.addEventListener("change", async () => {
      if (showCheck.checked) {
        state.visibleDatasetIds.add(dataset.id);
      } else {
        state.visibleDatasetIds.delete(dataset.id);
      }
      await loadData();
      syncMapMode();
    });
    showLabel.append(showCheck, document.createTextNode("显示"));

    const button = document.createElement("button");
    button.className = "dataset-switch";
    button.type = "button";
    button.textContent = dataset.active ? "当前" : "切换";
    button.disabled = dataset.active;
    button.addEventListener("click", () => activateDataset(dataset.id));

    const deleteButton = document.createElement("button");
    deleteButton.className = "dataset-delete";
    deleteButton.type = "button";
    deleteButton.textContent = "删除";
    deleteButton.title = dataset.active ? "当前数据集不能删除" : "删除这个数据集";
    deleteButton.disabled = dataset.active;
    deleteButton.addEventListener("click", () => deleteDataset(dataset));
    actions.append(showLabel, button, deleteButton);
    row.append(info, actions);
    list.appendChild(row);
  }

  if (state.activeDataset) {
    const types = state.activeDataset.geometry_types.join("、") || "暂无几何";
    meta.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = `当前：${state.activeDataset.name}`;
    meta.appendChild(title);
    const details = [
      `${state.activeDataset.file_name} · ${formatBytes(state.activeDataset.size_bytes)}`,
      `来源：${state.activeDataset.format}${state.activeDataset.crs ? ` · ${state.activeDataset.crs}` : ""}`,
      `几何：${types}`,
      formatBbox(state.activeDataset.bbox),
      state.activeDataset.source_note,
    ];
    for (const value of details) {
      if (!value) continue;
      const line = document.createElement("span");
      line.textContent = value;
      meta.appendChild(line);
    }
  } else {
    meta.textContent = "暂无当前数据集";
  }
}

async function loadDatasets() {
  const result = await api("/api/datasets");
  state.datasets = result.datasets;
  state.activeDataset = state.datasets.find((dataset) => dataset.active) || null;
  if (!state.visibleDatasetIdsInitialized) {
    state.visibleDatasetIds = new Set(
      state.datasets.filter((dataset) => dataset.active).map((dataset) => dataset.id)
    );
    state.visibleDatasetIdsInitialized = true;
  }
  renderDatasets();
}

async function loadData() {
  const ids = [...state.visibleDatasetIds];
  const query = ids.length ? `?ids=${encodeURIComponent(ids.join(","))}` : "";
  state.data = await api(`/api/layers${query}`);
  state.geographic = false;
  const layers = new Set(state.data.features.map((f) => f.properties.layer || "未命名"));
  state.visibleLayers = layers;
  // 数据集换了，旧的编辑目标已经不在数据里了。
  exitGeometryEdit();
  state.attributePage = 1;
  renderLayers();
  renderAttributes();
  updateStats();
  syncDraftControls();
  draw();
}

async function loadStatus() {
  const status = await api("/api/status");
  document.getElementById("backendStatus").textContent = [
    `服务：${status.backend}`,
    `存储：${status.storage}`,
    `当前：${status.active_dataset} · ${status.dataset_count} 个数据集`,
    `扩展：${status.postgis} · ${status.shapefile}`,
  ].join("\n");
  document.getElementById("backendStatus").style.whiteSpace = "pre-line";
  document.getElementById("statusDot").className = "status-dot";
}

async function activateDataset(datasetId) {
  try {
    await api(`/api/datasets/${encodeURIComponent(datasetId)}/activate`, { method: "POST" });
    state.selectedIds.clear();
    state.visibleDatasetIds.add(datasetId);
    await Promise.all([loadDatasets(), loadData(), loadStatus()]);
    syncMapMode();
    fitView();
    setNotice(`已切换到数据集“${state.activeDataset.name}”。`);
  } catch (error) {
    setNotice(`切换失败：${error.message}`);
  }
}

async function deleteDataset(dataset) {
  if (dataset.active) return;
  if (!window.confirm(`确定删除数据集“${dataset.name}”吗？`)) return;
  try {
    await api(`/api/datasets/${encodeURIComponent(dataset.id)}`, { method: "DELETE" });
    state.visibleDatasetIds.delete(dataset.id);
    await Promise.all([loadDatasets(), loadData(), loadStatus()]);
    setNotice(`已删除数据集“${dataset.name}”。`);
  } catch (error) {
    setNotice(`删除数据集失败：${error.message}`);
  }
}

async function importDataset(file) {
  const fileInput = document.getElementById("fileInput");
  const status = document.getElementById("datasetImportStatus");
  const setImportStatus = (message, kind = "") => {
    status.textContent = message;
    status.className = `dataset-import-status visible ${kind}`.trim();
  };
  fileInput.disabled = true;
  setImportStatus(`正在导入“${file.name}”，请稍候...`);
  try {
    const extension = file.name.toLowerCase().split(".").pop();
    if (["prj", "cpg", "shx", "dbf"].includes(extension)) {
      throw new Error(
        `“${file.name}”是 Shapefile 配套文件，不能单独导入；请与同名的 .shp/.shx/.dbf 成套选择（.prj/.cpg 可选）`
      );
    }
    const isBinary = extension === "zip" || extension === "shp";
    const content = isBinary
      ? arrayBufferToBase64(await file.arrayBuffer())
      : await file.text();
    if (!isBinary) JSON.parse(content);
    const sidecars = [];
    if (extension === "shp") {
      const baseName = file.name.slice(0, -(extension.length + 1)).toLowerCase();
      const related = Array.from(document.getElementById("fileInput").files || []);
      for (const candidate of related) {
        const candidateExtension = candidate.name.toLowerCase().split(".").pop();
        const candidateBase = candidate.name.slice(0, -(candidateExtension.length + 1)).toLowerCase();
        if (candidateBase === baseName && ["shx", "dbf", "prj", "cpg"].includes(candidateExtension)) {
          sidecars.push({
            file_name: candidate.name,
            content: arrayBufferToBase64(await candidate.arrayBuffer()),
          });
        }
      }
      if (!sidecars.some((item) => item.file_name.toLowerCase().endsWith(".shx")) ||
          !sidecars.some((item) => item.file_name.toLowerCase().endsWith(".dbf"))) {
        throw new Error("Shapefile 至少需要同时选择同名 .shp、.shx 和 .dbf 文件");
      }
    }
    const result = await api("/api/datasets/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_name: file.name, content, sidecars }),
    });
    state.selectedIds.clear();
    await Promise.all([loadDatasets(), loadData(), loadStatus()]);
    syncMapMode();
    fitView();
    const imported = result.dataset;
    state.visibleDatasetIds.add(imported.id);
    setNotice(`已导入“${file.name}”，后端已登记文件元数据。`);
    setImportStatus(
      `导入成功：${imported.feature_count} 个要素，${imported.format || "GeoJSON"}。`,
      "success",
    );
  } catch (error) {
    setNotice(`导入失败：${error.message}`);
    setImportStatus(`导入失败：${error.message}`, "error");
  } finally {
    fileInput.disabled = false;
  }
}

async function openMapDemo() {
  const button = document.getElementById("openMapDemoBtn");
  button.disabled = true;
  state.baseMapEnabled = true;
  try {
    await loadDatasets();
    const existing = state.datasets.find((dataset) => dataset.file_name === "map_demo.geojson");
    if (existing) {
      await activateDataset(existing.id);
      return;
    }
    const response = await fetch("/static/map_demo.geojson");
    if (!response.ok) throw new Error("无法读取地图示例文件");
    const file = new File([await response.blob()], "map_demo.geojson", {
      type: "application/geo+json",
    });
    await importDataset(file);
  } catch (error) {
    setNotice(`打开地图示例失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function renderLayers() {
  const counts = {};
  for (const feature of state.data.features) {
    const name = feature.properties.layer || "未命名";
    counts[name] = (counts[name] || 0) + 1;
  }

  const layerList = document.getElementById("layerList");
  layerList.innerHTML = "";

  Object.keys(counts).sort().forEach((name) => {
    const row = document.createElement("div");
    row.className = "layer-row";

    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.visibleLayers.has(name);
    input.addEventListener("change", () => {
      if (input.checked) {
        state.visibleLayers.add(name);
      } else {
        state.visibleLayers.delete(name);
      }
      draw();
    });
    const swatch = document.createElement("i");
    swatch.className = "layer-swatch";
    swatch.style.background = layerColors[name] || layerColors["自定义"];
    const labelText = document.createElement("span");
    labelText.textContent = name;
    label.append(input, swatch, labelText);

    const count = document.createElement("span");
    count.className = "layer-count";
    count.textContent = `${counts[name]} 个`;

    row.append(label, count);
    layerList.appendChild(row);
  });

  if (!Object.keys(counts).length) {
    layerList.innerHTML = '<div class="empty-layer">暂无图层数据</div>';
  }
  renderLayerOptions();
  updateStats();
}

function updateStats() {
  const layers = new Set(state.data.features.map((feature) => feature.properties.layer || "未命名"));
  document.getElementById("featureCount").textContent = state.data.features.length;
  document.getElementById("layerCount").textContent = layers.size;
  document.getElementById("selectionCount").textContent = state.selectedIds.size;
}

function setNotice(message) {
  document.getElementById("hint").textContent = message;
}

function selectedFeatures() {
  return state.data.features.filter((feature) => state.selectedIds.has(feature.id));
}

function selectFeatures(ids) {
  state.selectedIds = new Set(ids);
  // 编辑几何模式下，选中项就是编辑目标。表格点行、框选都会走到这里。
  if (state.mode === "edit") {
    const target = getSingleSelectedFeature();
    if (target) {
      if (target.id !== state.editFeatureId) enterGeometryEdit(target);
    } else {
      exitGeometryEdit();
    }
  }
  renderAttributes();
  draw();
}

function getSingleSelectedFeature() {
  const selected = selectedFeatures();
  return selected.length === 1 ? selected[0] : null;
}

/* ==========================================================================
   属性表：动态字段、全量行、行内编辑、字段增删
   ========================================================================== */

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function fieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

// 取一组要素 properties 键的并集。name / layer 排在前面，其余保持首次出现
// 的顺序（Array.prototype.sort 在 V8 里是稳定的）。Shapefile 导入的 DBF 字段
// 就是靠这里才第一次出现在界面上。
function collectFields(features) {
  const fields = [];
  const seen = new Set();
  for (const feature of features) {
    for (const key of Object.keys(feature.properties || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        fields.push(key);
      }
    }
  }
  return fields.sort((a, b) => {
    const indexA = PINNED_FIELDS.indexOf(a);
    const indexB = PINNED_FIELDS.indexOf(b);
    if (indexA === -1 && indexB === -1) return 0;
    return (indexA === -1 ? PINNED_FIELDS.length : indexA) -
      (indexB === -1 ? PINNED_FIELDS.length : indexB);
  });
}

function formatCellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// 保持字段原有的值类型：原本是数字且新文本仍能解析成有限数字时，继续存数字。
function coerceFieldValue(raw, original) {
  if (raw === formatCellValue(original)) return original;
  const text = raw.trim();
  if (original === null && text === "") return null;
  if (typeof original === "number" && text !== "") {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof original === "boolean" && /^(true|false)$/i.test(text)) {
    return text.toLowerCase() === "true";
  }
  if (original !== null && typeof original === "object") {
    try {
      return JSON.parse(text);
    } catch (error) {
      // Invalid JSON is kept as text so the value remains editable.
    }
  }
  return text;
}

function layerNames() {
  const names = new Set(Object.keys(layerColors));
  for (const feature of state.data.features) {
    if (feature.properties && feature.properties.layer) names.add(feature.properties.layer);
  }
  return Array.from(names);
}

// 图层名不再写死在 <select> 里：导入的数据集图层名是任意的（Shapefile 转换后
// 统一落到“未命名”），固定选项会让赋值静默变空。
function renderLayerOptions() {
  const datalist = document.getElementById("layerOptions");
  datalist.innerHTML = "";
  for (const name of layerNames()) {
    const option = document.createElement("option");
    option.value = name;
    datalist.appendChild(option);
  }
}

function attributeRows() {
  let rows = state.data.features;
  if (state.attributeFilter === "selected") {
    rows = rows.filter((feature) => state.selectedIds.has(feature.id));
  }
  const keyword = state.attributeSearch.trim().toLowerCase();
  if (keyword) {
    rows = rows.filter((feature) => {
      if (String(feature.id).toLowerCase().includes(keyword)) return true;
      if (feature.geometry.type.toLowerCase().includes(keyword)) return true;
      return Object.values(feature.properties || {})
        .some((value) => formatCellValue(value).toLowerCase().includes(keyword));
    });
  }
  return rows;
}

function makeHeaderCell(label, field) {
  const th = document.createElement("th");
  const inner = document.createElement("span");
  inner.className = "th-inner";
  const text = document.createElement("span");
  text.textContent = label;
  if (field) text.title = `字段：${field}`;
  inner.appendChild(text);
  if (field) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "field-remove";
    remove.textContent = "×";
    remove.title = `删除字段“${field}”（对全部要素生效）`;
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeField(field);
    });
    inner.appendChild(remove);
  }
  th.appendChild(inner);
  return th;
}

function renderAttributeTable() {
  const head = document.getElementById("attributeHead");
  const body = document.getElementById("attributeTableBody");
  const countLabel = document.getElementById("attributeCount");
  const pageInfo = document.getElementById("attributePageInfo");
  const fields = collectFields(state.data.features);
  const rows = attributeRows();
  const pageCount = Math.max(1, Math.ceil(rows.length / ATTRIBUTE_PAGE_SIZE));
  state.attributePage = Math.min(Math.max(1, state.attributePage), pageCount);
  const start = (state.attributePage - 1) * ATTRIBUTE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + ATTRIBUTE_PAGE_SIZE);

  countLabel.textContent = rows.length === state.data.features.length
    ? `共 ${rows.length} 个要素`
    : `筛选出 ${rows.length} / ${state.data.features.length} 个要素`;

  head.innerHTML = "";
  const headRow = document.createElement("tr");
  headRow.appendChild(makeHeaderCell("ID", null));
  for (const field of fields) headRow.appendChild(makeHeaderCell(fieldLabel(field), field));
  headRow.appendChild(makeHeaderCell("几何类型", null));
  head.appendChild(headRow);

  body.innerHTML = "";
  for (const feature of pageRows) {
    const row = document.createElement("tr");
    row.dataset.id = feature.id;
    row.tabIndex = 0;
    row.classList.toggle("active", state.selectedIds.has(feature.id));
    row.title = "单击选中；Ctrl 加选，Shift 范围选；双击单元格编辑属性";

    const idCell = document.createElement("td");
    idCell.className = "cell-id";
    idCell.textContent = feature.id;
    row.appendChild(idCell);

    for (const field of fields) {
      const cell = document.createElement("td");
      const value = (feature.properties || {})[field];
      const text = formatCellValue(value);
      cell.textContent = text;
      if (text) cell.title = text;
      else cell.classList.add("cell-empty");
      cell.dataset.field = field;
      cell.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        beginCellEdit(cell, feature, field);
      });
      row.appendChild(cell);
    }

    const typeCell = document.createElement("td");
    typeCell.textContent = feature.geometry.type;
    row.appendChild(typeCell);

    body.appendChild(row);
  }

  if (!pageRows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = fields.length + 2;
    cell.className = "empty-layer";
    cell.textContent = state.data.features.length
      ? "没有匹配的要素，换个搜索词或切回“全部”。"
      : "当前数据集还没有要素。";
    row.appendChild(cell);
    body.appendChild(row);
  }

  pageInfo.textContent = rows.length
    ? `第 ${state.attributePage} / ${pageCount} 页 · 本页 ${pageRows.length} 行 · 显示第 ${start + 1}-${start + pageRows.length} 行`
    : "没有可显示的行";
  document.getElementById("attributePrevBtn").disabled = state.attributePage <= 1;
  document.getElementById("attributeNextBtn").disabled = state.attributePage >= pageCount;
}

// 双击单元格 → 原地换成输入框 → Enter/失焦提交，Esc 取消。
function beginCellEdit(cell, feature, field) {
  if (cell.classList.contains("cell-editing")) return;
  const original = (feature.properties || {})[field];
  const input = document.createElement("input");
  input.type = "text";
  input.value = formatCellValue(original);
  cell.classList.add("cell-editing");
  cell.textContent = "";
  cell.appendChild(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const nextValue = coerceFieldValue(input.value, original);
    cell.classList.remove("cell-editing");
    if (!commit || nextValue === original) {
      renderAttributeTable();
      return;
    }
    try {
      await updateFeature({ ...feature, properties: { ...feature.properties, [field]: nextValue } });
      setNotice(`已更新 ${feature.id} 的字段“${field}”。`);
    } catch (error) {
      setNotice(`属性更新失败：${error.message}`);
    }
    renderAttributeTable();
  };

  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

// 字段级的批量改动（新增/删除字段）影响所有要素，用 /api/save 整份落库更合适。
async function persistAllFeatures(nextData, message) {
  await api("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextData),
  });
  state.data = nextData;
  state.dirty = false;
  renderLayers();
  renderAttributes();
  draw();
  setNotice(message);
}

async function addField() {
  const raw = window.prompt("新字段名（例如：备注 / code）", "");
  if (raw === null) return;
  const field = raw.trim();
  if (!field) {
    setNotice("字段名不能为空。");
    return;
  }
  if (collectFields(state.data.features).includes(field)) {
    setNotice(`字段“${field}”已经存在，直接双击单元格填写即可。`);
    return;
  }
  const nextData = deepCopy(state.data);
  for (const feature of nextData.features) {
    if (!feature.properties) feature.properties = {};
    feature.properties[field] = "";
  }
  try {
    await persistAllFeatures(nextData, `已新增字段“${field}”，双击单元格即可填写。`);
  } catch (error) {
    setNotice(`新增字段失败：${error.message}`);
  }
}

async function removeField(field) {
  const warning = PINNED_FIELDS.includes(field)
    ? `“${field}”是绘制和图层功能用到的字段，删除后相关要素会回退到默认值。确定删除吗？`
    : `确定从全部 ${state.data.features.length} 个要素中删除字段“${field}”吗？`;
  if (!window.confirm(warning)) return;
  const nextData = deepCopy(state.data);
  for (const feature of nextData.features) {
    if (feature.properties) delete feature.properties[field];
  }
  try {
    await persistAllFeatures(nextData, `已从全部要素中删除字段“${field}”。`);
  } catch (error) {
    setNotice(`删除字段失败：${error.message}`);
  }
}

/* ==========================================================================
   几何编辑：节点拖拽、整体平移、插入 / 删除节点
   ========================================================================== */

function isEditMode() {
  return state.mode === "edit" && Boolean(state.editFeatureId && state.editGeometry);
}

function getEditFeature() {
  if (!state.editFeatureId) return null;
  return state.data.features.find((feature) => feature.id === state.editFeatureId) || null;
}

function enterGeometryEdit(feature) {
  state.editFeatureId = feature.id;
  state.editGeometry = {
    type: feature.geometry.type,
    coordinates: deepCopy(feature.geometry.coordinates),
  };
  state.geometryHistory = [];
  state.vertexDrag = null;
  state.featureDrag = null;
  state.hoverVertexIndex = -1;
  syncGeometryControls();
}

function exitGeometryEdit() {
  state.editFeatureId = null;
  state.editGeometry = null;
  state.geometryHistory = [];
  state.vertexDrag = null;
  state.featureDrag = null;
  state.hoverVertexIndex = -1;
  syncGeometryControls();
}

function syncGeometryControls() {
  const editing = Boolean(state.editFeatureId && state.editGeometry);
  document.getElementById("endEditBtn").disabled = !editing;
  document.getElementById("undoGeometryBtn").disabled = !editing || !state.geometryHistory.length;
  canvas.classList.toggle("is-dragging-vertex", Boolean(state.vertexDrag || state.featureDrag));
  canvas.classList.toggle("is-over-vertex", state.hoverVertexIndex >= 0);
}

function getByPath(root, path) {
  let node = root;
  for (const step of path) node = node[step];
  return node;
}

function setByPath(root, path, value) {
  let node = root;
  for (let index = 0; index < path.length - 1; index += 1) node = node[path[index]];
  node[path[path.length - 1]] = value;
}

// Point 的 path 是空数组（coordinates 本身就是坐标），setByPath 处理不了，
// 所以统一走这个入口。
function applyVertexCoordinates(geometry, path, coord) {
  if (!path.length) {
    geometry.coordinates = coord;
    return;
  }
  setByPath(geometry.coordinates, path, coord);
}

// 返回几何里全部节点。path 是从 coordinates 出发的下标路径，这样点/线/多线/
// 面/多面可以共用同一套拖拽逻辑。
function extractVertices(geometry) {
  const vertices = [];
  const coordinates = geometry.coordinates;
  const push = (path, editable) => {
    vertices.push({ path, coord: getByPath(coordinates, path), editable });
  };

  if (geometry.type === "Point") {
    push([], true);
    return vertices;
  }
  if (geometry.type === "LineString") {
    coordinates.forEach((_, index) => push([index], true));
    return vertices;
  }
  if (geometry.type === "MultiLineString") {
    coordinates.forEach((line, lineIndex) => {
      line.forEach((_, pointIndex) => push([lineIndex, pointIndex], true));
    });
    return vertices;
  }
  if (geometry.type === "Polygon") {
    coordinates.forEach((ring, ringIndex) => {
      // 洞环（ringIndex > 0）只读，避免拖拽把洞结构弄坏。
      ring.forEach((_, pointIndex) => push([ringIndex, pointIndex], ringIndex === 0));
    });
    return vertices;
  }
  if (geometry.type === "MultiPolygon") {
    coordinates.forEach((polygon, polygonIndex) => {
      polygon.forEach((ring, ringIndex) => {
        ring.forEach((_, pointIndex) => push([polygonIndex, ringIndex, pointIndex], ringIndex === 0));
      });
    });
  }
  return vertices;
}

// 面环的首尾是同一个点。返回与给定 path 成对的那个 path（没有则 null），
// 拖动时两个点要一起动，否则环会裂开。
function closingTwinPath(geometry, path) {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return null;
  if (!path.length) return null;
  const ringPath = path.slice(0, -1);
  const index = path[path.length - 1];
  const ring = resolveRing(geometry, ringPath);
  if (!Array.isArray(ring) || ring.length < 2) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return null;
  if (index === 0) return [...ringPath, ring.length - 1];
  if (index === ring.length - 1) return [...ringPath, 0];
  return null;
}

function resolveRing(geometry, ringPath) {
  let ring = geometry.coordinates;
  for (const step of ringPath) ring = ring[step];
  return ring;
}

// 可编辑的坐标序列（外环 / 线），双击插点只在这些上面生效。
function editableRings(geometry) {
  const coordinates = geometry.coordinates;
  if (geometry.type === "LineString") return [{ path: [], ring: coordinates }];
  if (geometry.type === "MultiLineString") {
    return coordinates.map((ring, index) => ({ path: [index], ring }));
  }
  if (geometry.type === "Polygon") {
    return coordinates.length ? [{ path: [0], ring: coordinates[0] }] : [];
  }
  if (geometry.type === "MultiPolygon") {
    return coordinates
      .map((polygon, index) => (polygon.length ? { path: [index, 0], ring: polygon[0] } : null))
      .filter(Boolean);
  }
  return [];
}

function projectPointOnSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return [a[0], a[1]];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return [a[0] + t * dx, a[1] + t * dy];
}

function translateCoordinates(value, dx, dy) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    value[0] += dx;
    value[1] += dy;
    return;
  }
  for (const child of value) translateCoordinates(child, dx, dy);
}

function hitTestVertex(worldPoint) {
  if (!isEditMode()) return null;
  const tolerance = 9 / state.scale;
  const vertices = extractVertices(state.editGeometry);
  for (let index = vertices.length - 1; index >= 0; index -= 1) {
    const vertex = vertices[index];
    if (!vertex.editable) continue;
    if (Math.hypot(worldPoint[0] - vertex.coord[0], worldPoint[1] - vertex.coord[1]) <= tolerance) {
      return { index, vertex };
    }
  }
  return null;
}

function hitTestEdge(worldPoint) {
  if (!isEditMode()) return null;
  const tolerance = 10 / state.scale;
  let best = null;
  for (const entry of editableRings(state.editGeometry)) {
    for (let index = 0; index < entry.ring.length - 1; index += 1) {
      const a = entry.ring[index];
      const b = entry.ring[index + 1];
      const distance = distancePointToSegment(worldPoint, a, b);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = {
          distance,
          ringPath: entry.path,
          insertIndex: index + 1,
          coord: projectPointOnSegment(worldPoint, a, b),
        };
      }
    }
  }
  return best;
}

// 删除节点前的约束，与后端 validate_geometry_coordinates 保持一致：
// 线至少 2 个点；面环至少 4 个位置（3 个不重复点 + 闭合重复点）。
function vertexRemovalBlocker(geometry, path) {
  if (!path.length) return "点要素只有一个节点，无法删除。";
  const ringPath = path.slice(0, -1);
  const ring = resolveRing(geometry, ringPath);
  const isRing = geometry.type === "Polygon" || geometry.type === "MultiPolygon";
  const minimum = isRing ? 4 : 2;
  if (ring.length - 1 < minimum) {
    return isRing
      ? "面要素的行至少需要 3 个不重复节点，不能再删了。"
      : "线要素至少需要 2 个节点，不能再删了。";
  }
  return null;
}

function snapshotEditGeometry() {
  return {
    type: state.editGeometry.type,
    coordinates: deepCopy(state.editGeometry.coordinates),
  };
}

function removeEditVertex(path) {
  const geometry = state.editGeometry;
  if (!path.length) return;
  const ring = resolveRing(geometry, path.slice(0, -1));
  const index = path[path.length - 1];
  const isRing = geometry.type === "Polygon" || geometry.type === "MultiPolygon";

  if (!isRing) {
    ring.splice(index, 1);
    return;
  }

  // 闭合环的首尾是同一个点，直接 splice 一个位置会让环不再闭合（后端会拒）。
  // 所以先拆成不重复的点，删掉目标点后再重新闭合。
  const distinct = ring.slice(0, -1);
  distinct.splice(index === ring.length - 1 ? 0 : index, 1);
  distinct.push(deepCopy(distinct[0]));
  ring.length = 0;
  ring.push(...distinct);
}

function pushGeometryHistory(geometry) {
  state.geometryHistory.push(deepCopy(geometry));
  if (state.geometryHistory.length > GEOMETRY_HISTORY_LIMIT) state.geometryHistory.shift();
  syncGeometryControls();
}

// 每次改动在 mouseup 时立即落库，和删除 / 新增的既有行为保持一致。
async function commitGeometryChange(previousGeometry, message) {
  const feature = getEditFeature();
  if (!feature || !state.editGeometry) return;
  try {
    await updateFeature({ ...feature, geometry: deepCopy(state.editGeometry) });
    pushGeometryHistory(previousGeometry);
    setNotice(`${message}（节点数 ${extractVertices(state.editGeometry).length}，Ctrl+Z 可撤销）`);
  } catch (error) {
    state.editGeometry = {
      type: feature.geometry.type,
      coordinates: deepCopy(feature.geometry.coordinates),
    };
    setNotice(`几何保存失败：${error.message}`);
  }
  syncGeometryControls();
  draw();
}

async function undoGeometryEdit() {
  const feature = getEditFeature();
  if (!feature || !state.geometryHistory.length) {
    setNotice("没有可撤销的几何改动。");
    return;
  }
  const previous = state.geometryHistory.pop();
  state.editGeometry = { type: previous.type, coordinates: deepCopy(previous.coordinates) };
  syncGeometryControls();
  draw();
  try {
    await updateFeature({ ...feature, geometry: deepCopy(state.editGeometry) });
    setNotice("已撤销上一步几何编辑。");
  } catch (error) {
    state.geometryHistory.push(previous);
    setNotice(`撤销失败：${error.message}`);
  }
  syncGeometryControls();
}

function cancelGeometryDrag() {
  const drag = state.vertexDrag || state.featureDrag;
  if (!drag || !state.editGeometry) return;
  state.editGeometry.coordinates = deepCopy(drag.origin);
  state.vertexDrag = null;
  state.featureDrag = null;
  state.dragging = false;
  syncGeometryControls();
  setNotice("已放弃本次几何改动。");
  draw();
}

function drawEditHandles() {
  if (!isEditMode()) return;
  const vertices = extractVertices(state.editGeometry);
  ctx.save();
  ctx.lineWidth = 1.6;
  vertices.forEach((vertex, index) => {
    const point = worldToScreen(vertex.coord);
    const isHover = index === state.hoverVertexIndex;
    const isDragging = Boolean(state.vertexDrag) && state.vertexDrag.index === index;
    const size = isDragging ? 5 : isHover ? 4.5 : 3.5;
    ctx.beginPath();
    if (vertex.editable) {
      ctx.rect(point.x - size, point.y - size, size * 2, size * 2);
      ctx.fillStyle = isDragging ? "#f2c94c" : isHover ? "#176d6a" : "#ffffff";
      ctx.strokeStyle = "#176d6a";
    } else {
      ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#9fb3ad";
    }
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

function syncDraftControls() {
  const isDrawing = state.mode === "line" || state.mode === "polygon";
  document.getElementById("finishBtn").disabled = !isDrawing || state.draft.length < (state.mode === "line" ? 2 : 3);
  document.getElementById("undoDraftBtn").disabled = !isDrawing || !state.draft.length;
  document.getElementById("cancelDraftBtn").disabled = !isDrawing || !state.draft.length;
}

function clearDraft(message = "已取消当前绘制。 ") {
  state.draft = [];
  state.draftHover = null;
  syncDraftControls();
  if (message) setNotice(message);
  draw();
}

function drawGrid() {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#d3ddd9";
  ctx.fillStyle = "#728077";
  ctx.font = "12px Microsoft YaHei, Arial";

  for (let v = 0; v <= 1000; v += 100) {
    const a = worldToScreen([v, 0]);
    const b = worldToScreen([v, 1000]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    const c = worldToScreen([0, v]);
    const d = worldToScreen([1000, v]);
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#8fa19b";
  const p1 = worldToScreen([0, 0]);
  const p2 = worldToScreen([1000, 1000]);
  ctx.strokeRect(p1.x, p2.y, p2.x - p1.x, p1.y - p2.y);
  ctx.fillText("模拟平面坐标 0-1000", p1.x + 12, p2.y + 22);
  ctx.restore();
}

function drawFeature(feature) {
  const layer = feature.properties.layer || "未命名";
  if (!state.visibleLayers.has(layer)) return;

  // 正在编辑的要素改用工作副本绘制，拖动过程中形状才会跟着鼠标走。
  const geom = state.editGeometry && feature.id === state.editFeatureId
    ? state.editGeometry
    : feature.geometry;
  const selected = state.selectedIds.has(feature.id);
  const color = layerColors[layer] || layerColors["自定义"];

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = selected ? "#f2c94c" : color;
  ctx.fillStyle = selected ? "rgba(242, 201, 76, 0.35)" : `${color}40`;
  ctx.lineWidth = selected ? 5 : 2.4;

  if (geom.type === "Point") {
    const p = worldToScreen(geom.coordinates);
    ctx.beginPath();
    ctx.arc(p.x, p.y, selected ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = selected ? "#f2c94c" : color;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (geom.type === "LineString") {
    drawPath(geom.coordinates, false);
    ctx.stroke();
  }

  if (geom.type === "MultiLineString") {
    for (const line of geom.coordinates) {
      drawPath(line, false);
      ctx.stroke();
    }
  }

  if (geom.type === "Polygon") {
    ctx.beginPath();
    for (const ring of geom.coordinates) drawRingPath(ring);
    ctx.fill("evenodd");
    ctx.stroke();
  }

  if (geom.type === "MultiPolygon") {
    for (const polygon of geom.coordinates) {
      ctx.beginPath();
      for (const ring of polygon) drawRingPath(ring);
      ctx.fill("evenodd");
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawPath(coords, closed) {
  ctx.beginPath();
  coords.forEach((coord, index) => {
    const p = worldToScreen(coord);
    if (index === 0) {
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
  });
  if (closed) ctx.closePath();
}

// 追加一个闭合环到当前 path（调用方需已 beginPath）。外环与洞环画在同一个
// path 里，配合 fill("evenodd") 才能把洞真正挖空；无洞数据行为与原来一致。
function drawRingPath(ring) {
  ring.forEach((coord, index) => {
    const p = worldToScreen(coord);
    if (index === 0) {
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
  });
  ctx.closePath();
}

function drawDraft() {
  if (!state.draft.length) return;
  ctx.save();
  ctx.strokeStyle = "#176d6a";
  ctx.fillStyle = "#176d6a";
  ctx.lineWidth = 2;

  if (state.draft.length > 1) {
    drawPath(state.draft, state.mode === "polygon");
    ctx.stroke();
  }

  if (state.draftHover && (state.mode === "line" || state.mode === "polygon")) {
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.globalAlpha = 0.65;
    drawPath([...state.draft, state.draftHover], false);
    ctx.stroke();
    ctx.restore();
  }

  for (const coord of state.draft) {
    const p = worldToScreen(coord);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawSelectionBox() {
  if (!state.boxStart || !state.boxEnd) return;
  const x = Math.min(state.boxStart.x, state.boxEnd.x);
  const y = Math.min(state.boxStart.y, state.boxEnd.y);
  const w = Math.abs(state.boxStart.x - state.boxEnd.x);
  const h = Math.abs(state.boxStart.y - state.boxEnd.y);
  ctx.save();
  ctx.fillStyle = "rgba(23, 109, 106, 0.12)";
  ctx.strokeStyle = "#176d6a";
  ctx.setLineDash([6, 4]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function draw() {
  renderBasemapTiles();
  ctx.clearRect(0, 0, state.viewWidth, state.viewHeight);
  if (!state.geographic) drawGrid();
  for (const feature of state.data.features) {
    drawFeature(feature);
  }
  drawDraft();
  drawSelectionBox();
  drawEditHandles();
}

function distancePointToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distancePointToRing(point, ring) {
  let distance = Infinity;
  for (let index = 1; index < ring.length; index += 1) {
    distance = Math.min(distance, distancePointToSegment(point, ring[index - 1], ring[index]));
  }
  return distance;
}

function pointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function hitTest(worldPoint) {
  const tolerance = 12 / state.scale;
  for (let i = state.data.features.length - 1; i >= 0; i--) {
    const feature = state.data.features[i];
    const layer = feature.properties.layer || "未命名";
    if (!state.visibleLayers.has(layer)) continue;

    const geom = feature.geometry;
    if (geom.type === "Point" && Math.hypot(worldPoint[0] - geom.coordinates[0], worldPoint[1] - geom.coordinates[1]) <= tolerance) {
      return feature;
    }
    if (geom.type === "LineString") {
      for (let s = 1; s < geom.coordinates.length; s++) {
        if (distancePointToSegment(worldPoint, geom.coordinates[s - 1], geom.coordinates[s]) <= tolerance) {
          return feature;
        }
      }
    }
    if (geom.type === "MultiLineString") {
      for (const line of geom.coordinates) {
        for (let s = 1; s < line.length; s++) {
          if (distancePointToSegment(worldPoint, line[s - 1], line[s]) <= tolerance) {
            return feature;
          }
        }
      }
    }
    if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
      const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      if (polygons.some((polygon) => {
        const ring = polygon[0];
        return pointInPolygon(worldPoint, ring) || distancePointToRing(worldPoint, ring) <= tolerance;
      })) {
        return feature;
      }
    }
  }
  return null;
}

function getBounds(feature) {
  const coords = [];
  const geom = feature.geometry;
  if (geom.type === "Point") coords.push(geom.coordinates);
  if (geom.type === "LineString") coords.push(...geom.coordinates);
  if (geom.type === "Polygon") coords.push(...geom.coordinates[0]);
  if (geom.type === "MultiLineString") coords.push(...geom.coordinates.flat());
  if (geom.type === "MultiPolygon") coords.push(...geom.coordinates.flat(2));
  return coords.reduce((acc, coord) => ({
    minX: Math.min(acc.minX, coord[0]),
    minY: Math.min(acc.minY, coord[1]),
    maxX: Math.max(acc.maxX, coord[0]),
    maxY: Math.max(acc.maxY, coord[1]),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function getDataBounds() {
  if (!state.data.features.length) {
    return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  }

  return state.data.features.reduce((acc, feature) => {
    const bounds = getBounds(feature);
    return {
      minX: Math.min(acc.minX, bounds.minX),
      minY: Math.min(acc.minY, bounds.minY),
      maxX: Math.max(acc.maxX, bounds.maxX),
      maxY: Math.max(acc.maxY, bounds.maxY),
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function fitView() {
  const dataBounds = getDataBounds();
  const lowerLeft = projectWorld([dataBounds.minX, dataBounds.minY]);
  const upperRight = projectWorld([dataBounds.maxX, dataBounds.maxY]);
  const padding = 72;
  const minimumSpan = state.geographic ? 0.01 : 1;
  const width = Math.max(minimumSpan, upperRight[0] - lowerLeft[0]);
  const height = Math.max(minimumSpan, upperRight[1] - lowerLeft[1]);
  const minimumScale = state.geographic ? TILE_SIZE / 360 : 0.00001;
  const maximumScale = state.geographic ? TILE_SIZE * 2 ** MAX_TILE_ZOOM / 360 : 3.5;
  state.scale = Math.max(minimumScale, Math.min(maximumScale,
    Math.min((state.viewWidth - padding * 2) / width, (state.viewHeight - padding * 2) / height)));
  state.offsetX = state.viewWidth / 2 - (lowerLeft[0] + upperRight[0]) / 2 * state.scale;
  state.offsetY = state.viewHeight / 2 - (lowerLeft[1] + upperRight[1]) / 2 * state.scale;
  draw();
}

function selectByBox(a, b) {
  const minX = Math.min(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxX = Math.max(a[0], b[0]);
  const maxY = Math.max(a[1], b[1]);
  state.selectedIds.clear();

  for (const feature of state.data.features) {
    const layer = feature.properties.layer || "未命名";
    if (!state.visibleLayers.has(layer)) continue;
    const bounds = getBounds(feature);
    const intersects = bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxY >= minY && bounds.minY <= maxY;
    if (intersects) state.selectedIds.add(feature.id);
  }
  renderAttributes();
}

function renderEditor(selected) {
  const editor = document.getElementById("selectionEditor");
  const fieldList = document.getElementById("editFieldList");
  const updateButton = document.getElementById("updateFeatureBtn");
  const stateLabel = document.getElementById("editorState");
  const typeChip = document.getElementById("editorType");
  const meta = document.getElementById("editorMeta");
  const feature = selected.length === 1 ? selected[0] : null;

  editor.classList.toggle("is-empty", !feature);
  updateButton.disabled = !feature;
  fieldList.innerHTML = "";

  if (!feature) {
    stateLabel.textContent = selected.length > 1 ? "多选状态" : "未选择";
    typeChip.textContent = "—";
    meta.textContent = selected.length > 1
      ? "已选择多个要素；请点选表格中的一行编辑单个要素。"
      : "点选一行要素开始编辑。";
    const empty = document.createElement("p");
    empty.className = "empty-layer";
    empty.textContent = selected.length > 1
      ? "多选状态下可以批量删除，改属性请先单选一个要素。"
      : "点选一个要素后编辑属性。";
    fieldList.appendChild(empty);
    return;
  }

  stateLabel.textContent = "单要素编辑";
  typeChip.textContent = feature.geometry.type;
  meta.textContent = `${feature.id} · ${formatFeatureCoordinates(feature)}`;

  // 表单按要素的真实字段渲染：导入的 Shapefile 有哪几列 DBF 字段，这里就出几栏。
  for (const field of collectFields([feature])) {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.className = "editor-field-name";
    // 已知字段显示「中文名 · 原始键」，导入的 DBF 字段没有中文名，只显示原始键，
    // 否则会出现 “NAME · NAME”。
    const human = FIELD_LABELS[field];
    caption.textContent = human ? `${human} · ${field}` : field;
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.field = field;
    input.value = formatCellValue(feature.properties[field]);
    if (field === "layer") input.setAttribute("list", "layerOptions");
    label.append(caption, input);
    fieldList.appendChild(label);
  }
}

function formatFeatureCoordinates(feature) {
  const geometry = feature.geometry;
  if (geometry.type === "Point") {
    return `${geometry.coordinates[0].toFixed(1)}, ${geometry.coordinates[1].toFixed(1)}`;
  }
  return `${extractVertices(geometry).length} 个节点`;
}

function renderAttributes() {
  const selected = selectedFeatures();
  const summary = document.getElementById("selectionSummary");
  const head = document.getElementById("selectionHead");
  const body = document.getElementById("attributeBody");
  const names = selected.slice(0, 2).map((feature) => feature.properties.name || feature.id);
  const suffix = selected.length > 2 ? " 等" : "";
  summary.textContent = selected.length
    ? `已选择 ${selected.length} 个要素：${names.join("、")}${suffix}`
    : "暂无选择";

  // 列表跟随选中要素的真实字段，最多展示前 5 列，避免 326px 的窄栏挤爆。
  const fields = collectFields(selected).slice(0, 5);
  head.innerHTML = "";
  const headRow = document.createElement("tr");
  for (const column of ["ID", ...fields.map(fieldLabel), "类型"]) {
    const th = document.createElement("th");
    th.textContent = column;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);

  body.innerHTML = "";
  document.getElementById("deleteSelectionBtn").disabled = !selected.length;
  updateStats();
  renderEditor(selected);
  renderAttributeTable();

  for (const feature of selected) {
    const row = document.createElement("tr");
    row.dataset.id = feature.id;
    row.tabIndex = 0;
    row.classList.toggle("active", selected.length === 1);
    row.title = "点击编辑这个要素";
    const cells = [
      feature.id,
      ...fields.map((field) => formatCellValue((feature.properties || {})[field])),
      feature.geometry.type,
    ];
    for (const cell of cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      row.appendChild(td);
    }
    body.appendChild(row);
  }
}

function setMode(mode) {
  state.mode = mode;
  state.draft = [];
  state.draftHover = null;
  state.boxStart = null;
  state.boxEnd = null;
  document.querySelectorAll(".tool").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  canvas.className = `mode-${mode}`;
  syncDraftControls();

  // 编辑几何需要恰好一个选中要素作为编辑目标。
  if (mode === "edit") {
    const target = getSingleSelectedFeature();
    if (target) {
      enterGeometryEdit(target);
      setNotice(hints.edit);
    } else {
      exitGeometryEdit();
      setNotice("当前：编辑几何。请先用“点选”选中一个要素，再切回“编辑几何”。");
    }
  } else {
    exitGeometryEdit();
    setNotice(hints[mode]);
  }

  syncGeometryControls();
  draw();
}

function makeFeature(geometry) {
  const layer = document.getElementById("layerInput").value;
  const name = document.getElementById("nameInput").value.trim() || "未命名要素";
  return {
    type: "Feature",
    properties: { name, layer, kind: geometry.type.toLowerCase() },
    geometry,
  };
}

async function addFeature(geometry) {
  const feature = makeFeature(geometry);
  const result = await api("/api/features", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feature }),
  });
  state.data.features.push(result.feature);
  state.visibleLayers.add(result.feature.properties.layer || "未命名");
  state.selectedIds = new Set([result.feature.id]);
  state.dirty = false;
  renderLayers();
  renderAttributes();
  setNotice(`已新增“${result.feature.properties.name}”，可继续绘制或保存。`);
  draw();
}

async function updateFeature(feature) {
  const result = await api(`/api/features/${encodeURIComponent(feature.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feature }),
  });
  const index = state.data.features.findIndex((item) => item.id === feature.id);
  if (index !== -1) state.data.features[index] = result.feature;
  state.visibleLayers.add(result.feature.properties.layer || "未命名");
  state.dirty = false;
  renderLayers();
  renderAttributes();
  draw();
}

async function finishDraft() {
  const draftSize = state.draft.length;
  if (state.mode === "line" && state.draft.length >= 2) {
    await addFeature({ type: "LineString", coordinates: state.draft });
    state.draft = [];
    setNotice("折线已完成并保存。可以继续绘制或切换工具。 ");
  }

  if (state.mode === "line" && draftSize < 2) {
    setNotice("画线至少需要 2 个节点。继续点击地图添加节点。 ");
  }

  if (state.mode === "polygon" && state.draft.length >= 3) {
    const ring = [...state.draft, state.draft[0]];
    await addFeature({ type: "Polygon", coordinates: [ring] });
    state.draft = [];
    setNotice("面要素已完成并保存。可以继续绘制或切换工具。 ");
  }

  if (state.mode === "polygon" && draftSize < 3) {
    setNotice("画面至少需要 3 个节点。继续点击地图添加节点。 ");
  }

  state.draftHover = null;
  syncDraftControls();
  draw();
}

function zoomAt(screenX, screenY, factor) {
  const before = screenToWorld(screenX, screenY);
  const minimumScale = state.geographic ? TILE_SIZE / 360 : 0.00001;
  const maximumScale = state.geographic ? TILE_SIZE * 2 ** MAX_TILE_ZOOM / 360 : 3.5;
  state.scale = Math.max(minimumScale, Math.min(maximumScale, state.scale * factor));
  const afterScreen = worldToScreen(before);
  state.offsetX += screenX - afterScreen.x;
  state.offsetY -= screenY - afterScreen.y;
  draw();
}

// 编辑几何模式的按下处理：节点拖拽 / 整体平移 / Alt+点击删节点。
function handleEditMouseDown(event, world) {
  if (!isEditMode()) return;

  const vertexHit = hitTestVertex(world);
  if (event.altKey) {
    if (!vertexHit) return;
    event.preventDefault();
    const blocker = vertexRemovalBlocker(state.editGeometry, vertexHit.vertex.path);
    if (blocker) {
      setNotice(blocker);
      return;
    }
    const previous = snapshotEditGeometry();
    removeEditVertex(vertexHit.vertex.path);
    state.hoverVertexIndex = -1;
    state.skipClickOnce = true;
    draw();
    commitGeometryChange(previous, "已删除一个节点。");
    return;
  }

  if (vertexHit) {
    state.vertexDrag = {
      index: vertexHit.index,
      path: vertexHit.vertex.path,
      // 面环首尾是同一个点，拖一个另一个要跟着走，否则环会裂开。
      twinPath: closingTwinPath(state.editGeometry, vertexHit.vertex.path),
      origin: deepCopy(state.editGeometry.coordinates),
      moved: false,
    };
    state.dragging = true;
    syncGeometryControls();
    return;
  }

  // 落在当前编辑要素的本体上（而不是节点上）→ 整体平移。
  const featureHit = hitTest(world);
  if (featureHit && featureHit.id === state.editFeatureId) {
    state.featureDrag = {
      startWorld: world,
      origin: deepCopy(state.editGeometry.coordinates),
      moved: false,
    };
    state.dragging = true;
    syncGeometryControls();
  }
}

canvas.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  if (state.mode === "edit") {
    handleEditMouseDown(event, screenToWorld(x, y));
    return;
  }

  state.dragging = true;
  state.dragStart = { x, y, offsetX: state.offsetX, offsetY: state.offsetY };
  if (state.mode === "box") {
    state.boxStart = { x, y };
    state.boxEnd = { x, y };
  }
});

canvas.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const world = screenToWorld(x, y);
  document.getElementById("coordinateReadout").textContent = `X ${world[0].toFixed(1)} · Y ${world[1].toFixed(1)}`;

  // 拖节点：每次都从 origin 重建，避免累计误差。
  if (state.vertexDrag && state.editGeometry) {
    const drag = state.vertexDrag;
    state.editGeometry.coordinates = deepCopy(drag.origin);
    applyVertexCoordinates(state.editGeometry, drag.path, [world[0], world[1]]);
    if (drag.twinPath) {
      applyVertexCoordinates(state.editGeometry, drag.twinPath, [world[0], world[1]]);
    }
    drag.moved = true;
    draw();
    return;
  }

  // 拖要素本体：整体平移。
  if (state.featureDrag && state.editGeometry) {
    const drag = state.featureDrag;
    state.editGeometry.coordinates = deepCopy(drag.origin);
    translateCoordinates(
      state.editGeometry.coordinates,
      world[0] - drag.startWorld[0],
      world[1] - drag.startWorld[1],
    );
    drag.moved = true;
    draw();
    return;
  }

  if (state.mode === "edit" && isEditMode()) {
    const hit = hitTestVertex(world);
    const nextIndex = hit ? hit.index : -1;
    if (nextIndex !== state.hoverVertexIndex) {
      state.hoverVertexIndex = nextIndex;
      syncGeometryControls();
      draw();
    }
  }

  if (state.mode === "line" || state.mode === "polygon") {
    state.draftHover = world;
  }

  if (state.dragging && state.mode === "pan") {
    state.offsetX = state.dragStart.offsetX + x - state.dragStart.x;
    state.offsetY = state.dragStart.offsetY - (y - state.dragStart.y);
    draw();
  }

  if (state.dragging && state.mode === "box") {
    state.boxEnd = { x, y };
    draw();
  }

  if ((state.mode === "line" || state.mode === "polygon") && state.draft.length) {
    draw();
  }
});

canvas.addEventListener("mouseup", async (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  if (state.vertexDrag && state.editGeometry) {
    const drag = state.vertexDrag;
    state.vertexDrag = null;
    state.dragging = false;
    syncGeometryControls();
    if (drag.moved) {
      state.skipClickOnce = true;
      await commitGeometryChange({ type: state.editGeometry.type, coordinates: drag.origin }, "已移动节点。");
    }
    draw();
    return;
  }

  if (state.featureDrag && state.editGeometry) {
    const drag = state.featureDrag;
    state.featureDrag = null;
    state.dragging = false;
    syncGeometryControls();
    if (drag.moved) {
      state.skipClickOnce = true;
      await commitGeometryChange({ type: state.editGeometry.type, coordinates: drag.origin }, "已平移要素。");
    }
    draw();
    return;
  }

  if (state.mode === "box" && state.boxStart) {
    const a = screenToWorld(state.boxStart.x, state.boxStart.y);
    const b = screenToWorld(x, y);
    selectByBox(a, b);
    state.boxStart = null;
    state.boxEnd = null;
    state.dragging = false;
    draw();
  }

  state.dragging = false;
});

canvas.addEventListener("click", async (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const world = screenToWorld(x, y);

  if (state.mode === "edit") {
    // 拖拽结束后浏览器还会补一个 click，别让它把编辑目标切掉。
    if (state.skipClickOnce) {
      state.skipClickOnce = false;
      return;
    }
    if (event.altKey) return;
    const feature = hitTest(world);
    if (feature) {
      if (feature.id !== state.editFeatureId) selectFeatures([feature.id]);
    } else if (state.editFeatureId) {
      selectFeatures([]);
    }
    return;
  }

  if (state.mode === "point") {
    await addFeature({ type: "Point", coordinates: world });
  }

  if (state.mode === "line" || state.mode === "polygon") {
    state.draft.push(world);
    state.draftHover = null;
    syncDraftControls();
    draw();
  }

  if (state.mode === "select") {
    const feature = hitTest(world);
    selectFeatures(feature ? [feature.id] : []);
  }
});

canvas.addEventListener("dblclick", (event) => {
  if (state.mode !== "edit" || !isEditMode()) return;
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  // 落在已有节点上就不插点，否则会插出一个重叠节点。
  if (hitTestVertex(world)) return;
  const edge = hitTestEdge(world);
  if (!edge) return;
  event.preventDefault();
  const previous = snapshotEditGeometry();
  resolveRing(state.editGeometry, edge.ringPath).splice(edge.insertIndex, 0, edge.coord);
  draw();
  commitGeometryChange(previous, "已插入一个节点。");
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  zoomAt(x, y, event.deltaY < 0 ? 1.12 : 0.88);
});

canvas.addEventListener("mouseleave", () => {
  if (state.mode === "line" || state.mode === "polygon") {
    state.draftHover = null;
    draw();
  }
  if (state.hoverVertexIndex >= 0) {
    state.hoverVertexIndex = -1;
    syncGeometryControls();
    draw();
  }
});

window.addEventListener("keydown", (event) => {
  // 在输入框里打字（属性表单元格、搜索框、属性表单）时不要抢快捷键。
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement) {
    return;
  }
  const isUndo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z";
  // 撤销优先作用在正在绘制、还没提交的草稿上；没有草稿时才撤销几何编辑。
  if (isUndo && state.draft.length) {
    event.preventDefault();
    document.getElementById("undoDraftBtn").click();
    return;
  }
  if (isUndo && state.geometryHistory.length) {
    event.preventDefault();
    undoGeometryEdit();
    return;
  }
  if (event.key !== "Escape") return;
  if (state.draft.length) {
    clearDraft();
    return;
  }
  if (state.vertexDrag || state.featureDrag) {
    cancelGeometryDrag();
  }
});

document.querySelectorAll(".tool").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

document.getElementById("finishBtn").addEventListener("click", async () => {
  try {
    await finishDraft();
  } catch (error) {
    setNotice(`绘制保存失败：${error.message}`);
  }
});
document.getElementById("undoDraftBtn").addEventListener("click", () => {
  if (!state.draft.length) return;
  state.draft.pop();
  state.draftHover = null;
  syncDraftControls();
  setNotice(`已撤销节点，还剩 ${state.draft.length} 个节点。 `);
  draw();
});
document.getElementById("cancelDraftBtn").addEventListener("click", () => clearDraft());
document.getElementById("undoGeometryBtn").addEventListener("click", () => undoGeometryEdit());
document.getElementById("endEditBtn").addEventListener("click", () => setMode("select"));
document.getElementById("zoomInBtn").addEventListener("click", () => zoomAt(state.viewWidth / 2, state.viewHeight / 2, 1.2));
document.getElementById("zoomOutBtn").addEventListener("click", () => zoomAt(state.viewWidth / 2, state.viewHeight / 2, 0.82));
document.getElementById("fitBtn").addEventListener("click", fitView);
document.getElementById("baseMapBtn").addEventListener("click", () => {
  if (!state.geographic) return;
  state.baseMapEnabled = !state.baseMapEnabled;
  syncMapMode();
  setNotice(state.baseMapEnabled ? "已显示在线地图底图。" : "已隐藏在线地图底图。");
});
document.getElementById("openMapDemoBtn").addEventListener("click", openMapDemo);
document.getElementById("fileInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files || []);
  const shp = files.find((file) => file.name.toLowerCase().endsWith(".shp"));
  const selected = shp || files[0];
  if (selected) importDataset(selected).finally(() => {
    event.target.value = "";
  });
});

document.getElementById("showAllBtn").addEventListener("click", () => {
  state.visibleLayers = new Set(state.data.features.map((feature) => feature.properties.layer || "未命名"));
  renderLayers();
  draw();
  setNotice("已显示全部图层。 ");
});

document.getElementById("hideAllBtn").addEventListener("click", () => {
  state.visibleLayers.clear();
  renderLayers();
  draw();
  setNotice("已隐藏全部图层。 ");
});

document.getElementById("clearSelectionBtn").addEventListener("click", () => {
  selectFeatures([]);
  setNotice("已清除选择。 ");
});

document.getElementById("attributeBody").addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-id]");
  if (row) selectFeatures([row.dataset.id]);
});

document.getElementById("attributeBody").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-id]");
  if (!row) return;
  event.preventDefault();
  selectFeatures([row.dataset.id]);
});

document.getElementById("updateFeatureBtn").addEventListener("click", async () => {
  const feature = getSingleSelectedFeature();
  if (!feature) return;
  // 表单里的输入框是按要素真实字段动态生成的，这里照单全收。
  const properties = { ...feature.properties };
  for (const input of document.querySelectorAll("#editFieldList input[data-field]")) {
    const field = input.dataset.field;
    properties[field] = coerceFieldValue(input.value, feature.properties[field]);
  }
  if (properties.name !== undefined && !String(properties.name).trim()) {
    setNotice("名称不能为空。");
    return;
  }
  try {
    await updateFeature({ ...feature, properties });
    setNotice(`已保存 ${feature.id} 的属性修改。`);
  } catch (error) {
    setNotice(`属性更新失败：${error.message}`);
  }
});

document.getElementById("deleteSelectionBtn").addEventListener("click", async () => {
  const selected = selectedFeatures();
  if (!selected.length) return;
  const button = document.getElementById("deleteSelectionBtn");
  button.disabled = true;
  const selectedIds = new Set(selected.map((feature) => feature.id));
  const nextData = {
    ...state.data,
    features: state.data.features.filter((feature) => !selectedIds.has(feature.id)),
  };
  try {
    await api("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextData),
    });
    state.data = nextData;
    for (const id of selectedIds) state.selectedIds.delete(id);
    state.dirty = false;
    // 删掉的正好是编辑目标时，编辑状态必须一并清掉，否则会画出悬空节点。
    if (!getEditFeature()) exitGeometryEdit();
    renderLayers();
    renderAttributes();
    draw();
    setNotice(`已删除 ${selected.length} 个要素。 `);
  } catch (error) {
    renderAttributes();
    setNotice(`删除失败：${error.message}`);
  }
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  try {
    await api("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.data),
    });
    state.dirty = false;
    setNotice("已保存到后端 GeoJSON 文件。 ");
  } catch (error) {
    setNotice(`保存失败：${error.message}`);
  }
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  const result = await api("/api/reset", { method: "POST" });
  state.data = result.data;
  state.geographic = false;
  state.visibleLayers = new Set(state.data.features.map((feature) => feature.properties.layer || "未命名"));
  state.selectedIds.clear();
  state.draft = [];
  state.draftHover = null;
  state.dirty = false;
  exitGeometryEdit();
  state.attributePage = 1;
  renderLayers();
  renderAttributes();
  syncDraftControls();
  await Promise.all([loadDatasets(), loadStatus()]);
  syncMapMode();
  fitView();
  setNotice("数据已重置为示例内容。 ");
  draw();
});

/* ---------- 底部属性表抽屉的交互 ---------- */

document.getElementById("drawerToggleBtn").addEventListener("click", () => {
  state.drawerOpen = !state.drawerOpen;
  document.getElementById("attributeDrawer").classList.toggle("collapsed", !state.drawerOpen);
  document.getElementById("drawerToggleBtn").setAttribute("aria-expanded", String(state.drawerOpen));
});

document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.attributeFilter = button.dataset.filter;
    state.attributePage = 1;
    document.querySelectorAll(".filter-button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    renderAttributeTable();
  });
});

document.getElementById("attributeSearch").addEventListener("input", (event) => {
  state.attributeSearch = event.target.value;
  state.attributePage = 1;
  renderAttributeTable();
});

document.getElementById("addFieldBtn").addEventListener("click", () => addField());
document.getElementById("attributePrevBtn").addEventListener("click", () => {
  state.attributePage = Math.max(1, state.attributePage - 1);
  renderAttributeTable();
});
document.getElementById("attributeNextBtn").addEventListener("click", () => {
  state.attributePage += 1;
  renderAttributeTable();
});

document.getElementById("attributeTableBody").addEventListener("click", (event) => {
  // 正在编辑的单元格不要触发选中切换，否则输入框会被重渲染掉。
  if (event.target.closest("td.cell-editing")) return;
  const row = event.target.closest("tr[data-id]");
  if (!row) return;
  const id = row.dataset.id;

  if (event.ctrlKey || event.metaKey) {
    const next = new Set(state.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectFeatures(next);
  } else if (event.shiftKey && state.lastRowClickId) {
    // 范围选要在重渲染之前把行序算出来。
    const rows = attributeRows();
    const from = rows.findIndex((feature) => feature.id === state.lastRowClickId);
    const to = rows.findIndex((feature) => feature.id === id);
    if (from !== -1 && to !== -1) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      selectFeatures(rows.slice(start, end + 1).map((feature) => feature.id));
    } else {
      selectFeatures([id]);
    }
  } else {
    selectFeatures([id]);
  }
  state.lastRowClickId = id;
});

window.addEventListener("resize", resizeCanvas);

Promise.all([loadDatasets(), loadData(), loadStatus()]).then(() => {
  resizeCanvas();
  syncMapMode();
  fitView();
}).catch((error) => {
  document.getElementById("backendStatus").textContent = `连接失败：${error.message}`;
  document.getElementById("statusDot").className = "status-dot error";
  setNotice("无法连接后端，请确认 server.py 已启动。 ");
});
