/*
 * ArcGIS Maps SDK for JavaScript 4.29 的井位与沉降速率图层。
 * 页面需要先加载 https://js.arcgis.com/4.29/，并提供 <div id="mapView">。
 */
(function exposeMapModule(global) {
  "use strict";

  const moduleApi = {
    view: null,
    wellsLayer: null,
    subsidenceLayer: null,
    ready: Promise.resolve(null),
    drawWells: () => [],
    renderSubsidenceRate: () => [],
    focusOnWells: () => {},
    lastWells: [],
  };
  global.MapModule = moduleApi;

  const container = document.getElementById("mapView");
  const arcgisRequire = global.require;
  if (!container || typeof arcgisRequire !== "function") {
    // 当前 GIS-main 项目原本使用 Canvas 地图；没有 mapView 时模块保持可加载，
    // 这样同一套文件也可以在已有 ArcGIS 页面中直接复用。
    return;
  }

  moduleApi.ready = new Promise((resolve, reject) => {
    arcgisRequire([
      "esri/Map",
      "esri/views/MapView",
      "esri/layers/GraphicsLayer",
      "esri/Graphic",
      "esri/geometry/Point",
    ], (Map, MapView, GraphicsLayer, Graphic, Point) => {
      try {
        const map = new Map({ basemap: "topo-vector" });
        const view = new MapView({
          container: "mapView",
          map,
          center: [121, 45],
          zoom: 6,
        });
        // 显式开启 Graphic popup；不同页面主题或宿主配置可能会关闭
        // MapView 的默认点击弹窗，因此联动演示不依赖隐式默认值。
        view.popupEnabled = true;
        const wellsLayer = new GraphicsLayer({ title: "井位" });
        const subsidenceLayer = new GraphicsLayer({ title: "沉降速率" });
        const wellPopup = document.createElement("div");
        wellPopup.className = "arcgis-well-popup";
        wellPopup.hidden = true;
        wellPopup.setAttribute("role", "dialog");
        wellPopup.setAttribute("aria-label", "井位回剥属性");
        container.appendChild(wellPopup);
        const wellHitLayer = document.createElement("div");
        wellHitLayer.className = "arcgis-well-hit-layer";
        wellHitLayer.setAttribute("aria-label", "井位点击热区");
        container.appendChild(wellHitLayer);
        // 逐层添加，避免把 Map 当作 GraphicsLayer 使用。ArcGIS 4.29 的
        // Map 提供 add/addMany，但某些页面中可能被其他脚本覆盖 addMany；
        // 这里优先使用稳定的 add 方法，并在极少数兼容环境中回退到 addMany。
        const addLayer = (layer) => {
          if (typeof map.add === "function") map.add(layer);
          else if (typeof map.addMany === "function") map.addMany([layer]);
          else throw new Error("ArcGIS Map 不支持添加图层的方法");
        };
        addLayer(wellsLayer);
        addLayer(subsidenceLayer);

        // GraphicsLayer 在 4.29 中支持 addMany；为了让模块在精简版 SDK、
        // 测试桩或页面已有同名对象时仍可运行，统一通过这个小适配器添加。
        const addGraphics = (layer, graphics) => {
          if (typeof layer.addMany === "function") layer.addMany(graphics);
          else graphics.forEach((graphic) => layer.add(graphic));
        };

        const popupTemplate = {
          title: "{name}",
          content: [
            { type: "fields", fieldInfos: [
              { fieldName: "lon", label: "经度", format: { places: 4 } },
              { fieldName: "lat", label: "纬度", format: { places: 4 } },
              { fieldName: "tectonicSubsidence", label: "构造沉降 (m)", format: { places: 2 } },
              { fieldName: "rate", label: "沉降速率 (m/Ma)", format: { places: 3 } },
            ] },
          ],
        };

        function pointGraphic(well, symbol) {
          const lon = Number(well.lon);
          const lat = Number(well.lat);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
          // 保留原 GeoJSON 要素 ID，使 ArcGIS 点击能够反向选中右侧属性表中的行。
          const featureId = well.id ?? well.featureId ?? well.properties?.id ?? null;
          return new Graphic({
            geometry: new Point({ longitude: lon, latitude: lat }),
            attributes: {
              featureId,
              name: well.name || "未命名井",
              lon,
              lat,
              tectonicSubsidence: Number(well.tectonicSubsidence) || 0,
              rate: Number(well.rate) || 0,
            },
            symbol,
            popupTemplate,
          });
        }

        // hitTest 在不同浏览器/显卡组合下偶尔不会返回 GraphicsLayer 的 layer
        // 引用。保留一条按屏幕距离匹配最近井位的回退路径，确保课堂演示中
        // 点击彩色圆点仍能打开属性弹窗并触发属性表联动。
        function nearestWell(eventX, eventY) {
          const candidates = Array.isArray(moduleApi.lastWells) ? moduleApi.lastWells : [];
          if (!candidates.length || typeof view.toScreen !== "function") return null;
          let nearest = null;
          candidates.forEach((well) => {
            const lon = Number(well.lon);
            const lat = Number(well.lat);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            const screen = view.toScreen(new Point({ longitude: lon, latitude: lat }));
            if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return;
            const distance = Math.hypot(screen.x - eventX, screen.y - eventY);
            if (!nearest || distance < nearest.distance) nearest = { well, distance };
          });
          return nearest && nearest.distance <= 30 ? nearest : null;
        }

        function nearestWellGraphic(event) {
          const nearest = nearestWell(event.x, event.y);
          if (!nearest) return null;
          return pointGraphic(nearest.well, {
            type: "simple-marker",
            color: "#ffd700",
            size: 16,
            outline: { color: "#ffffff", width: 2 },
          });
        }

        function showWellPopup(well, x, y) {
          if (!well) return;
          wellPopup.replaceChildren();
          const header = document.createElement("div");
          header.className = "arcgis-well-popup-header";
          const title = document.createElement("strong");
          title.textContent = well.name || "未命名井";
          const close = document.createElement("button");
          close.type = "button";
          close.className = "arcgis-well-popup-close";
          close.setAttribute("aria-label", "关闭井位属性");
          close.textContent = "×";
          close.addEventListener("click", (event) => {
            event.stopPropagation();
            wellPopup.hidden = true;
          });
          header.append(title, close);
          const body = document.createElement("div");
          body.className = "arcgis-well-popup-body";
          const rows = [
            ["经度", Number(well.lon).toFixed(4)],
            ["纬度", Number(well.lat).toFixed(4)],
            ["构造沉降", `${Number(well.tectonicSubsidence || 0).toFixed(2)} m`],
            ["沉降速率", `${Number(well.rate || 0).toFixed(3)} m/Ma`],
          ];
          rows.forEach(([label, value]) => {
            const row = document.createElement("div");
            const labelNode = document.createElement("span");
            labelNode.textContent = label;
            const valueNode = document.createElement("strong");
            valueNode.textContent = value;
            row.append(labelNode, valueNode);
            body.appendChild(row);
          });
          wellPopup.append(header, body);
          const maxLeft = Math.max(8, container.clientWidth - 224);
          const maxTop = Math.max(8, container.clientHeight - 150);
          wellPopup.style.left = `${Math.min(Math.max(8, x + 14), maxLeft)}px`;
          wellPopup.style.top = `${Math.min(Math.max(8, y - 12), maxTop)}px`;
          wellPopup.hidden = false;
        }

        function selectWell(well) {
          const featureId = well?.id ?? well?.featureId ?? well?.properties?.id;
          if (featureId === null || featureId === undefined || featureId === "") return;
          if (global.GisApp && typeof global.GisApp.selectFeatureById === "function") {
            global.GisApp.selectFeatureById(String(featureId));
          }
        }

        function updateWellHitTargets() {
          wellHitLayer.replaceChildren();
          if (!container.clientWidth || !container.clientHeight || typeof view.toScreen !== "function") return;
          (Array.isArray(moduleApi.lastWells) ? moduleApi.lastWells : []).forEach((well) => {
            const screen = view.toScreen(new Point({
              longitude: Number(well.lon),
              latitude: Number(well.lat),
            }));
            if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return;
            if (screen.x < -20 || screen.y < -20 || screen.x > container.clientWidth + 20 || screen.y > container.clientHeight + 20) return;
            const hitButton = document.createElement("button");
            hitButton.type = "button";
            hitButton.className = "arcgis-well-hit-target";
            hitButton.setAttribute("aria-label", `查看 ${well.name || "井位"} 回剥属性`);
            hitButton.title = well.name || "井位回剥属性";
            hitButton.style.left = `${screen.x}px`;
            hitButton.style.top = `${screen.y}px`;
            hitButton.addEventListener("click", (event) => {
              event.stopPropagation();
              showWellPopup(well, screen.x, screen.y);
              selectWell(well);
            });
            wellHitLayer.appendChild(hitButton);
          });
        }

        container.addEventListener("click", (event) => {
          if (event.target.closest(".arcgis-well-popup")) return;
          const rect = container.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const nearest = nearestWell(x, y);
          if (!nearest) return;
          showWellPopup(nearest.well, x, y);
          selectWell(nearest.well);
        });

        if (typeof view.watch === "function") {
          view.watch("extent", updateWellHitTargets);
          view.watch("width", updateWellHitTargets);
          view.watch("height", updateWellHitTargets);
        }
        global.addEventListener("resize", updateWellHitTargets);

        // 载入分析井后把视图轻微聚焦到井位范围，避免课堂演示时点位落在
        // 初始全国范围的边缘。初始视图仍严格使用 [121, 45] / zoom 6；
        // 只有真正绘制井位后才执行这次数据驱动的聚焦。
        function focusOnWells(wells) {
          // hidden 容器没有可用的渲染尺寸，先保留 lastWells，待 app.js 在
          // 切换到 ArcGIS 视图并调用 resize 后再次执行。
          if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return;
          const coordinates = (Array.isArray(wells) ? wells : [])
            .map((well) => [Number(well.lon), Number(well.lat)])
            .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
          if (!coordinates.length || !view || typeof view.goTo !== "function") return;
          const longitudes = coordinates.map(([lon]) => lon);
          const latitudes = coordinates.map(([, lat]) => lat);
          const center = [
            (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
            (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
          ];
          const span = Math.max(
            Math.max(...longitudes) - Math.min(...longitudes),
            Math.max(...latitudes) - Math.min(...latitudes),
          );
          const zoom = span > 5 ? 6 : span > 2.5 ? 7 : 8;
          // 直接设置属性可在 hidden 容器中立即保存目标视图；显示后再调用
          // resize，避免 goTo 因零尺寸容器一直处于 pending 状态。
          try {
            view.center = center;
            view.zoom = zoom;
          } catch (error) {
            // 聚焦失败不影响图层和弹窗功能。
          }
        }

        moduleApi.view = view;
        moduleApi.wellsLayer = wellsLayer;
        moduleApi.subsidenceLayer = subsidenceLayer;
        moduleApi.focusOnWells = focusOnWells;

        // ArcGIS 专题图与 Canvas 编辑地图共用同一批 GeoJSON 要素。点击专题图
        // 上的点时，把 featureId 交给 GIS 主模块，从而同步高亮属性表行。
        view.on("click", async (event) => {
          try {
            const response = await view.hitTest(event, {
              include: [wellsLayer, subsidenceLayer],
            });
            const hit = response.results.find((item) => {
              const graphic = item && item.graphic;
              // 不同 4.29 构建版本返回的 hitTest Graphic 可能不带 layer 引用；
              // featureId 是本模块写入的稳定标记，因此作为兼容性回退条件。
              return graphic && (
                graphic.layer === wellsLayer ||
                graphic.layer === subsidenceLayer ||
                graphic.attributes?.featureId !== undefined
              );
            });
            const graphic = hit?.graphic || nearestWellGraphic(event);
            if (!graphic) return;
            if (typeof view.openPopup === "function") {
              view.openPopup({
                features: [graphic],
                location: graphic.geometry,
              });
            }
            const featureId = graphic.attributes?.featureId;
            if (featureId === null || featureId === undefined || featureId === "") return;

            if (global.GisApp && typeof global.GisApp.selectFeatureById === "function") {
              global.GisApp.selectFeatureById(String(featureId));
            } else if (typeof global.dispatchEvent === "function") {
              // 主模块尚未暴露方法时保留一个事件扩展点，不影响 ArcGIS 弹窗本身。
              global.dispatchEvent(new CustomEvent("gis:select-feature", {
                detail: { id: String(featureId) },
              }));
            }
          } catch (error) {
            // 点击联动是增强功能，命中测试失败不应阻断 ArcGIS 的默认弹窗。
            console.warn("ArcGIS 点选联动失败：", error);
          }
        });

        moduleApi.drawWells = (wells) => {
          const symbol = {
            type: "simple-marker",
            color: "#177ddc",
            size: 10,
            outline: { color: "#ffffff", width: 1.5 },
          };
          const graphics = (Array.isArray(wells) ? wells : [])
            .map((well) => pointGraphic(well, symbol))
            .filter(Boolean);
          wellsLayer.removeAll();
          addGraphics(wellsLayer, graphics);
          updateWellHitTargets();
          return graphics;
        };

        moduleApi.renderSubsidenceRate = (wells) => {
          const validWells = (Array.isArray(wells) ? wells : [])
            .filter((well) => Number.isFinite(Number(well.rate)));
          moduleApi.lastWells = validWells;
          const rates = validWells.map((well) => Number(well.rate));
          const min = rates.length ? Math.min(...rates) : 0;
          const max = rates.length ? Math.max(...rates) : 1;

          function colourForRate(rate) {
            const t = max === min ? 0.5 : Math.min(1, Math.max(0, (rate - min) / (max - min)));
            const stops = t < 0.5
              ? [[23, 125, 220], [255, 215, 0], t * 2]
              : [[255, 215, 0], [220, 50, 47], (t - 0.5) * 2];
            const mix = (from, to, amount) => Math.round(from + (to - from) * amount);
            return `rgb(${mix(stops[0][0], stops[1][0], stops[2])}, ${mix(stops[0][1], stops[1][1], stops[2])}, ${mix(stops[0][2], stops[1][2], stops[2])})`;
          }

          const graphics = validWells.map((well) => pointGraphic(well, {
            type: "simple-marker",
            color: colourForRate(Number(well.rate)),
            size: 16,
            outline: { color: "#ffffff", width: 2 },
          })).filter(Boolean);
          subsidenceLayer.removeAll();
          addGraphics(subsidenceLayer, graphics);
          focusOnWells(validWells);
          updateWellHitTargets();
          return graphics;
        };

        // MapView 可能在隐藏的 tab 中初始化。等待 ArcGIS 自身就绪后再刷新一次
        // 视图，避免初始 canvas 尺寸为 0 导致白屏；不把这个等待链并入 ready，
        // 这样即使底图服务暂时不可达，回剥计算和属性写回仍可继续。
        if (typeof view.when === "function") {
          view.when(() => {
            if (typeof view.resize === "function") view.resize();
            updateWellHitTargets();
          }).catch((error) => {
            console.warn("ArcGIS MapView 初始化提示：", error);
          });
        }

        resolve(view);
      } catch (error) {
        reject(error);
      }
    }, reject);
  });
}(window));
