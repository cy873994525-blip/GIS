const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");

const state = {
  data: { type: "FeatureCollection", features: [] },
  datasets: [],
  activeDataset: null,
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
};

function worldToScreen(coord) {
  return {
    x: coord[0] * state.scale + state.offsetX,
    y: state.viewHeight - (coord[1] * state.scale + state.offsetY),
  };
}

function screenToWorld(x, y) {
  return [
    (x - state.offsetX) / state.scale,
    ((state.viewHeight - y) - state.offsetY) / state.scale,
  ];
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

    const button = document.createElement("button");
    button.className = "dataset-switch";
    button.type = "button";
    button.textContent = dataset.active ? "当前" : "切换";
    button.disabled = dataset.active;
    button.addEventListener("click", () => activateDataset(dataset.id));
    row.append(info, button);
    list.appendChild(row);
  }

  if (state.activeDataset) {
    const types = state.activeDataset.geometry_types.join("、") || "暂无几何";
    meta.innerHTML = [
      `<strong>当前：${state.activeDataset.name}</strong>`,
      `<span>${state.activeDataset.file_name} · ${formatBytes(state.activeDataset.size_bytes)}</span>`,
      `<span>几何：${types}</span>`,
    ].join("");
  } else {
    meta.textContent = "暂无当前数据集";
  }
}

async function loadDatasets() {
  const result = await api("/api/datasets");
  state.datasets = result.datasets;
  state.activeDataset = state.datasets.find((dataset) => dataset.active) || null;
  renderDatasets();
}

async function loadData() {
  state.data = await api("/api/layers");
  const layers = new Set(state.data.features.map((f) => f.properties.layer || "未命名"));
  state.visibleLayers = layers;
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
    await Promise.all([loadDatasets(), loadData(), loadStatus()]);
    fitView();
    setNotice(`已切换到数据集“${state.activeDataset.name}”。`);
  } catch (error) {
    setNotice(`切换失败：${error.message}`);
  }
}

async function importDataset(file) {
  try {
    const content = await file.text();
    JSON.parse(content);
    await api("/api/datasets/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_name: file.name, content }),
    });
    state.selectedIds.clear();
    await Promise.all([loadDatasets(), loadData(), loadStatus()]);
    fitView();
    setNotice(`已导入“${file.name}”，后端已登记文件元数据。`);
  } catch (error) {
    setNotice(`导入失败：${error.message}`);
  }
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
  renderAttributes();
  draw();
}

