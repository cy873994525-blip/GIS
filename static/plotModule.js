/* Chart.js 4.4 回剥结果绘图模块。页面需先加载 chart.umd.min.js。 */
(function exposePlotModule(global) {
  "use strict";

  const chartRegistry = new Map();

  function getChartCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof canvas.getContext !== "function") {
      throw new Error(`找不到图表画布：${canvasId}`);
    }
    const previous = chartRegistry.get(canvasId);
    if (previous && typeof previous.destroy === "function") previous.destroy();
    return canvas;
  }

  function drawFallback(canvas, title, yTitle, datasets) {
    const context = canvas.getContext("2d");
    const ratio = global.devicePixelRatio || 1;
    const width = Math.max(320, canvas.clientWidth || 640);
    const height = Math.max(180, canvas.clientHeight || 220);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);

    const padding = { left: 44, right: 14, top: 30, bottom: 32 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const points = datasets.flatMap((dataset) => dataset.data);
    if (!points.length) return { destroy() {} };
    const xValues = points.map((point) => point.x);
    const yValues = points.map((point) => point.y).concat([0]);
    const xMin = Math.min(...xValues);
    const xMax = Math.max(...xValues);
    const yMin = Math.min(...yValues);
    const yMax = Math.max(...yValues);
    const xRange = xMax === xMin ? 1 : xMax - xMin;
    const yRange = yMax === yMin ? 1 : yMax - yMin;
    const toScreen = (point) => ({
      x: padding.left + ((xMax - point.x) / xRange) * plotWidth,
      y: padding.top + ((yMax - point.y) / yRange) * plotHeight,
    });

    context.strokeStyle = "#aebdc5";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(padding.left, padding.top);
    context.lineTo(padding.left, height - padding.bottom);
    context.lineTo(width - padding.right, height - padding.bottom);
    context.stroke();
    context.fillStyle = "#173b53";
    context.font = "600 13px sans-serif";
    context.fillText(title, padding.left, 18);
    context.font = "10px sans-serif";
    context.fillStyle = "#5b6b73";
    context.fillText("年龄 (Ma)", width - 72, height - 8);
    context.save();
    context.translate(12, height / 2 + 20);
    context.rotate(-Math.PI / 2);
    context.fillText(yTitle, 0, 0);
    context.restore();

    datasets.forEach((dataset) => {
      if (!dataset.data.length) return;
      const screenPoints = dataset.data.map(toScreen);
      context.beginPath();
      screenPoints.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      if (dataset.fill) {
        context.lineTo(screenPoints[screenPoints.length - 1].x, height - padding.bottom);
        context.lineTo(screenPoints[0].x, height - padding.bottom);
        context.closePath();
        context.fillStyle = dataset.fillColor || "rgba(100, 181, 246, 0.18)";
        context.fill();
        context.beginPath();
        screenPoints.forEach((point, index) => {
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
      }
      context.strokeStyle = dataset.color;
      context.lineWidth = 2;
      if (dataset.dashed) context.setLineDash([6, 4]);
      context.stroke();
      context.setLineDash([]);
    });

    let legendX = padding.left;
    datasets.forEach((dataset) => {
      context.fillStyle = dataset.color;
      context.fillRect(legendX, height - 19, 16, 2);
      context.fillStyle = "#52636b";
      context.font = "10px sans-serif";
      context.fillText(dataset.label, legendX + 21, height - 15);
      legendX += 78;
    });
    return { destroy() {} };
  }

  function toAgePoints(items, valueAccessor) {
    return (Array.isArray(items) ? items : [])
      .filter((item) => Number.isFinite(Number(item.age))
        && Number.isFinite(Number(valueAccessor(item))))
      .map((item) => ({
        x: Number(item.age),
        // 沉降向下为负；负沉降（隆升）保留为正值，避免掩盖地质意义。
        y: -Number(valueAccessor(item)),
      }))
      .sort((a, b) => a.x - b.x);
  }

  function baseScaleOptions(yTitle) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label(context) {
              return `${context.dataset.label}: ${context.parsed.y.toFixed(2)} m`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          reverse: true,
          title: { display: true, text: "年龄 (Ma)" },
          ticks: { callback: (value) => `${value}` },
        },
        y: {
          title: { display: true, text: yTitle },
          ticks: { callback: (value) => `${value}` },
        },
      },
    };
  }

  function plotBurialHistory(result, canvasId) {
    const canvas = getChartCanvas(canvasId);
    const data = toAgePoints(result && result.burialHistory, (item) => item.depth);
    if (!global.Chart) {
      const fallback = drawFallback(canvas, "埋藏史图", "深度 (m)", [
        { label: "底界深度", data, color: "#3288bd", fill: true },
      ]);
      chartRegistry.set(canvasId, fallback);
      return fallback;
    }
    const chart = new global.Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [{
          label: "底界深度",
          data,
          borderColor: "#3288bd",
          backgroundColor: "rgba(100, 181, 246, 0.25)",
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: "#1976a8",
          tension: 0.15,
          fill: true,
        }],
      },
      options: {
        ...baseScaleOptions("深度 (m)"),
        plugins: {
          ...baseScaleOptions("深度 (m)").plugins,
          title: { display: true, text: "埋藏史图", color: "#173b53", font: { size: 16, weight: "600" } },
        },
      },
    });
    chartRegistry.set(canvasId, chart);
    return chart;
  }

  function plotTectonicSubsidence(result, canvasId) {
    const canvas = getChartCanvas(canvasId);
    const values = Array.isArray(result && result.tectonicSubsidence)
      ? result.tectonicSubsidence
      : [];
    const points = (accessor) => values
      .filter((item) => Number.isFinite(Number(item.age))
        && Number.isFinite(Number(accessor(item))))
      .map((item) => ({ x: Number(item.age), y: -Number(accessor(item)) }))
      .sort((a, b) => a.x - b.x);
    if (!global.Chart) {
      const fallback = drawFallback(canvas, "构造沉降 vs 负载沉降", "沉降量 (m)", [
        { label: "总沉降", data: points((item) => item.totalSubsidence), color: "#6b7280", dashed: true },
        { label: "构造沉降", data: points((item) => item.tectonicSubsidence), color: "#d1495b", fill: true, fillColor: "rgba(209, 73, 91, 0.16)" },
        { label: "负载沉降", data: points((item) => item.loadSubsidence), color: "#2f855a" },
      ]);
      chartRegistry.set(canvasId, fallback);
      return fallback;
    }

    const chart = new global.Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [
          {
            label: "总沉降",
            data: points((item) => item.totalSubsidence),
            borderColor: "#6b7280",
            borderDash: [7, 5],
            backgroundColor: "transparent",
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.15,
          },
          {
            label: "构造沉降",
            data: points((item) => item.tectonicSubsidence),
            borderColor: "#d1495b",
            backgroundColor: "rgba(209, 73, 91, 0.18)",
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.15,
            fill: true,
          },
          {
            label: "负载沉降",
            data: points((item) => item.loadSubsidence),
            borderColor: "#2f855a",
            backgroundColor: "rgba(47, 133, 90, 0.08)",
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.15,
          },
        ],
      },
      options: {
        ...baseScaleOptions("沉降量 (m)"),
        plugins: {
          ...baseScaleOptions("沉降量 (m)").plugins,
          title: { display: true, text: "构造沉降 vs 负载沉降", color: "#173b53", font: { size: 16, weight: "600" } },
        },
      },
    });
    chartRegistry.set(canvasId, chart);
    return chart;
  }

  global.PlotModule = Object.freeze({ plotBurialHistory, plotTectonicSubsidence });
}(window));
