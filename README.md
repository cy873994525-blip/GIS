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
- Shapefile 与 PostGIS 留出后续扩展位置

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
3. 使用“点选”或“框选”查看属性；删除操作会先保留在当前编辑状态，点击“保存”后写入 GeoJSON。
4. “全图”会根据当前数据范围自动计算合适的视图。

## A 组：后端文件数据模块（当前实现）

后端现在提供一个轻量的数据集目录。导入的文件会存放在运行时目录 `data/uploads/`，并自动登记文件元数据：

- `GET /api/datasets`：列出数据集、当前激活数据集和要素统计。
- `POST /api/datasets/import`：导入 GeoJSON/JSON 格式的 FeatureCollection，并自动切换为当前数据集。
- `POST /api/datasets/{id}/activate`：切换当前数据集。
- `GET /api/datasets/{id}`：读取指定数据集和元数据。
- `GET /api/layers`：读取当前数据集，供地图显示。
- `POST /api/save`、`POST /api/features`：保存当前数据集或追加要素。
- `GET /api/export`：导出当前数据集。

这部分已经形成“文件导入 → 格式校验 → 元数据登记 → 数据集切换 → 地图读取”的后端闭环。下一步可以继续扩展 Shapefile 解压与 GeoPandas 转换、坐标系识别（EPSG）和数据库存储。

## 后续扩展建议

1. 用 GeoPandas 替换当前的 GeoJSON 文件读写，实现 Shapefile 导入导出。
2. 用 SQLAlchemy、GeoAlchemy2、psycopg2 连接 PostGIS。
3. 把当前模拟坐标系改成真实 EPSG 坐标系，并加入 pyproj 坐标转换。
4. 为属性表增加字段编辑、新增字段和删除要素。