function getSingleSelectedFeature() {
  const selected = selectedFeatures();
  return selected.length === 1 ? selected[0] : null;
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

  const geom = feature.geometry;
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

  if (geom.type === "Polygon") {
    drawPath(geom.coordinates[0], true);
    ctx.fill();
    ctx.stroke();
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
  ctx.clearRect(0, 0, state.viewWidth, state.viewHeight);
  drawGrid();
  for (const feature of state.data.features) {
    drawFeature(feature);
  }
  drawDraft();
  drawSelectionBox();
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
    if (geom.type === "Polygon") {
      const ring = geom.coordinates[0];
      if (pointInPolygon(worldPoint, ring) || distancePointToRing(worldPoint, ring) <= tolerance) {
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
  const bounds = getDataBounds();
  const padding = 72;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  state.scale = Math.max(0.25, Math.min(3.5,
    Math.min((state.viewWidth - padding * 2) / width, (state.viewHeight - padding * 2) / height)));
  state.offsetX = padding - bounds.minX * state.scale;
  state.offsetY = state.viewHeight - padding - bounds.maxY * state.scale;
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
  const nameInput = document.getElementById("editNameInput");
  const layerInput = document.getElementById("editLayerInput");
  const updateButton = document.getElementById("updateFeatureBtn");
  const stateLabel = document.getElementById("editorState");
  const typeChip = document.getElementById("editorType");
  const meta = document.getElementById("editorMeta");
  const feature = selected.length === 1 ? selected[0] : null;

  editor.classList.toggle("is-empty", !feature);
  nameInput.disabled = !feature;
  layerInput.disabled = !feature;
  updateButton.disabled = !feature;

  if (!feature) {
    stateLabel.textContent = selected.length > 1 ? "多选状态" : "未选择";
    typeChip.textContent = "—";
    meta.textContent = selected.length > 1
      ? "已选择多个要素；请点选表格中的一行编辑单个要素。"
      : "点选一行要素开始编辑。";
    nameInput.value = "";
    layerInput.value = "兴趣点";
    return;
  }

  stateLabel.textContent = "单要素编辑";
  typeChip.textContent = feature.geometry.type;
  nameInput.value = feature.properties.name || "";
  layerInput.value = feature.properties.layer || "自定义";
  meta.textContent = `${feature.id} · ${formatFeatureCoordinates(feature)}`;
}

function formatFeatureCoordinates(feature) {
  const geometry = feature.geometry;
  if (geometry.type === "Point") {
    return `${geometry.coordinates[0].toFixed(1)}, ${geometry.coordinates[1].toFixed(1)}`;
  }
  const ring = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates;
  return `${ring.length} 个节点`;
}

function renderAttributes() {
  const selected = selectedFeatures();
  const summary = document.getElementById("selectionSummary");
  const body = document.getElementById("attributeBody");
  const names = selected.slice(0, 2).map((feature) => feature.properties.name || "未命名");
  const suffix = selected.length > 2 ? " 等" : "";
  summary.textContent = selected.length
    ? `已选择 ${selected.length} 个要素：${names.join("、")}${suffix}`
    : "暂无选择";
  body.innerHTML = "";

  document.getElementById("deleteSelectionBtn").disabled = !selected.length;
  updateStats();
  renderEditor(selected);

  for (const feature of selected) {
    const row = document.createElement("tr");
    row.dataset.id = feature.id;
    row.tabIndex = 0;
    row.classList.toggle("active", selected.length === 1);
    row.title = "点击编辑这个要素";
    const cells = [
      feature.id,
      feature.properties.name || "",
      feature.properties.layer || "",
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
  setNotice(hints[mode]);
  syncDraftControls();
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

async function deleteFeature(feature) {
  await api(`/api/features/${encodeURIComponent(feature.id)}`, { method: "DELETE" });
  state.data.features = state.data.features.filter((item) => item.id !== feature.id);
  state.selectedIds.delete(feature.id);
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
  state.scale = Math.max(0.25, Math.min(3.5, state.scale * factor));
  const afterScreen = worldToScreen(before);
  state.offsetX += screenX - afterScreen.x;
  state.offsetY -= screenY - afterScreen.y;
  draw();
}

canvas.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

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

canvas.addEventListener("mouseup", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

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
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.draft.length) {
    clearDraft();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && state.draft.length) {
    event.preventDefault();
    document.getElementById("undoDraftBtn").click();
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
document.getElementById("zoomInBtn").addEventListener("click", () => zoomAt(state.viewWidth / 2, state.viewHeight / 2, 1.2));
document.getElementById("zoomOutBtn").addEventListener("click", () => zoomAt(state.viewWidth / 2, state.viewHeight / 2, 0.82));
document.getElementById("fitBtn").addEventListener("click", fitView);
document.getElementById("fileInput").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) importDataset(file);
  event.target.value = "";
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
  const name = document.getElementById("editNameInput").value.trim();
  const layer = document.getElementById("editLayerInput").value;
  if (!name) {
    setNotice("名称不能为空。 ");
    return;
  }

  const updated = {
    ...feature,
    properties: { ...feature.properties, name, layer },
  };
  try {
    await updateFeature(updated);
    setNotice(`已更新“${name}”的属性。 `);
  } catch (error) {
    setNotice(`属性更新失败：${error.message}`);
  }
});

document.getElementById("deleteSelectionBtn").addEventListener("click", async () => {
  const selected = selectedFeatures();
  if (!selected.length) return;
  const button = document.getElementById("deleteSelectionBtn");
  button.disabled = true;
  try {
    for (const feature of selected) await deleteFeature(feature);
    state.dirty = false;
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
  state.visibleLayers = new Set(state.data.features.map((feature) => feature.properties.layer || "未命名"));
  state.selectedIds.clear();
  state.draft = [];
  state.draftHover = null;
  state.dirty = false;
  renderLayers();
  renderAttributes();
  syncDraftControls();
  fitView();
  setNotice("数据已重置为示例内容。 ");
  draw();
});

window.addEventListener("resize", resizeCanvas);

Promise.all([loadDatasets(), loadData(), loadStatus()]).then(() => {
  resizeCanvas();
  fitView();
}).catch((error) => {
  document.getElementById("backendStatus").textContent = `连接失败：${error.message}`;
  document.getElementById("statusDot").className = "status-dot error";
  setNotice("无法连接后端，请确认 server.py 已启动。 ");
});
