# GIS 矢量数据编辑与管理 Demo

这是一个用于“GIS 算法与应用”第一次作业展示的最小可运行版本。

## 功能

- 图层显示与显隐控制
- 鼠标交互录入点、线、面
- 地图漫游、缩放、全图显示
- 点选、框选与属性表查看
- Python 后端保存 GeoJSON
- GeoJSON 导出
- Shapefile 与 PostGIS 留出后续扩展位置

## 运行

```bash
python server.py 8000
```

然后打开：

```text
http://127.0.0.1:8000
```

## 后续扩展建议

1. 用 GeoPandas 替换当前的 GeoJSON 文件读写，实现 Shapefile 导入导出。
2. 用 SQLAlchemy、GeoAlchemy2、psycopg2 连接 PostGIS。
3. 把当前模拟坐标系改成真实 EPSG 坐标系，并加入 pyproj 坐标转换。
4. 为属性表增加字段编辑、新增字段和删除要素。
