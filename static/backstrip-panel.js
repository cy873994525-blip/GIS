/* 现有 GIS-main 页面中的回剥表单、图表和井位属性联动。 */
(function initialiseBackstripPanel(global) {
  "use strict";

  const rowsContainer = document.getElementById("formationRows");
  if (!rowsContainer) return;
  let lastResult = null;

  const LITHOLOGIES = [
    ["sandstone", "砂岩"],
    ["shale", "页岩"],
    ["limestone", "灰岩"],
    ["siltstone", "粉砂岩"],
    ["coal", "煤"],
  ];

  const EXAMPLE = {
    formations: [
      { name: "嫩江组", topDepth: 0, bottomDepth: 900, age: 65, lithology: "shale" },
      { name: "青山口组", topDepth: 900, bottomDepth: 2200, age: 88, lithology: "shale" },
      { name: "泉头组", topDepth: 2200, bottomDepth: 3600, age: 105, lithology: "sandstone" },
      { name: "营城组", topDepth: 3600, bottomDepth: 4700, age: 125, lithology: "sandstone" },
    ],
    paleoWaterDepth: [25, 40, 55, 75],
    seaLevel: [0, 5, -10, -20],
  };

  function createFormationRow(values = {}) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input data-field="name" type="text" maxlength="40" placeholder="地层名"></td>
      <td><input data-field="topDepth" type="number" min="0" step="0.1" placeholder="0"></td>
      <td><input data-field="bottomDepth" type="number" min="0" step="0.1" placeholder="1000"></td>
      <td><input data-field="age" type="number" min="0" step="0.1" placeholder="65"></td>
      <td><select data-field="lithology"></select></td>
      <td><button type="button" class="row-delete" title="删除地层" aria-label="删除地层">×</button></td>
    `;
    const select = row.querySelector('[data-field="lithology"]');
    LITHOLOGIES.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });
    for (const [field, value] of Object.entries(values)) {
      const input = row.querySelector(`[data-field="${field}"]`);
      if (input && value !== undefined) input.value = value;
    }
    select.value = values.lithology || "sandstone";
    row.querySelector(".row-delete").addEventListener("click", () => {
      if (rowsContainer.children.length === 1) {
        row.querySelectorAll("input").forEach((input) => { input.value = ""; });
        select.value = "sandstone";
        return;
      }
      row.remove();
    });
    rowsContainer.appendChild(row);
    return row;
  }

  function replaceFormations(formations) {
    rowsContainer.replaceChildren();
    formations.forEach(createFormationRow);
  }

  function parseNumberSeries(raw, label) {
    const text = String(raw || "").trim();
    if (!text) return [];
    return text.split(",").map((item, index) => {
      const value = Number(item.trim());
      if (!Number.isFinite(value)) throw new Error(`${label}第 ${index + 1} 项不是有效数字。`);
      return value;
    });
  }

  function readForm() {
    const sourceRows = [...rowsContainer.querySelectorAll("tr")];
    const records = sourceRows.map((row, index) => {
      const value = (field) => row.querySelector(`[data-field="${field}"]`).value.trim();
      const name = value("name");
      const topDepth = Number(value("topDepth"));
      const bottomDepth = Number(value("bottomDepth"));
      const age = Number(value("age"));
      if (!name) throw new Error(`第 ${index + 1} 行的地层名不能为空。`);
      if (![topDepth, bottomDepth, age].every(Number.isFinite)) {
        throw new Error(`第 ${index + 1} 行的顶深、底深和年龄必须是数字。`);
      }
      return { formation: { name, topDepth, bottomDepth, age, lithology: value("lithology") }, rowIndex: index };
    });

    if (!records.length) throw new Error("至少需要一层地层。 ");
    const paleoWaterDepth = parseNumberSeries(
      document.getElementById("paleoWaterDepthInput").value,
      "古水深",
    );
    const seaLevel = parseNumberSeries(
      document.getElementById("seaLevelInput").value,
      "海平面",
    );
    if (paleoWaterDepth.length && paleoWaterDepth.length !== records.length) {
      throw new Error("古水深数组长度必须与地层数一致，或留空。 ");
    }
    if (seaLevel.length && seaLevel.length !== records.length) {
      throw new Error("海平面数组长度必须与地层数一致，或留空。 ");
    }
    // 年龄排序时把与表格行对应的辅助数组一并带过去，防止水深/海平面错配。
    records.sort((a, b) => a.formation.age - b.formation.age || a.rowIndex - b.rowIndex);
    const sortedWater = records.map((record) => paleoWaterDepth[record.rowIndex] ?? 0);
    const sortedSeaLevel = records.map((record) => seaLevel[record.rowIndex] ?? 0);
    return {
      formations: records.map((record) => record.formation),
      paleoWaterDepth: sortedWater,
      seaLevel: sortedSeaLevel,
    };
  }

  function setStatus(message, isError = false) {
    const element = document.getElementById("backstripStatus");
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("error", isError);
  }

  /**
   * 更新回剥结果与地图之间的联动提示。
   * 这里单独维护状态，是为了让用户知道“算出了数值”与“数值已经写回井位”
   * 是两个不同阶段，也避免把没有井位的普通 GIS 点误称为井位。
   */
  function setMapLink(state, message, enabled = false) {
    const stateElement = document.getElementById("backstripMapLinkState");
    const textElement = document.getElementById("backstripMapLinkText");
    const action = document.getElementById("showAnalysisAttributesBtn");
    if (stateElement) {
      stateElement.textContent = state;
      stateElement.classList.toggle("success", /同步|完成/.test(state));
      stateElement.classList.toggle("error", /失败|没有|未找到/.test(state));
    }
    if (textElement) textElement.textContent = message;
    if (action) action.disabled = !enabled;
  }

  function meanRate(rates) {
    if (!rates.length) return 0;
    return rates.reduce((sum, item) => sum + Number(item.rate), 0) / rates.length;
  }

  function wellsFromFeatures(features, tectonicValue, rateValue) {
    return (features || []).map((feature) => ({
      id: feature.id,
      name: feature.properties?.name || feature.id || "井位",
      lon: feature.geometry?.coordinates?.[0],
      lat: feature.geometry?.coordinates?.[1],
      tectonicSubsidence: tectonicValue,
      rate: rateValue,
    })).filter((well) => Number.isFinite(Number(well.lon))
      && Number.isFinite(Number(well.lat))
      && Number(well.lon) >= -180 && Number(well.lon) <= 180
      && Number(well.lat) >= -90 && Number(well.lat) <= 90);
  }

  function renderResult(result) {
    lastResult = result;
    const metrics = document.getElementById("backstripMetrics");
    const summary = result.summary;
    metrics.hidden = false;
    document.getElementById("backstripThickness").textContent = summary.totalOriginalThickness.toFixed(1);
    document.getElementById("backstripTectonic").textContent = summary.finalTectonicSubsidence.toFixed(1);
    document.getElementById("backstripRate").textContent = summary.averageTectonicRate.toFixed(3);

    const rateRows = document.getElementById("backstripRateRows");
    rateRows.replaceChildren();
    if (!result.rates.length) {
      const row = document.createElement("tr");
      row.innerHTML = "<td colspan=\"2\">单个年龄点无法计算区间速率</td>";
      rateRows.appendChild(row);
    } else {
      result.rates.forEach((item) => {
        const row = document.createElement("tr");
        const interval = document.createElement("td");
        const rate = document.createElement("td");
        interval.textContent = `${item.ageFrom.toFixed(1)} → ${item.ageTo.toFixed(1)}`;
        rate.textContent = item.rate.toFixed(3);
        row.append(interval, rate);
        rateRows.appendChild(row);
      });
    }
    document.getElementById("downloadBackstripBtn").disabled = false;
  }

  async function updateMap(features, tectonicValue, rateValue) {
    const wells = wellsFromFeatures(features, tectonicValue, rateValue);
    if (!global.MapModule || typeof global.MapModule.drawWells !== "function") return wells;
    try {
      await global.MapModule.ready;
      global.MapModule.drawWells(wells);
      global.MapModule.renderSubsidenceRate(wells);
    } catch (error) {
      // ArcGIS 容器是可选的，地图初始化失败不应阻止回剥结果和图表显示。
      console.warn("沉降速率图层更新失败：", error);
    }
    return wells;
  }

  function analysisFeatures() {
    const api = global.GisApp;
    if (!api) return [];
    if (typeof api.getAnalysisTargetInfo === "function") {
      const info = api.getAnalysisTargetInfo();
      if (info && Array.isArray(info.features)) return info.features;
    }
    if (typeof api.getPointFeatures === "function") {
      const features = api.getPointFeatures();
      return Array.isArray(features) ? features : [];
    }
    return [];
  }

  function analysisTargetLabel(count, isFallback = false) {
    if (!count) return "没有可同步的井位点";
    if (isFallback) return `当前未发现 layer=井位 的点位，已临时使用 ${count} 个点位`;
    return `${count} 个松辽训练井位`;
  }

  async function waitForGisApp(timeoutMs = 10000) {
    const started = Date.now();
    while (!global.GisApp || typeof global.GisApp.loadSongliaoWells !== "function") {
      if (Date.now() - started >= timeoutMs) {
        throw new Error("井位地图接口仍在初始化，请稍后再试。 ");
      }
      await new Promise((resolve) => global.setTimeout(resolve, 100));
    }
    return global.GisApp;
  }

  /**
   * 从侧栏按钮载入课程演示用的松辽井位。
   * 具体的数据集导入和 Canvas 刷新由 GisApp 负责，面板只负责给出回剥工作流
   * 所需的状态反馈。这样导入、属性编辑和后端保存仍然走同一条 GIS 流程。
   */
  async function loadSongliaoWells() {
    const button = document.getElementById("openSongliaoWellsBtn");
    if (button) button.disabled = true;
    setMapLink("正在载入", "正在准备松辽训练井位，载入完成后即可把回剥结果写回地图属性。", false);
    try {
      const api = await waitForGisApp();
      const response = await api.loadSongliaoWells();
      const info = api.getAnalysisTargetInfo?.();
      const responseCount = typeof response === "object" && response !== null
        ? (response.count ?? response.featureCount)
        : response;
      const count = Number.isFinite(Number(responseCount))
        ? Number(responseCount)
        : (Array.isArray(info?.features) ? info.features.length : analysisFeatures().length);
      const fallback = Boolean(info?.isFallback);
      // 先把井位画到 ArcGIS 图层（速率暂为 0），这样用户切换专题图时能
      // 立即看到分析目标；真正的构造沉降和速率在计算后再覆盖。
      await updateMap(analysisFeatures(), 0, 0);
      setStatus(`已载入松辽盆地井位训练数据（${count} 个点）。请点击“开始回剥计算”。`);
      setMapLink(
        "已载入训练井",
        `${analysisTargetLabel(count, fallback)}。开始回剥后，构造沉降和沉降速率会写入这些点的属性。`,
        false,
      );
      return count;
    } catch (error) {
      setMapLink("载入失败", error.message || "松辽训练井位载入失败。", false);
      setStatus(error.message || "松辽训练井位载入失败。", true);
      console.error(error);
      return 0;
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function showAnalysisAttributes() {
    const api = global.GisApp;
    if (api && typeof api.showAnalysisAttributes === "function") {
      return api.showAnalysisAttributes();
    }
    // 兼容旧版 app.js：至少把属性抽屉滚动到视野内，并报告当前点数。
    const drawer = document.getElementById("attributeDrawer");
    drawer?.scrollIntoView({ behavior: "smooth", block: "start" });
    return analysisFeatures().length;
  }

  async function runBackstrip() {
    try {
      const input = readForm();
      const result = global.Backstrip.backstrip(input.formations, {
        paleoWaterDepth: input.paleoWaterDepth,
        seaLevel: input.seaLevel,
      });
      renderResult(result);
      try {
        global.PlotModule.plotBurialHistory(result, "burialChart");
        global.PlotModule.plotTectonicSubsidence(result, "subsidenceChart");
      } catch (chartError) {
        console.warn("图表暂时无法绘制，回剥数值结果仍已生成：", chartError);
      }
      try {
        if (global.BackstripProfile && typeof global.BackstripProfile.render === "function") {
          global.BackstripProfile.render(result, "backstripProfileCanvas");
        }
      } catch (profileError) {
        // 剖面图是增强型解释视图，绘制失败不应阻断数值结果和地图联动。
        console.warn("地质剖面图暂时无法绘制，回剥数值结果仍已生成：", profileError);
      }

      const last = result.tectonicSubsidence[result.tectonicSubsidence.length - 1];
      const tectonicValue = last ? last.tectonicSubsidence : 0;
      const rateValue = meanRate(result.rates);
      const targetInfo = global.GisApp?.getAnalysisTargetInfo?.() || {
        features: analysisFeatures(),
        isFallback: false,
      };
      const targetFeatures = Array.isArray(targetInfo.features) ? targetInfo.features : [];
      let pointFeatures = [];
      let attributesWritten = false;
      if (global.GisApp && typeof global.GisApp.updateWellAnalysis === "function") {
        try {
          pointFeatures = await global.GisApp.updateWellAnalysis({
            tectonicSubsidence: tectonicValue,
            rate: rateValue,
          });
          attributesWritten = Array.isArray(pointFeatures) && pointFeatures.length > 0;
        } catch (mapError) {
          console.warn("井位属性写回失败，数值结果仍保留：", mapError);
        }
      }
      // updateWellAnalysis 返回的是写回后的 GeoJSON 点；兼容旧版接口时，
      // 没有返回值就使用计算前捕获的目标点，仅用于刷新专题图，不宣称属性已保存。
      const mapFeatures = pointFeatures.length ? pointFeatures : targetFeatures;
      const mappedWells = await updateMap(mapFeatures, tectonicValue, rateValue);
      const warningCount = result.diagnostics.warnings.length;
      const warningText = warningCount ? `，有 ${warningCount} 条输入提示` : "";
      if (attributesWritten && mappedWells.length) {
        const targetLabel = analysisTargetLabel(mappedWells.length, Boolean(targetInfo.isFallback));
        setMapLink(
          "已同步",
          `本次回剥结果已写入 ${targetLabel} 的 tectonicSubsidence 和 rate 字段，并刷新 ArcGIS 沉降专题图。`,
          true,
        );
        global.GisApp?.showAnalysisMap?.();
        setStatus(`回剥计算完成，已同步 ${mappedWells.length} 个井位到 ArcGIS 沉降专题图：${result.burialHistory.length} 个年龄点，平均构造沉降速率 ${rateValue.toFixed(3)} m/Ma${warningText}。`);
      } else if (mappedWells.length) {
        setMapLink(
          "未写回属性",
          `回剥数值已生成，但当前页面没有可写入的井位接口；已暂时绘制 ${mappedWells.length} 个点。`,
          false,
        );
        setStatus(`回剥计算完成，但井位属性未写回：${result.burialHistory.length} 个年龄点，平均构造沉降速率 ${rateValue.toFixed(3)} m/Ma${warningText}。`, true);
      } else {
        setMapLink(
          "未找到井位",
          "回剥数值已生成，但当前数据集没有可同步的井位点。请先载入松辽井位训练数据。",
          false,
        );
        setStatus(`回剥计算完成，但没有井位可同步：${result.burialHistory.length} 个年龄点，平均构造沉降速率 ${rateValue.toFixed(3)} m/Ma${warningText}。`);
      }
      return result;
    } catch (error) {
      setMapLink("计算失败", "回剥计算失败，尚未更新井位属性。", false);
      setStatus(error.message || "回剥计算失败。", true);
      console.error(error);
      return null;
    }
  }

  document.getElementById("addFormationBtn").addEventListener("click", () => createFormationRow());
  document.getElementById("runBackstripBtn").addEventListener("click", runBackstrip);
  document.getElementById("openSongliaoWellsBtn")?.addEventListener("click", loadSongliaoWells);
  document.getElementById("showAnalysisAttributesBtn")?.addEventListener("click", async () => {
    try {
      const count = await showAnalysisAttributes();
      if (count) setStatus(`已定位 ${count} 个井位属性记录，请在下方属性表查看 tectonicSubsidence 和 rate。`);
    } catch (error) {
      setStatus(error.message || "无法打开井位属性表。", true);
    }
  });
  document.getElementById("loadBackstripExampleBtn").addEventListener("click", () => {
    replaceFormations(EXAMPLE.formations);
    document.getElementById("paleoWaterDepthInput").value = EXAMPLE.paleoWaterDepth.join(", ");
    document.getElementById("seaLevelInput").value = EXAMPLE.seaLevel.join(", ");
    setStatus("已载入松辽盆地简化示例数据。 ");
    setMapLink(
      "等待计算",
      "地层示例已载入。若要把结果写回地图，请先载入松辽井位训练数据，再开始回剥计算。",
      false,
    );
  });
  document.getElementById("downloadBackstripBtn").addEventListener("click", () => {
    if (!lastResult) return;
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "backstrip-result.json";
    link.click();
    URL.revokeObjectURL(url);
  });

  createFormationRow();
  global.BackstripPanel = Object.freeze({
    runBackstrip,
    replaceFormations,
    loadSongliaoWells,
    showAnalysisAttributes,
  });
}(window));
