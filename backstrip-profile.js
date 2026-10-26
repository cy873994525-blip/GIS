/*
 * 回剥地质剖面可视化。
 *
 * 该模块不依赖 Chart.js，直接使用 Canvas 绘制，因此即使图表 CDN
 * 不可用，地层剖面和动画仍然可以使用。左侧始终保留现今压实剖面，
 * 右侧根据年龄滑块逐层移除年轻地层，并用 originalThickness 重建老
 * 年代的沉积层柱。这样展示的是可解释的教学型回剥过程，而不是把
 * burialHistory.depth 误当作某一时代的古地层厚度。
 */
(function initialiseBackstripProfile(global) {
  "use strict";

  const LITHOLOGY_COLORS = Object.freeze({
    sandstone: "#d79b54",
    shale: "#7f8fa6",
    limestone: "#6fa27d",
    siltstone: "#c7b458",
    coal: "#30343b",
  });
  const LITHOLOGY_LABELS = Object.freeze({
    sandstone: "砂岩",
    shale: "页岩",
    limestone: "灰岩",
    siltstone: "粉砂岩",
    coal: "煤",
  });
  const COLORS = Object.freeze({
    ink: "#263238",
    muted: "#65727f",
    border: "#cad4dd",
    primary: "#176d6a",
    primaryDark: "#0d4d4b",
    water: "#8cc7e7",
    waterDark: "#3579a6",
    inactive: "#dce2e6",
    white: "#ffffff",
  });

  const state = {
    result: null,
    canvasId: "backstripProfileCanvas",
    stageIndex: 0,
    stages: [],
    playing: false,
    frameId: null,
    lastTimestamp: 0,
    resizeObserver: null,
  };

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function rowsFromResult(result) {
    return Array.isArray(result?.formationResults)
      ? result.formationResults.filter((row) => (
        Number.isFinite(Number(row.age))
        && Number.isFinite(Number(row.presentThickness))
        && Number.isFinite(Number(row.originalThickness))
      ))
      : [];
  }

  function buildStages(rows) {
    const ages = [...new Set(rows.map((row) => finite(row.age)))].sort((a, b) => a - b);
    return [{ label: "现在", age: null }, ...ages.map((age) => ({ label: `${age} Ma`, age }))];
  }

  function activeRows(rows, stage) {
    if (!stage || stage.age === null) return rows;
    // formationResults 按新到老排列，年龄越大表示越老。
    return rows.filter((row) => finite(row.age) >= stage.age);
  }

  function currentWaterDepth(rows, stage) {
    const row = stage?.age === null
      ? rows[0]
      : rows.find((item) => finite(item.age) === stage.age);
    return Math.max(0, finite(row?.paleoWaterDepth));
  }

  function currentSeaLevel(rows, stage) {
    const row = stage?.age === null
      ? rows[0]
      : rows.find((item) => finite(item.age) === stage.age);
    return finite(row?.seaLevel);
  }

  function getElements() {
    return {
      section: document.getElementById("backstripProfileSection"),
      canvas: document.getElementById(state.canvasId),
      slider: document.getElementById("backstripProfileSlider"),
      playButton: document.getElementById("backstripProfilePlayBtn"),
      resetButton: document.getElementById("backstripProfileResetBtn"),
      stageLabel: document.getElementById("backstripProfileStageLabel"),
      detail: document.getElementById("backstripProfileDetail"),
    };
  }

  function setPlayLabel() {
    const { playButton } = getElements();
    if (!playButton) return;
    playButton.textContent = state.playing ? "暂停动画" : "播放回剥";
    playButton.classList.toggle("active", state.playing);
    playButton.setAttribute("aria-pressed", state.playing ? "true" : "false");
  }

  function setStageLabel() {
    const { slider, stageLabel, detail } = getElements();
    const stage = state.stages[state.stageIndex] || { label: "现在", age: null };
    if (slider) slider.value = String(state.stageIndex);
    if (stageLabel) stageLabel.textContent = stage.label;
    if (detail) {
      detail.textContent = stage.age === null
        ? "左：现今压实地层　右：现今厚度对应的去压实重建"
        : `左：现今压实地层（灰色表示已回剥的年轻层）　右：${stage.label}保留层的原始厚度重建`;
    }
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function drawText(context, value, x, y, options = {}) {
    context.save();
    context.fillStyle = options.color || COLORS.ink;
    context.font = options.font || "12px Microsoft YaHei, sans-serif";
    context.textAlign = options.align || "left";
    context.textBaseline = options.baseline || "middle";
    context.fillText(value, x, y);
    context.restore();
  }

  function drawDepthAxis(context, x, top, height, maxDepth, side) {
    context.save();
    context.strokeStyle = COLORS.border;
    context.fillStyle = COLORS.muted;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, top);
    context.lineTo(x, top + height);
    context.stroke();
    const tickCount = 4;
    for (let index = 0; index <= tickCount; index += 1) {
      const value = maxDepth * index / tickCount;
      const y = top + height * index / tickCount;
      context.beginPath();
      context.moveTo(x - 4, y);
      context.lineTo(x + 4, y);
      context.stroke();
      drawText(context, `${Math.round(value)} m`, side === "left" ? x - 8 : x + 8, y, {
        align: side === "left" ? "right" : "left",
        color: COLORS.muted,
        font: "10px Microsoft YaHei, sans-serif",
      });
    }
    context.restore();
  }

  function drawLayer(context, x, y, width, height, row, options = {}) {
    const fill = options.inactive ? COLORS.inactive : (LITHOLOGY_COLORS[row.lithology] || COLORS.inactive);
    const alpha = options.inactive ? 0.48 : 1;
    context.save();
    context.globalAlpha = alpha;
    roundRect(context, x, y, width, Math.max(1, height), 4);
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = options.inactive ? "#b9c3c9" : COLORS.white;
    context.lineWidth = 1;
    context.stroke();
    context.restore();

    if (height >= 24 && !options.compact) {
      drawText(context, row.name || LITHOLOGY_LABELS[row.lithology] || "地层", x + width / 2, y + height / 2 - 6, {
        align: "center",
        color: options.inactive ? COLORS.muted : COLORS.ink,
        font: "600 11px Microsoft YaHei, sans-serif",
      });
      drawText(context, `${Math.round(finite(options.thickness))} m`, x + width / 2, y + height / 2 + 9, {
        align: "center",
        color: options.inactive ? COLORS.muted : COLORS.ink,
        font: "10px Microsoft YaHei, sans-serif",
      });
    }
  }

  function drawLegend(context, x, y, width) {
    const keys = ["sandstone", "shale", "limestone", "siltstone", "coal"];
    const gap = width / keys.length;
    keys.forEach((key, index) => {
      const itemX = x + gap * index;
      context.fillStyle = LITHOLOGY_COLORS[key];
      context.fillRect(itemX, y - 6, 10, 10);
      drawText(context, LITHOLOGY_LABELS[key], itemX + 14, y, {
        color: COLORS.muted,
        font: "10px Microsoft YaHei, sans-serif",
      });
    });
  }

  function drawCurrentProfile(context, rows, active, layout) {
    const maxDepth = Math.max(1, ...rows.map((row) => finite(row.bottomDepth)));
    drawDepthAxis(context, layout.axisX, layout.top, layout.height, maxDepth, "left");
    rows.forEach((row) => {
      const topDepth = Math.max(0, finite(row.topDepth));
      const bottomDepth = Math.max(topDepth, finite(row.bottomDepth));
      drawLayer(
        context,
        layout.columnX,
        layout.top + topDepth / maxDepth * layout.height,
        layout.columnWidth,
        (bottomDepth - topDepth) / maxDepth * layout.height,
        row,
        { inactive: !active.includes(row), thickness: bottomDepth - topDepth },
      );
    });
    drawText(context, "现今压实地层", layout.columnX + layout.columnWidth / 2, layout.titleY, {
      align: "center",
      color: COLORS.primaryDark,
      font: "600 13px Microsoft YaHei, sans-serif",
    });
    drawText(context, `现今总深度 ${Math.round(maxDepth)} m`, layout.columnX + layout.columnWidth / 2, layout.bottomLabelY, {
      align: "center",
      color: COLORS.muted,
      font: "10px Microsoft YaHei, sans-serif",
    });
  }

  function drawReconstructedProfile(context, rows, stage, layout) {
    const active = activeRows(rows, stage);
    const ordered = [...active].sort((a, b) => finite(b.age) - finite(a.age));
    const totalOriginal = ordered.reduce((sum, row) => sum + Math.max(0, finite(row.originalThickness)), 0);
    const waterDepth = currentWaterDepth(rows, stage);
    const waterBand = Math.min(32, Math.max(18, waterDepth / Math.max(1, totalOriginal) * layout.height));
    const rockTop = layout.top + waterBand;
    const rockHeight = Math.max(1, layout.height - waterBand);

    context.save();
    context.fillStyle = COLORS.water;
    context.fillRect(layout.columnX, layout.top, layout.columnWidth, waterBand);
    context.strokeStyle = COLORS.waterDark;
    context.lineWidth = 1;
    context.strokeRect(layout.columnX, layout.top, layout.columnWidth, waterBand);
    context.restore();
    drawText(context, `水深 ${Math.round(waterDepth)} m`, layout.columnX + layout.columnWidth / 2, layout.top + waterBand / 2, {
      align: "center",
      color: COLORS.waterDark,
      font: "10px Microsoft YaHei, sans-serif",
    });

    drawDepthAxis(context, layout.axisX, rockTop, rockHeight, totalOriginal, "right");
    let cumulative = 0;
    ordered.forEach((row) => {
      const thickness = Math.max(0, finite(row.originalThickness));
      const layerBottom = rockTop + rockHeight - cumulative / Math.max(1, totalOriginal) * rockHeight;
      const layerTop = rockTop + rockHeight - (cumulative + thickness) / Math.max(1, totalOriginal) * rockHeight;
      drawLayer(context, layout.columnX, layerTop, layout.columnWidth, layerBottom - layerTop, row, {
        thickness,
        compact: thickness / Math.max(1, totalOriginal) < 0.12,
      });
      cumulative += thickness;
    });

    drawText(context, stage.age === null ? "去压实重建（现在）" : `${stage.label}回剥重建`, layout.columnX + layout.columnWidth / 2, layout.titleY, {
      align: "center",
      color: COLORS.primaryDark,
      font: "600 13px Microsoft YaHei, sans-serif",
    });
    drawText(context, `原始厚度 ${Math.round(totalOriginal)} m`, layout.columnX + layout.columnWidth / 2, layout.bottomLabelY, {
      align: "center",
      color: COLORS.muted,
      font: "10px Microsoft YaHei, sans-serif",
    });
    const seaLevel = currentSeaLevel(rows, stage);
    drawText(context, `海平面 ${seaLevel >= 0 ? "+" : ""}${seaLevel.toFixed(1)} m`, layout.columnX + layout.columnWidth / 2, layout.bottomLabelY + 14, {
      align: "center",
      color: COLORS.muted,
      font: "10px Microsoft YaHei, sans-serif",
    });
  }

  function draw() {
    const { canvas } = getElements();
    if (!canvas || !state.result) return;
    const bounds = canvas.getBoundingClientRect();
    const cssWidth = Math.max(300, Math.floor(bounds.width || canvas.clientWidth || 500));
    const cssHeight = Math.max(260, Math.floor(bounds.height || canvas.clientHeight || 320));
    const ratio = Math.max(1, Math.min(2, global.devicePixelRatio || 1));
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    context.fillStyle = "#fbfcfd";
    context.fillRect(0, 0, cssWidth, cssHeight);

    const rows = rowsFromResult(state.result);
    const stage = state.stages[state.stageIndex] || { label: "现在", age: null };
    const active = activeRows(rows, stage);
    const margin = 14;
    const gap = 24;
    const titleY = 20;
    const bottomLabelY = cssHeight - 31;
    const top = 44;
    const height = Math.max(130, cssHeight - 92);
    const columnWidth = Math.max(65, (cssWidth - margin * 2 - gap - 36) / 2);
    const leftX = margin + 18;
    const rightX = leftX + columnWidth + gap;
    const leftAxis = leftX - 7;
    const rightAxis = rightX + columnWidth + 7;
    const layout = {
      top,
      height,
      titleY,
      bottomLabelY,
      columnWidth,
      columnX: leftX,
      axisX: leftAxis,
    };

    drawCurrentProfile(context, rows, active, layout);
    drawReconstructedProfile(context, rows, stage, { ...layout, columnX: rightX, axisX: rightAxis });
    drawLegend(context, margin + 2, cssHeight - 10, cssWidth - margin * 2 - 4);
  }

  function setStage(index) {
    if (!state.stages.length) return;
    state.stageIndex = Math.max(0, Math.min(state.stages.length - 1, Number(index) || 0));
    setStageLabel();
    draw();
  }

  function tick(timestamp) {
    if (!state.playing) return;
    if (!state.lastTimestamp) state.lastTimestamp = timestamp;
    if (timestamp - state.lastTimestamp >= 1100) {
      state.lastTimestamp = timestamp;
      if (state.stageIndex >= state.stages.length - 1) {
        state.playing = false;
        state.frameId = null;
        state.lastTimestamp = 0;
        setPlayLabel();
        return;
      }
      setStage(state.stageIndex + 1);
    }
    state.frameId = global.requestAnimationFrame(tick);
  }

  function togglePlay() {
    if (!state.result || state.stages.length < 2) return;
    if (state.playing) {
      state.playing = false;
      state.lastTimestamp = 0;
      if (state.frameId) global.cancelAnimationFrame(state.frameId);
      state.frameId = null;
      setPlayLabel();
      return;
    }
    if (state.stageIndex >= state.stages.length - 1) setStage(0);
    state.playing = true;
    state.lastTimestamp = 0;
    setPlayLabel();
    state.frameId = global.requestAnimationFrame(tick);
  }

  function bindControls() {
    const { slider, playButton, resetButton, canvas } = getElements();
    if (slider && !slider.dataset.bound) {
      slider.addEventListener("input", () => {
        state.playing = false;
        if (state.frameId) global.cancelAnimationFrame(state.frameId);
        state.frameId = null;
        state.lastTimestamp = 0;
        setPlayLabel();
        setStage(slider.value);
      });
      slider.dataset.bound = "true";
    }
    if (playButton && !playButton.dataset.bound) {
      playButton.addEventListener("click", togglePlay);
      playButton.dataset.bound = "true";
    }
    if (resetButton && !resetButton.dataset.bound) {
      resetButton.addEventListener("click", () => {
        state.playing = false;
        if (state.frameId) global.cancelAnimationFrame(state.frameId);
        state.frameId = null;
        state.lastTimestamp = 0;
        setPlayLabel();
        setStage(0);
      });
      resetButton.dataset.bound = "true";
    }
    if (canvas && !canvas.dataset.bound) {
      canvas.dataset.bound = "true";
      if (typeof global.ResizeObserver === "function") {
        state.resizeObserver = new global.ResizeObserver(draw);
        state.resizeObserver.observe(canvas);
      } else {
        global.addEventListener("resize", draw);
      }
    }
  }

  function render(result, canvasId = "backstripProfileCanvas") {
    state.result = result;
    state.canvasId = canvasId;
    state.stages = buildStages(rowsFromResult(result));
    state.stageIndex = 0;
    state.playing = false;
    if (state.frameId) global.cancelAnimationFrame(state.frameId);
    state.frameId = null;
    state.lastTimestamp = 0;

    const { section, slider } = getElements();
    if (section) section.hidden = false;
    if (slider) {
      slider.min = "0";
      slider.max = String(Math.max(0, state.stages.length - 1));
      slider.step = "1";
    }
    bindControls();
    setPlayLabel();
    setStageLabel();
    draw();
  }

  function clear() {
    state.result = null;
    state.stages = [];
    state.stageIndex = 0;
    state.playing = false;
    if (state.frameId) global.cancelAnimationFrame(state.frameId);
    state.frameId = null;
    const { section } = getElements();
    if (section) section.hidden = true;
  }

  global.BackstripProfile = Object.freeze({ render, clear });
}(window));
