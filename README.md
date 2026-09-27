# GIS 矢量数据编辑与管理 Demo

这是一个用于“GIS 算法与应用”第一次作业展示的最小可运行版本。

## 功能

- 图层显示与显隐控制
- 鼠标交互录入点、线、面
- 地图漫游、缩放、全图显示
- 点选、框选与属性表查看
- 坐标实时读数、图层统计与选中要素删除
- 响应式工作台布局，支持桌面与窄屏展示
- Python 后端保存 GeoJSON
- GeoJSON 导出
- GeoJSON 文件导入、数据集切换与文件元数据登记
- Shapefile ZIP/成套文件导入、SHP/DBF/PRJ/CPG 解析与 GeoJSON 转换
- PostGIS 留出后续扩展位置

## 运行

```bash
python server.py 8000
```

然后打开：

```text
http://127.0.0.1:8000
```

## 操作说明

1. 在左侧设置要素名称和图层，再选择“画点 / 画线 / 画面”。
2. 画线和画面需要连续点击地图，完成后点击“完成绘制”。
3. 使用“点选”或“框选”查看属性；单选后可以修改名称和图层，删除操作会立即写入当前 GeoJSON。
4. 画线或画面过程中可以撤销节点，也可以按 `Esc` 取消绘制。
5. “全图”会根据当前数据范围自动计算合适的视图。

## A 组：后端文件数据模块（当前实现）

后端现在提供一个轻量的数据集目录。导入的文件会存放在运行时目录 `data/uploads/`，并自动登记文件元数据：

- `GET /api/datasets`：列出数据集、当前激活数据集和要素统计。
- `POST /api/datasets/import`：导入 GeoJSON/JSON、Shapefile ZIP 或成套 `.shp/.shx/.dbf/.prj/.cpg` 文件，并自动切换为当前数据集。
- `POST /api/datasets/{id}/activate`：切换当前数据集。
- `GET /api/datasets/{id}`：读取指定数据集和元数据。
- `DELETE /api/datasets/{id}`：删除非当前数据集，至少保留一个数据集。
- `GET /api/layers`：读取当前数据集，供地图显示。
- `POST /api/save`、`POST /api/features`：保存当前数据集或追加要素。
- `PUT /api/features/{id}`、`DELETE /api/features/{id}`：更新或删除当前数据集中的要素。
- `GET /api/export`：导出当前数据集。

导入和保存过程会检查文件大小、要素数量、要素 ID、几何类型、坐标数值和面环闭合情况；缺少 ID 的导入要素会由后端自动生成唯一 ID。Shapefile 导入既支持 ZIP，也支持在文件选择器中同时选择同名的 `.shp/.shx/.dbf/.prj/.cpg` 文件；直接选择成套文件时至少需要 `.shp/.shx/.dbf`，`.prj/.cpg` 为可选。ZIP 会自动忽略 `__MACOSX`、`._*` 等系统隐藏文件；如果 ZIP 中没有 Shapefile 但只有一个 GeoJSON/JSON 文件，也会按 GeoJSON 导入。后端读取 `.shp` 几何、`.dbf` 属性、`.cpg` 编码和 `.prj` 坐标系提示，并统一转换为内部 GeoJSON 数据集；空几何记录会被跳过。当前支持 Point、PolyLine 和 Polygon 三类 Shapefile，单个组件最大 20 MB。

前端的数据文件面板支持查看文件大小、来源格式、几何类型、bbox 和坐标系提示，并可切换或删除非当前数据集。

这部分已经形成“文件导入 → 格式校验/转换 → 元数据登记 → 数据集切换 → 地图读取 → 文件管理”的后端闭环。当前 `.prj` 只做坐标系提示，还没有进行 Albers 等投影到经纬度的坐标转换；下一步可以继续扩展完整的 CRS/EPSG 转换、复杂 Polygon 洞结构和数据库存储。

## 后续扩展建议

1. 引入 GeoPandas/Fiona，覆盖更多 Shapefile 几何类型并支持更完整的 CRS 转换。
2. 用 SQLAlchemy、GeoAlchemy2、psycopg2 连接 PostGIS。
3. 把当前模拟坐标系改成真实 EPSG 坐标系，并加入 pyproj 坐标转换。
4. 为属性表增加字段编辑、新增字段和删除要素。
