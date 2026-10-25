/* Standalone routing and obstacle UI for the existing Canvas GIS workspace.
 * Analysis geometry stays separate from editable GIS feature data.
 * Requires static/app.js to have loaded first (classic scripts).
 */
(function () {
  'use strict';
  const toolbar = document.querySelector('.toolbar');
  const stage = document.querySelector('.map-stage');
  if (!toolbar || !stage || typeof draw !== 'function' || typeof setMode !== 'function') {
    console.error('最短路径组件无法初始化：请先加载 /static/app.js');
    return;
  }

  const MAX_OBSTACLES = 20;
  const MAX_OBSTACLE_VERTICES = 500;
  const route = {
    active: false, geojson: null, info: null, points: [], solution: null,
    hover: null, busy: false, loading: false, previousBaseMapEnabled: null,
    openToken: 0, networkToken: 0, solveToken: 0, solveController: null,
    obstacles: [], drawingObstacle: false, draft: [], draftHover: null,
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
      <button id="routeAddonClose" class="route-addon-close" type="button" title="关闭" aria-label="关闭最短路径分析">×</button></div>
    <p class="route-addon-help">在灰色道路上依次点击<strong>起点</strong>和<strong>终点</strong>，再点击求解。添加障碍面后会自动重新计算，滚轮可以缩放地图。</p>
    <div class="route-addon-place"><i class="route-addon-dot"></i><span>起点</span><strong id="routeAddonStart">等待选点</strong></div>
    <div class="route-addon-place"><i class="route-addon-dot end"></i><span>终点</span><strong id="routeAddonEnd">等待选点</strong></div>
    <div class="route-addon-actions"><button id="routeAddonSolve" class="route-addon-solve" disabled type="button">求解最短路径</button>
      <button id="routeAddonClear" type="button">重选</button></div>
    <div class="route-addon-obstacles">
      <div class="route-addon-obstacle-head"><strong>障碍面</strong><span id="routeAddonObstacleCount">已添加 0 个</span></div>
      <button id="routeAddonObstacleAdd" class="route-addon-obstacle-add" type="button">＋ 添加障碍面</button>
      <div id="routeAddonObstacleDrawing" hidden>
        <p id="routeAddonObstacleHint">在地图上依次点击至少 3 个顶点，完成后自动绕行。</p>
        <div class="route-addon-obstacle-controls">
          <button id="routeAddonObstacleFinish" type="button" disabled>完成障碍面</button>
          <button id="routeAddonObstacleUndo" type="button" disabled>撤销节点</button>
          <button id="routeAddonObstacleCancel" type="button">取消绘制</button>
        </div>
      </div>
      <div class="route-addon-obstacle-controls">
        <button id="routeAddonObstacleRemove" type="button" disabled>移除上一个</button>
        <button id="routeAddonObstacleClear" type="button" disabled>清空障碍</button>
      </div>
      <p class="route-addon-obstacle-note">红色半透明区域及边界禁止通行。障碍保留在本次页面中，切换路网会清空。</p>
    </div>
    <div id="routeAddonResult" class="route-addon-result" role="status" aria-live="polite">尚未加载路网。</div>
    <div class="route-addon-data"><div id="routeAddonSource">正在准备离线路网…</div>
      <label id="routeAddonInputLabel" for="routeAddonInput">↑ 导入路网</label><input id="routeAddonInput" type="file" accept=".geojson,.json" hidden>
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
    const unavailable = !route.active || route.loading || !route.geojson;
    byId('routeAddonStart').textContent = fmt(route.points[0]);
    byId('routeAddonEnd').textContent = fmt(route.points[1]);
    byId('routeAddonSolve').disabled = unavailable || route.points.length !== 2 || route.busy || route.drawingObstacle;
    byId('routeAddonSolve').textContent = route.busy ? '正在计算…' : '求解最短路径';
    byId('routeAddonClear').disabled = unavailable;
    byId('routeAddonDemo').disabled = unavailable || !route.info || !route.info.demo || route.drawingObstacle;
    byId('routeAddonObstacleAdd').disabled = unavailable || route.drawingObstacle || route.obstacles.length >= MAX_OBSTACLES;
    byId('routeAddonObstacleAdd').setAttribute('aria-pressed', String(route.drawingObstacle));
    byId('routeAddonObstacleCount').textContent = `已添加 ${route.obstacles.length} 个`;
    byId('routeAddonObstacleDrawing').hidden = !route.drawingObstacle;
    byId('routeAddonObstacleFinish').disabled = unavailable || route.draft.length < 3;
    byId('routeAddonObstacleUndo').disabled = unavailable || !route.draft.length;
    byId('routeAddonObstacleRemove').disabled = unavailable || route.drawingObstacle || !route.obstacles.length;
    byId('routeAddonObstacleClear').disabled = unavailable || route.drawingObstacle || !route.obstacles.length;
    byId('routeAddonObstacleHint').textContent = `已放置 ${route.draft.length} 个顶点。至少 3 个顶点后点击「完成障碍面」，也可双击或按 Enter 完成，Esc 取消。`;
    for (const id of ['routeAddonDataset', 'routeAddonReset', 'routeAddonInput']) {
      byId(id).disabled = !route.active || route.loading;
    }
    byId('routeAddonInputLabel').classList.toggle('disabled', !route.active || route.loading);
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
    if (!route.geojson) return null;
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
            winner = { point: [line[i - 1][0] + t * (line[i][0] - line[i - 1][0]),
              line[i - 1][1] + t * (line[i][1] - line[i - 1][1])], pixel: { x: px, y: py } };
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
  function drawObstacles() {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.strokeStyle = '#c64c43'; ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(211, 76, 67, .22)';
    for (const obstacle of route.obstacles) {
      drawPath(obstacle.coordinates[0], true); ctx.fill(); ctx.stroke();
    }
    if (route.drawingObstacle && route.draft.length) {
      const preview = route.draftHover ? route.draft.concat([route.draftHover]) : route.draft;
      ctx.setLineDash([6, 4]);
      drawPath(preview, preview.length >= 3);
      if (preview.length >= 3) ctx.fill();
      ctx.stroke(); ctx.setLineDash([]);
      for (let i = 0; i < route.draft.length; i++) {
        const p = worldToScreen(route.draft[i]);
        ctx.beginPath(); ctx.arc(p.x, p.y, i ? 3.5 : 5, 0, Math.PI * 2);
        ctx.fillStyle = i ? '#c64c43' : '#fff'; ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }
  function drawRoads() {
    if (!route.geojson) return;
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const style of [{ width: 7.3, color: '#fff' }, { width: 3.5, color: '#759298' }]) {
      ctx.lineWidth = style.width; ctx.strokeStyle = style.color;
      for (const feature of route.geojson.features) {
        for (const line of parts(feature)) {
          if (line.length > 1) { drawPath(line, false); ctx.stroke(); }
        }
      }
    }
    ctx.restore();
    const coordinates = route.solution && route.solution.route && route.solution.route.geometry.coordinates;
    if (coordinates && coordinates.length > 1) {
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      drawPath(coordinates, false); ctx.strokeStyle = '#fff'; ctx.lineWidth = 12; ctx.stroke();
      drawPath(coordinates, false); ctx.strokeStyle = '#eb6548'; ctx.lineWidth = 6.5; ctx.stroke();
      ctx.restore();
    }
    drawObstacles();
    if (route.hover && route.points.length < 2 && !route.drawingObstacle) {
      const p = route.hover.pixel;
      ctx.save(); ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(26,145,130,.3)'; ctx.fill(); ctx.restore();
    }
    route.points.forEach((point, index) => drawMarker(point, index ? '#e4674a' : '#178879', index ? '终' : '起'));
  }

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

  function cancelSolve(clearSolution = true) {
    route.solveToken++;
    if (route.solveController) route.solveController.abort();
    route.solveController = null;
    route.busy = false;
    if (clearSolution) route.solution = null;
  }
  function clearDraft() {
    route.drawingObstacle = false;
    route.draft = [];
    route.draftHover = null;
    route.hover = null;
  }
  function clearRoute(showHint, clearObstacles = false) {
    cancelSolve();
    clearDraft();
    route.points = [];
    if (clearObstacles) route.obstacles = [];
    updateFields();
    if (showHint) setStatus('请在灰色路线上选择起点和终点。已添加的障碍面会参与下次求解。');
    draw();
  }
  function pick(x, y) {
    const snapped = nearestOnRoad(x, y);
    if (!snapped) { setStatus('请点击灰色道路附近（建议先放大）。', true); return; }
    if (route.points.length >= 2) clearRoute(false);
    cancelSolve();
    route.points.push(snapped.point);
    route.hover = null;
    updateFields();
    setStatus(route.points.length === 1 ? '起点设置成功，请点击终点。' : '起终点已选好，点击「求解最短路径」。');
    draw();
  }
  async function solve(automatic = false) {
    if (!route.active || route.loading || route.drawingObstacle || route.points.length !== 2) return;
    cancelSolve();
    const token = route.solveToken;
    const controller = new AbortController();
    route.solveController = controller;
    route.busy = true; updateFields(); draw();
    setStatus(automatic ? '障碍面已更新，正在重新计算可通行的最短路径…' : '正在按照道路长度和障碍面计算最短路径…');
    const datasetId = route.info && route.info.dataset_id;
    const url = '/api/routing/solve' + (datasetId ? '?dataset_id=' + encodeURIComponent(datasetId) : '');
    try {
      const answer = await api(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ start: route.points[0], end: route.points[1], obstacles: route.obstacles }),
      });
      if (!route.active || token !== route.solveToken) return;
      route.solution = answer;
      route.points = [answer.start, answer.end];
      const length = answer.distance_m >= 1000
        ? `${(answer.distance_m / 1000).toFixed(2)} km` : `${answer.distance_m.toFixed(1)} m`;
      const detail = route.obstacles.length
        ? `已避开 ${answer.obstacle_count} 个障碍面，阻断 ${answer.blocked_edges} 条道路分段。` : '';
      setStatus(`✓ 已找到最短路径：${length}。${detail}橙红色线是当前最短路径。`);
    } catch (error) {
      if (!route.active || token !== route.solveToken || error.name === 'AbortError') return;
      route.solution = null;
      setStatus(`求解失败：${error.message}`, true);
    } finally {
      if (token === route.solveToken) {
        route.busy = false; route.solveController = null; updateFields(); draw();
      }
    }
  }
  function obstacleChanged(message) {
    cancelSolve(); updateFields(); draw();
    if (route.points.length === 2) solve(true);
    else setStatus(`${message}请在道路上选择起点和终点后求解。`);
  }
  function beginObstacle() {
    if (!route.active || route.loading || !route.geojson || route.drawingObstacle) return;
    if (route.obstacles.length >= MAX_OBSTACLES) {
      setStatus(`最多添加 ${MAX_OBSTACLES} 个障碍面，请先移除已有障碍。`, true); return;
    }
    cancelSolve(false);
    route.drawingObstacle = true; route.draft = []; route.draftHover = null; route.hover = null;
    updateFields(); draw();
    setStatus('正在绘制障碍面：请在地图上依次点击至少 3 个顶点，再点击「完成障碍面」。');
  }
  function validObstacle(points) {
    if (points.length < 3) throw new Error('障碍面至少需要 3 个不同的顶点。');
    if (points.some(p => !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85)) {
      throw new Error('请在有效的 WGS84 经纬度范围内绘制障碍面。');
    }
    // Translate to local metres to avoid cancellation for small polygons at large longitudes.
    const origin = points[0], sx = 111195 * Math.cos(origin[1] * Math.PI / 180);
    const local = points.map(p => [(p[0] - origin[0]) * sx, (p[1] - origin[1]) * 111195]);
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const onSegment = (p, a, b) => Math.abs(cross(a, b, p)) < 1e-8 &&
      p[0] >= Math.min(a[0], b[0]) - 1e-7 && p[0] <= Math.max(a[0], b[0]) + 1e-7 &&
      p[1] >= Math.min(a[1], b[1]) - 1e-7 && p[1] <= Math.max(a[1], b[1]) + 1e-7;
    const intersects = (a, b, c, d) => {
      const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
      return ((abC > 0 && abD < 0 || abC < 0 && abD > 0) &&
        (cdA > 0 && cdB < 0 || cdA < 0 && cdB > 0)) ||
        onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
    };
    const n = local.length;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = local[i], b = local[(i + 1) % n], c = local[(i + 2) % n];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < .001) throw new Error('障碍面存在重复顶点，请撤销重复节点。');
      if (Math.abs(cross(a, b, c)) < 1e-8 &&
          (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0) {
        throw new Error('障碍面的边不能折返重叠，请撤销节点后重新绘制。');
      }
      area += a[0] * b[1] - b[0] * a[1];
      for (let j = i + 1; j < n; j++) {
        if (j === i + 1 || i === 0 && j === n - 1) continue;
        if (intersects(a, b, local[j], local[(j + 1) % n])) {
          throw new Error('障碍面的边不能相交或重叠，请撤销节点后重新绘制。');
        }
      }
    }
    if (Math.abs(area) < .02) throw new Error('障碍面面积过小，或顶点在同一直线上，请重新绘制。');
  }
  function finishObstacle() {
    if (!route.active || !route.drawingObstacle) return;
    try {
      validObstacle(route.draft);
      const ring = route.draft.map(p => p.slice());
      ring.push(ring[0].slice());
      const total = route.obstacles.reduce((count, obstacle) => count + obstacle.coordinates[0].length, ring.length);
      if (total > MAX_OBSTACLE_VERTICES) throw new Error(`所有障碍面的顶点总数（含闭合点）不能超过 ${MAX_OBSTACLE_VERTICES} 个，请减少节点。`);
      route.obstacles.push({ type: 'Polygon', coordinates: [ring] });
      clearDraft(); obstacleChanged('障碍面已添加。');
    } catch (error) { setStatus(error.message, true); }
  }
  function cancelObstacle() {
    if (!route.drawingObstacle) return;
    clearDraft(); updateFields(); draw();
    if (route.points.length === 2 && !route.solution) solve();
    else setStatus('已取消本次障碍面绘制。');
  }
  function undoObstacleVertex() {
    route.draft.pop(); route.draftHover = null; updateFields(); draw();
    setStatus(`已撤销一个节点，还剩 ${route.draft.length} 个顶点。`);
  }
  function placeObstacleVertex(x, y) {
    const last = route.draft[route.draft.length - 1];
    if (last) {
      const p = worldToScreen(last);
      if (Math.hypot(p.x - x, p.y - y) < 3) return;
    }
    if (route.draft.length >= 3) {
      const first = worldToScreen(route.draft[0]);
      if (Math.hypot(first.x - x, first.y - y) <= 9) { finishObstacle(); return; }
    }
    const existing = route.obstacles.reduce((count, obstacle) => count + obstacle.coordinates[0].length, 0);
    if (existing + route.draft.length + 2 > MAX_OBSTACLE_VERTICES) {
      setStatus(`障碍面顶点总数上限为 ${MAX_OBSTACLE_VERTICES} 个，请完成当前障碍面或撤销节点。`, true); return;
    }
    route.draft.push(screenToWorld(x, y)); route.draftHover = null; updateFields(); draw();
  }

  async function loadRoads(datasetId, token) {
    const url = datasetId ? '/api/routing/network?dataset_id=' + encodeURIComponent(datasetId) : '/api/routing/network';
    const payload = await api(url);
    if (token !== route.networkToken) return false;
    if (!payload.geojson || !payload.geojson.features || !payload.info) throw new Error('后端路网响应缺少 GeoJSON 数据');
    route.geojson = payload.geojson; route.info = payload.info;
    const source = payload.info.from_dataset ? `数据集“${payload.info.name}”` : (payload.info.demo ? '内置离线样例' : '自定义路网');
    byId('routeAddonSource').textContent = `${source} · ${payload.info.ways} 条道路 · ${payload.info.nodes} 个节点`;
    return true;
  }
  async function changeNetwork(load, success) {
    if (!route.active || route.loading) return;
    const token = ++route.networkToken;
    route.loading = true;
    clearRoute(false, true); route.geojson = null; route.info = null; updateFields(); draw();
    setStatus('正在切换路网，已清空起终点和障碍面…');
    try {
      if (!await load(token) || token !== route.networkToken || !route.active) return;
      fitView(); setStatus(success);
    } catch (error) {
      if (token === route.networkToken && route.active) setStatus(`路网加载失败：${error.message}`, true);
    } finally {
      if (token === route.networkToken) { route.loading = false; updateFields(); draw(); }
    }
  }
  async function openRoute() {
    if (route.active || !panel.hidden) { closeRoute(true); return; }
    const openToken = ++route.openToken;
    panel.hidden = false; launcher.classList.add('active'); launcher.setAttribute('aria-expanded', 'true');
    if (!route.geojson) {
      const token = ++route.networkToken;
      route.loading = true; updateFields(); setStatus('正在读取离线路网数据…');
      try { if (!await loadRoads(null, token)) return; }
      catch (error) {
        if (openToken === route.openToken) setStatus(`路网加载失败：${error.message}。请确认后端服务已启动。`, true);
        return;
      } finally {
        if (token === route.networkToken) { route.loading = false; updateFields(); }
      }
    }
    if (openToken !== route.openToken || panel.hidden) return;
    oldSetMode('pan');
    if (state.mode !== 'pan') { setStatus('请先完成当前编辑或取消绘制，再打开最短路径。', true); return; }
    route.previousBaseMapEnabled = state.baseMapEnabled;
    state.baseMapEnabled = false; state.geographic = true; route.active = true; state.mode = 'route';
    canvas.classList.remove('mode-pan', 'mode-select', 'mode-box', 'mode-point', 'mode-line', 'mode-polygon', 'mode-edit');
    canvas.classList.add('mode-route');
    document.querySelectorAll('.tool[data-mode]').forEach((button) => button.classList.remove('active'));
    byId('baseMapBtn').disabled = true; byId('baseMapBtn').textContent = '路网离线展示';
    byId('mapBadgeText').textContent = 'OSM 离线路网 · 最短路径'; byId('mapAttribution').hidden = true;
    clearRoute(false); fitView();
    setStatus('请在灰色道路上点击选择起点、终点，或者点击「示范选点」。也可以先添加障碍面。');
  }
  function closeRoute(changeToPan) {
    route.openToken++; route.networkToken++; route.loading = false;
    cancelSolve(); clearDraft();
    panel.hidden = true; launcher.classList.remove('active'); launcher.setAttribute('aria-expanded', 'false');
    if (!route.active) { updateFields(); return; }
    route.active = false; route.hover = null;
    canvas.classList.remove('mode-route');
    if (route.previousBaseMapEnabled !== null) state.baseMapEnabled = route.previousBaseMapEnabled;
    route.previousBaseMapEnabled = null;
    if (changeToPan) oldSetMode('pan');
    syncMapMode(); fitView(); updateFields();
  }

  launcher.addEventListener('click', openRoute);
  byId('routeAddonClose').addEventListener('click', () => closeRoute(true));
  byId('routeAddonClear').addEventListener('click', () => clearRoute(true));
  byId('routeAddonSolve').addEventListener('click', () => solve());
  byId('routeAddonObstacleAdd').addEventListener('click', beginObstacle);
  byId('routeAddonObstacleFinish').addEventListener('click', finishObstacle);
  byId('routeAddonObstacleUndo').addEventListener('click', undoObstacleVertex);
  byId('routeAddonObstacleCancel').addEventListener('click', cancelObstacle);
  byId('routeAddonObstacleRemove').addEventListener('click', () => {
    if (!route.obstacles.length || route.drawingObstacle) return;
    route.obstacles.pop(); obstacleChanged('已移除上一个障碍面。');
  });
  byId('routeAddonObstacleClear').addEventListener('click', () => {
    route.obstacles = []; obstacleChanged('已清空全部障碍面。');
  });
  canvas.addEventListener('click', (event) => {
    if (!route.active || route.loading || event.detail > 1 || event.button !== 0) return;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    if (route.drawingObstacle) placeObstacleVertex(x, y); else pick(x, y);
  });
  canvas.addEventListener('dblclick', (event) => {
    if (!route.active || !route.drawingObstacle) return;
    event.preventDefault(); finishObstacle();
  });
  canvas.addEventListener('mousemove', (event) => {
    if (!route.active || route.loading) return;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    if (route.drawingObstacle) { route.draftHover = screenToWorld(x, y); draw(); return; }
    if (route.points.length >= 2) return;
    const hover = nearestOnRoad(x, y);
    if (!!route.hover !== !!hover || hover && (!route.hover || Math.abs(hover.pixel.x - route.hover.pixel.x) > 2 || Math.abs(hover.pixel.y - route.hover.pixel.y) > 2)) {
      route.hover = hover; draw();
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (!route.active) return;
    route.draftHover = null; route.hover = null; draw();
  });
  // Capture handled keys before app.js can replay editable GIS history.
  window.addEventListener('keydown', (event) => {
    if (!route.active || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    const key = event.key.toLowerCase();
    const undo = (event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey;
    const history = (event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y');
    if (history || route.drawingObstacle && (key === 'escape' || key === 'enter' && !(event.target instanceof HTMLButtonElement))) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (route.drawingObstacle) {
        if (undo && route.draft.length) undoObstacleVertex();
        else if (key === 'escape') cancelObstacle();
        else if (key === 'enter') finishObstacle();
      }
    }
  }, true);
  byId('routeAddonDemo').addEventListener('click', () => {
    if (!route.active || !route.info || !route.info.demo || route.drawingObstacle) return;
    cancelSolve();
    route.points = [[126.9843635, 37.5318988], [126.9800453, 37.5261904]];
    updateFields(); setStatus('示范起终点已选好，点击「求解最短路径」。'); draw();
  });
  byId('routeAddonDataset').addEventListener('click', () => changeNetwork(async (token) => {
    const datasets = await api('/api/datasets');
    if (token !== route.networkToken) return false;
    const active = (datasets.datasets || []).find(item => item.active) || (datasets.datasets || [])[0];
    if (!active) throw new Error('没有可用的数据集');
    return loadRoads(active.id, token);
  }, '✓ 已从当前数据集加载路网。请重新选点或添加障碍面。'));
  byId('routeAddonInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    await changeNetwork(async (token) => {
      if (file.size > 9 * 1024 * 1024) throw new Error('演示版导入上限 9 MB');
      const payload = JSON.parse(await file.text());
      if (token !== route.networkToken) return false;
      await api('/api/routing/network', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return loadRoads(null, token);
    }, `路网导入成功：${file.name}。请重新选点或添加障碍面。`);
    event.target.value = '';
  });
  byId('routeAddonReset').addEventListener('click', () => changeNetwork(async (token) => {
    await api('/api/routing/network', { method: 'DELETE' });
    return loadRoads(null, token);
  }, '已恢复内置首尔路网示例。请重新选点或添加障碍面。'));
  window.routeAddon = {
    open: openRoute, close: () => closeRoute(true),
    get active() { return route.active; },
    get points() { return route.points.map(p => p.slice()); },
    get solution() { return route.solution; },
    get obstacles() { return JSON.parse(JSON.stringify(route.obstacles)); },
    get drawingObstacle() { return route.drawingObstacle; },
  };
  updateFields();
})();
