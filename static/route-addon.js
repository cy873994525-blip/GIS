/* Standalone routing UI for the existing Canvas GIS workspace.
 * Does not edit the app's feature data, dataset list, tools or spatial module.
 * Requires static/app.js to have loaded first (classic scripts, not type=module).
 */
(function () {
  'use strict';
  const toolbar = document.querySelector('.toolbar');
  const stage = document.querySelector('.map-stage');
  if (!toolbar || !stage || typeof draw !== 'function' || typeof setMode !== 'function') {
    console.error('最短路径组件无法初始化：请先加载 /static/app.js');
    return;
  }

  const route = {
    active: false, geojson: null, info: null, points: [], solution: null,
    hover: null, busy: false, previousBaseMapEnabled: null, openToken: 0,
  };

  const group = document.createElement('div');
  group.className = 'tool-group';
  const toolbarLabel = document.createElement('span');
  toolbarLabel.className = 'toolbar-label';
  toolbarLabel.textContent = '分析';
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.id = 'routeAddonButton';
  launcher.className = 'tool route-addon-btn';
  launcher.textContent = '↗ 最短路径';
  launcher.setAttribute('aria-controls', 'routeAddonPanel');
  launcher.setAttribute('aria-expanded', 'false');
  group.append(toolbarLabel, launcher);
  const viewTools = toolbar.querySelector('.view-tools');
  if (viewTools) toolbar.insertBefore(group, viewTools);
  else toolbar.appendChild(group);

  const panel = document.createElement('div');
  panel.id = 'routeAddonPanel';
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', '最短路径分析');
  panel.innerHTML = `
    <div class="route-addon-head"><h3>最短路径分析 <small>Dijkstra</small></h3>
      <button id="routeAddonClose" class="route-addon-close" type="button" title="关闭">×</button></div>
    <p class="route-addon-help">在灰色道路上依次点击<strong>起点</strong>和<strong>终点</strong>，再点击求解。滚轮可以缩放地图。</p>
    <div class="route-addon-place"><i class="route-addon-dot"></i><span>起点</span><strong id="routeAddonStart">等待选点</strong></div>
    <div class="route-addon-place"><i class="route-addon-dot end"></i><span>终点</span><strong id="routeAddonEnd">等待选点</strong></div>
    <div class="route-addon-actions"><button id="routeAddonSolve" class="route-addon-solve" disabled type="button">求解最短路径</button>
      <button id="routeAddonClear" type="button">重选</button></div>
    <div id="routeAddonResult" class="route-addon-result" role="status" aria-live="polite">尚未加载路网。</div>
    <div class="route-addon-data"><div id="routeAddonSource">正在准备离线路网…</div>
      <label for="routeAddonInput">↑ 导入路网</label><input id="routeAddonInput" type="file" accept=".geojson,.json" hidden>
      <button id="routeAddonDataset" type="button">用当前数据集作为路网</button>
      <button id="routeAddonDemo" type="button">示范选点</button>
      <button id="routeAddonReset" type="button">恢复样例</button>
      <p>道路数据：<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>。仅按道路长度计算，不考虑单行道、交通管制和实时路况。</p>
    </div>`;
  stage.appendChild(panel);

  const byId = (id) => document.getElementById(id);
  function setStatus(message, isError) {
    const output = byId('routeAddonResult');
    output.textContent = message;
    output.classList.toggle('error', !!isError);
  }
  function updateFields() {
    const fmt = (p) => p ? `${p[0].toFixed(5)}, ${p[1].toFixed(5)}` : '等待选点';
    byId('routeAddonStart').textContent = fmt(route.points[0]);
    byId('routeAddonEnd').textContent = fmt(route.points[1]);
    byId('routeAddonSolve').disabled = route.points.length !== 2 || route.busy;
    byId('routeAddonDemo').disabled = !route.info || !route.info.demo;
  }
  function parts(feature) {
    if (!feature || !feature.geometry) return [];
    const geom = feature.geometry;
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    return [];
  }
  function allBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const feature of route.geojson.features) {
      for (const line of parts(feature)) {
        for (const p of line) {
          minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
          maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
        }
      }
    }
    return { minX, minY, maxX, maxY };
  }

  function nearestOnRoad(x, y) {
    let winner = null;
    let least = 16 * 16;
    for (const feature of route.geojson.features) {
      for (const line of parts(feature)) {
        for (let i = 1; i < line.length; ++i) {
          const a = worldToScreen(line[i - 1]);
          const b = worldToScreen(line[i]);
          const dx = b.x - a.x, dy = b.y - a.y;
          const denominator = dx * dx + dy * dy;
          const t = denominator ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / denominator)) : 0;
          const px = a.x + t * dx, py = a.y + t * dy;
          const dist2 = (px - x) ** 2 + (py - y) ** 2;
          if (dist2 < least) {
            least = dist2;
            winner = { point: [
              line[i - 1][0] + t * (line[i][0] - line[i - 1][0]),
              line[i - 1][1] + t * (line[i][1] - line[i - 1][1]),
            ], pixel: { x: px, y: py } };
          }
        }
      }
    }
    return winner;
  }

  function drawMarker(point, color, label) {
    const p = worldToScreen(point);
    ctx.save();
    ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 11px sans-serif'; ctx.fillStyle = '#fff';
    ctx.fillText(label, p.x, p.y);
    ctx.restore();
  }
  function drawRoads() {
    if (!route.geojson) return;
    ctx.save();
    ctx.lineJoin = 'round';ctx.lineCap = 'round';
    for (const style of [{ width: 7.3, color: '#ffffff' }, { width: 3.5, color: '#759298' }]) {
      ctx.lineWidth = style.width;ctx.strokeStyle = style.color;
      for (const feature of route.geojson.features) {
        for (const line of parts(feature)) {
          if (line.length > 1) { drawPath(line, false); ctx.stroke(); }
        }
      }
    }
    ctx.restore();
    const coordinates = route.solution && route.solution.route && route.solution.route.geometry.coordinates;
    if (coordinates && coordinates.length > 1) {
      ctx.save();ctx.lineCap = 'round';ctx.lineJoin = 'round';
      drawPath(coordinates, false);ctx.strokeStyle = '#fff';ctx.lineWidth = 12;ctx.stroke();
      drawPath(coordinates, false);ctx.strokeStyle = '#eb6548';ctx.lineWidth = 6.5;ctx.stroke();
      ctx.restore();
    }
    if (route.hover && route.points.length < 2) {
      const p = route.hover.pixel;
      ctx.save();ctx.beginPath();ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(26,145,130,.3)';ctx.fill();ctx.restore();
    }
    route.points.forEach((point, index) => drawMarker(point, index ? '#e4674a' : '#178879', index ? '终' : '起'));
  }

  // The two wrappers are inert while this add-on is closed: original GIS rendering remains unchanged.
  const oldDraw = draw;
  draw = function () {
    if (!route.active) return oldDraw.apply(this, arguments);
    renderBasemapTiles();
    ctx.clearRect(0, 0, state.viewWidth, state.viewHeight);
    drawRoads();
  };
  const oldGetBounds = getDataBounds;
  getDataBounds = function () {
    return route.active && route.geojson ? allBounds() : oldGetBounds.apply(this, arguments);
  };
  const oldSetMode = setMode;
  setMode = function (mode) {
    if (route.active && mode !== 'route') closeRoute(false);
    return oldSetMode.apply(this, arguments);
  };

  function clearRoute(showHint) {
    route.points = [];
    route.solution = null;
    route.hover = null;
    updateFields();
    if (showHint) setStatus('请在灰色路线上选择起点和终点。');
    draw();
  }
  function pick(x, y) {
    if (route.busy) return;
    const snapped = nearestOnRoad(x, y);
    if (!snapped) { setStatus('请点击灰色道路附近（建议先放大）。', true); return; }
    if (route.points.length >= 2) clearRoute(false);
    route.points.push(snapped.point);
    route.solution = null;
    route.hover = null;
    updateFields();
    setStatus(route.points.length === 1 ? '起点设置成功，请点击终点。' : '起终点已选好，点击「求解最短路径」。');
    draw();
  }
  async function solve() {
    if (route.points.length !== 2 || route.busy) return;
    route.busy = true; updateFields();
    setStatus('正在按照道路长度计算最短路径…');
    try {
      const answer = await api('/api/routing/solve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: route.points[0], end: route.points[1] }),
      });
      if (!route.active) return;
      route.solution = answer;
      route.points = [answer.start, answer.end];
      const length = answer.distance_m >= 1000
        ? `${(answer.distance_m / 1000).toFixed(2)} km` : `${answer.distance_m.toFixed(1)} m`;
      setStatus(`✓ 已找到最短路径：${length}。橙红色线是路网最短路径。`);
    } catch (error) {
      if (!route.active) return;
      route.solution = null;
      setStatus(`求解失败：${error.message}`, true);
    } finally {
      route.busy = false;updateFields();draw();
    }
  }
  async function loadRoads(datasetId) {
    const url = datasetId
      ? '/api/routing/network?dataset_id=' + encodeURIComponent(datasetId)
      : '/api/routing/network';
    const payload = await api(url);
    if (!payload.geojson || !payload.geojson.features || !payload.info) throw new Error('后端路网响应缺少 GeoJSON 数据');
    route.geojson = payload.geojson;
    route.info = payload.info;
    const source = payload.info.from_dataset
      ? `数据集“${payload.info.name}”` : (payload.info.demo ? '内置离线样例' : '自定义路网');
    byId('routeAddonSource').textContent = `${source} · ${payload.info.ways} 条道路 · ${payload.info.nodes} 个节点`;
    updateFields();
  }
  async function loadRoadsFromActiveDataset() {
    const datasets = await api('/api/datasets');
    const active = (datasets.datasets || []).find((item) => item.active) || (datasets.datasets || [])[0];
    if (!active) throw new Error('没有可用的数据集');
    setStatus(`正在用数据集“${active.name}”重建路网…`);
    await loadRoads(active.id);
    setStatus(`✓ 已从数据集“${active.name}”加载路网。`);
  }
  async function openRoute() {
    if (route.active) {closeRoute(true);return;}
    const openToken = ++route.openToken;
    panel.hidden = false;launcher.classList.add('active');launcher.setAttribute('aria-expanded', 'true');
    if (!route.geojson) {
      setStatus('正在读取离线路网数据…');
      try {await loadRoads();}
      catch (error) {
        setStatus(`路网加载失败：${error.message}。请先在浏览器打开 /api/routing/network 检查后端。`, true);
        return;
      }
    }
    if (openToken !== route.openToken || panel.hidden) return;
    // Respect the existing confirmation dialog if a user is in the middle of drawing.
    oldSetMode('pan');
    if (state.mode !== 'pan') {setStatus('请先完成当前编辑或取消绘制，再打开最短路径。', true); return;}
    route.previousBaseMapEnabled = state.baseMapEnabled;
    state.baseMapEnabled = false;
    state.geographic = true;
    route.active = true;
    state.mode = 'route';
    canvas.classList.remove('mode-pan','mode-select','mode-box','mode-point','mode-line','mode-polygon','mode-edit');
    canvas.classList.add('mode-route');
    document.querySelectorAll('.tool[data-mode]').forEach((button) => button.classList.remove('active'));
    byId('baseMapBtn').disabled = true;
    byId('baseMapBtn').textContent = '路网离线展示';
    byId('mapBadgeText').textContent = 'OSM 离线路网 · 最短路径';
    byId('mapAttribution').hidden = true;
    clearRoute(false);
    fitView();
    setStatus('请在灰色道路上点击选择起点、终点，或者点击「示范选点」。');
  }
  function closeRoute(changeToPan) {
    route.openToken++;
    panel.hidden = true;launcher.classList.remove('active');launcher.setAttribute('aria-expanded', 'false');
    if (!route.active) return;
    route.active = false;
    route.hover = null;
    if (route.previousBaseMapEnabled !== null) state.baseMapEnabled = route.previousBaseMapEnabled;
    route.previousBaseMapEnabled = null;
    if (changeToPan) oldSetMode('pan');
    syncMapMode();
    fitView();
  }

  launcher.addEventListener('click', openRoute);
  byId('routeAddonClose').addEventListener('click', () => closeRoute(true));
  byId('routeAddonClear').addEventListener('click', () => clearRoute(true));
  byId('routeAddonSolve').addEventListener('click', solve);
  canvas.addEventListener('click', (event) => {
    if (!route.active) return;
    const box = canvas.getBoundingClientRect();
    pick(event.clientX - box.left, event.clientY - box.top);
  });
  canvas.addEventListener('mousemove', (event) => {
    if (!route.active || route.points.length >= 2) return;
    const box = canvas.getBoundingClientRect();
    const hover = nearestOnRoad(event.clientX - box.left, event.clientY - box.top);
    if (!!route.hover !== !!hover || (hover && (!route.hover || Math.abs(hover.pixel.x - route.hover.pixel.x) > 2 || Math.abs(hover.pixel.y - route.hover.pixel.y) > 2))) {
      route.hover = hover;draw();
    }
  });
  byId('routeAddonDemo').addEventListener('click', () => {
    if (!route.active || !route.info || !route.info.demo) return;
    route.points = [[126.9843635, 37.5318988], [126.9800453, 37.5261904]];
    route.solution = null;
    updateFields();setStatus('示范起终点已选好，点击「求解最短路径」。');draw();
  });
  byId('routeAddonDataset').addEventListener('click', async () => {
    try {
      route.geojson = null;route.info = null;
      await loadRoadsFromActiveDataset();clearRoute(true);
      if (route.active) fitView();
    } catch (error) {setStatus(`从数据集加载路网失败：${error.message}`, true);}
  });
  byId('routeAddonInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 9 * 1024 * 1024) throw new Error('演示版导入上限 9 MB');
      const payload = JSON.parse(await file.text());
      await api('/api/routing/network', {
        method: 'POST',headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
      });
      route.geojson = null;route.info = null;
      await loadRoads();clearRoute(true);
      if (route.active) fitView();
      setStatus(`路网导入成功：${file.name}。请重新选点。`);
    } catch (error) {setStatus(`导入失败：${error.message}`, true);}
    finally {event.target.value = '';}
  });
  byId('routeAddonReset').addEventListener('click', async () => {
    try {
      await api('/api/routing/network', {method: 'DELETE'});
      route.geojson = null;route.info = null;
      await loadRoads();clearRoute(true);
      if (route.active) fitView();
      setStatus('已恢复内置首尔路网示例。');
    } catch (error) {setStatus(`恢复失败：${error.message}`, true);}
  });
  window.routeAddon = {open: openRoute, close: () => closeRoute(true),
                       get active() {return route.active;},
                       get points() {return route.points.slice();},
                       get solution() {return route.solution;}};
})();
