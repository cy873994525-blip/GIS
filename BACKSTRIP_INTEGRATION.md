# 回剥模块集成说明

## 已加入的文件

- `static/backstrip.js`：无依赖的去压实和 Airy 回剥计算，导出 `window.Backstrip`。
- `static/plotModule.js`：Chart.js 4.4 埋藏史、构造沉降/负载沉降图，导出 `window.PlotModule`。
- `static/mapModule.js`：ArcGIS Maps SDK 4.29 井位和沉降速率图层，导出 `window.MapModule`。
- `static/backstrip-panel.js`：地层表格、示例数据、计算按钮、图表和地图属性联动。

## 页面加载顺序

`static/index.html` 已按以下顺序加载：

1. Chart.js 4.4 CDN
2. ArcGIS 4.29 CDN
3. 原有 `app.js`
4. `backstrip.js`、`plotModule.js`、`mapModule.js`、`backstrip-panel.js`

Chart.js 必须先于 ArcGIS 加载。ArcGIS 4.29 使用 Dojo/AMD loader；如果先加载 ArcGIS，Chart.js 的 UMD 包会被误识别成匿名 AMD 模块，导致 `esri/Map` 被错误解析为 Chart 构造器。页面脚本带有版本查询参数，用于课堂演示时避免浏览器继续使用旧缓存。

如果页面提供 `<div id="mapView"></div>`，`MapModule` 会自动创建 `topo-vector` 地图、`井位` 图层和 `沉降速率` 图层，中心为 `[121, 45]`、缩放级别为 6。如果继续使用压缩包原有的 `mapCanvas`，模块会安全跳过 ArcGIS 初始化，不影响原有 Canvas 编辑器。

地图面板在桌面布局中固定为一屏高度，避免右侧回剥表格、图表和剖面动画把 ArcGIS MapView 拉伸成整页；切换到“ArcGIS 沉降专题图”后会重新计算视图尺寸并聚焦训练井位。专题图点击井位会打开属性弹窗，并尝试反向选中右侧属性表对应记录。

## 与现有 GIS-main 的联动

`static/app.js` 新增 `window.GisApp.updateWellAnalysis()`。回剥计算完成后，它会将当前数据集中的 Point 要素写入：

```js
feature.properties.tectonicSubsidence
feature.properties.rate
```

然后沿用原有保存、重载、属性表刷新流程；Canvas 点符号根据 `rate` 自动使用蓝-黄-红渐变。若使用 ArcGIS `mapView`，同一批属性也会传入 `MapModule.renderSubsidenceRate()`。

## 本轮完善内容

- 校验 `paleoWaterDepth`、`seaLevel` 数组长度，避免输入错位。
- 用户打乱地层年龄时，古水深和海平面会跟随对应表格行一起排序。
- 对极薄地层使用稳定的 `expm1` 形式计算平均孔隙度。
- 输出 `summary` 和 `diagnostics`，包含总原始厚度、末期构造沉降、平均速率、深度间断和输入重排提示。
- 图表保留负沉降值（隆升）为向上的正值，不再把所有结果强行截成向下。
- 增加区间速率表和“导出回剥 JSON”按钮。
- Chart.js CDN 无法访问时自动使用内置 Canvas 降级绘图，课堂演示不依赖临时网络状态。
- 井位属性写回优先匹配图层或名称中包含“井位 / 井点 / well”的 Point 要素；找不到专门井位时才回退到全部点要素。
- `static/songliao-wells.geojson` 为课程演示用虚构训练井位，字段中的 `note` 明确标注这一点；正式分析时可替换为实际井位 GeoJSON。

## 运行

```text
python server.py 8000
```

打开 `http://127.0.0.1:8000/`，在右侧“沉降回剥分析”面板中载入示例数据并开始计算。

## 验证命令

```text
node --test --test-isolation=none tests/backstrip.test.js
node --check static/backstrip.js
node --check static/backstrip-panel.js
node --check static/plotModule.js
python -m py_compile server.py
```

## 计算口径

当前实现严格按需求中的简化 Airy 均衡公式计算：`rhoM=3330`、`rhoW=1030`、参考沉积物密度 `rhoS=2500 kg/m³`。各岩性的颗粒密度会保存在 `formationResults` 中供审计，但不会替换题目指定的统一 `rhoS`。沉降速率是相邻底界年龄点之间的构造沉降有限差分，面板中的平均速率仅用于井位图层的单值 `rate` 字段。该模型不包含弹性挠曲、热沉降、侵蚀剥蚀、压实历史耦合或横向沉积厚度变化；用于课程演示和快速敏感性分析时应保留这些假设说明。
