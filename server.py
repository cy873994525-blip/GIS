# =============================================================================
# GIS 矢量数据编辑 Demo —— 后端（A 组 · 陈怡 Chen Yi）
# A 组职责：GeoJSON / Shapefile 文件数据模块与 API 基础框架
# 归属：本文件（后端全部逻辑）由 A 组成员陈怡（Chen Yi）负责实现与维护。
#
# 2026-10-09 完善记录（A 组）：
#   1. 增强 .prj/CRS 识别：区分地理/投影坐标系（GEOGCS/PROJCS），提取规范
#      坐标系名称与 EPSG 编号，数据集元数据新增 crs_kind 字段；
#   2. 补全 Shapefile 几何类型：支持 PointZ/PolyLineZ/PolygonZ/PointM/
#      PolyLineM/PolygonM 并保留 Z 坐标，MultiPoint 给出明确报错；
#   3. Polygon 洞结构保真：按环的包含关系保留内环（洞），输出标准 GeoJSON；
#   4. 配套前端 static/app.js 多边形渲染支持洞环（evenodd 挖空）；
#   5. T1 投影坐标转换：可选依赖 pyproj，导入时自动把投影坐标系要素转换为
#      WGS 84 经纬度（crs/crs_kind/source_note 同步更新，可叠加在线底图），
#      未安装 pyproj 或识别失败时安全降级为平面显示；
#   6. 多图层叠加：/api/layers 支持 ?ids= 合并多个数据集（要素 layer 覆盖为
#      数据集名、保留 dataset_id），配套 .prj/.cpg/.shx/.dbf 单独导入给出
#      明确提示。
# =============================================================================
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import math
import mimetypes
import re
import io
import sys
import struct
import uuid
import zipfile
import base64
from urllib.parse import parse_qs, unquote, urlsplit
from route_api import handle_routing_request

# 兼容层：str.removeprefix / str.removesuffix 是 Python 3.9 才有的，
# 本机与部分演示环境只有 3.8（本机为 3.8.8），直接用会让
# 「数据集切换 / 删除 / 单数据集查询」三个接口 500。
# 下面两个函数是等价实现，在 3.9+ 上行为完全一致。
def remove_prefix(text, prefix):
    return text[len(prefix):] if text.startswith(prefix) else text


def remove_suffix(text, suffix):
    if suffix and text.endswith(suffix):
        return text[: -len(suffix)]
    return text


# pyproj 为可选依赖：安装后导入投影 Shapefile 时会自动把投影坐标转换为
# WGS 84 经纬度，从而可以叠加在线底图；未安装时保持平面坐标显示。
try:
    from pyproj import Transformer

    HAS_PYPROJ = True
except ImportError:  # pragma: no cover - 未安装 pyproj 的环境
    HAS_PYPROJ = False


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "features.geojson"
UPLOAD_DIR = DATA_DIR / "uploads"
CATALOG_FILE = DATA_DIR / "catalog.json"
ACTIVE_DATASET_FILE = DATA_DIR / "active_dataset.json"
MAX_IMPORT_BYTES = 20 * 1024 * 1024
MAX_FEATURES = 10000
MAX_ZIP_MEMBERS = 32
MAX_REQUEST_BYTES = 32 * 1024 * 1024


SAMPLE_DATA = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "id": "pt-campus-gate",
            "properties": {"name": "校园入口", "layer": "兴趣点", "kind": "point"},
            "geometry": {"type": "Point", "coordinates": [180, 760]},
        },
        {
            "type": "Feature",
            "id": "ln-main-road",
            "properties": {"name": "主干道", "layer": "道路", "kind": "line"},
            "geometry": {
                "type": "LineString",
                "coordinates": [[90, 640], [260, 610], [430, 580], [720, 520], [910, 460]],
            },
        },
        {
            "type": "Feature",
            "id": "pg-lake",
            "properties": {"name": "中心湖", "layer": "水域", "kind": "polygon"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [[430, 720], [610, 690], [680, 800], [600, 910], [420, 880], [360, 790], [430, 720]]
                ],
            },
        },
        {
            "type": "Feature",
            "id": "pg-teaching-area",
            "properties": {"name": "教学区", "layer": "功能区", "kind": "polygon"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [[150, 180], [430, 150], [490, 330], [390, 480], [160, 440], [90, 260], [150, 180]]
                ],
            },
        },
    ],
}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def infer_field_types(payload):
    """扫描要素属性，推断每字段类型：boolean / number / text（与 C 组 field_types 命名一致）。

    全部布尔 → boolean；全部数值（int/float，非 bool）→ number；否则 → text。
    None 值不参与判定；无属性或空数据集返回 {}。
    """
    fields = {}
    for feature in payload.get("features", []):
        for name, value in (feature.get("properties") or {}).items():
            if value is None:
                continue
            if name not in fields:
                fields[name] = None  # None 表示尚未确定
            current = fields[name]
            if current == "text":
                continue
            if isinstance(value, bool):
                inferred = "boolean"
            elif isinstance(value, (int, float)):
                inferred = "number"
            else:
                inferred = "text"
            if current is None:
                fields[name] = inferred
            elif current != inferred:
                fields[name] = "text"
    return {name: kind for name, kind in fields.items() if kind is not None}


def field_value_matches_type(value, kind):
    if value is None:
        return True
    if kind == "text":
        return isinstance(value, str)
    if kind == "number":
        return type(value) in (int, float) and (
            not isinstance(value, float) or math.isfinite(value)
        )
    return isinstance(value, bool)


def validate_feature_collection(payload):
    if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection":
        raise ValueError("payload must be a GeoJSON FeatureCollection")
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError("features must be a list")
    if len(features) > MAX_FEATURES:
        raise ValueError(f"feature count cannot exceed {MAX_FEATURES}")
    field_types = payload.get("field_types", {})
    if not isinstance(field_types, dict) or any(
        not isinstance(name, str) or not name or kind not in {"text", "number", "boolean"}
        for name, kind in field_types.items()
    ):
        raise ValueError("field_types must map field names to text, number or boolean")
    field_defaults = payload.get("field_defaults", {})
    if not isinstance(field_defaults, dict) or any(name not in field_types for name in field_defaults):
        raise ValueError("field_defaults must refer to declared field_types")
    for name, value in field_defaults.items():
        kind = field_types[name]
        if not field_value_matches_type(value, kind):
            raise ValueError(f"default for field {name} must be {kind}")
    for feature in features:
        validate_feature(feature)
        properties = feature.get("properties", {})
        for name, kind in field_types.items():
            if name not in properties or properties[name] is None:
                continue
            value = properties[name]
            if not field_value_matches_type(value, kind):
                raise ValueError(f"field {name} must contain {kind} values")
    return payload


def validate_feature(feature):
    if not isinstance(feature, dict) or feature.get("type") != "Feature":
        raise ValueError("feature must be a GeoJSON Feature")
    if not feature.get("id"):
        raise ValueError("feature must include id")
    if not isinstance(feature.get("geometry"), dict):
        raise ValueError("feature must include geometry")
    if not isinstance(feature.get("properties", {}), dict):
        raise ValueError("feature properties must be an object")
    geometry_type = feature["geometry"].get("type")
    if geometry_type not in {
        "Point",
        "MultiPoint",
        "LineString",
        "Polygon",
        "MultiLineString",
        "MultiPolygon",
    }:
        raise ValueError("unsupported geometry type")
    validate_geometry_coordinates(geometry_type, feature["geometry"].get("coordinates"))
    return feature


def validate_position(position):
    if (
        not isinstance(position, list)
        or len(position) < 2
        or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in position[:2])
    ):
        raise ValueError("coordinates must contain finite numeric positions")


def validate_geometry_coordinates(geometry_type, coordinates):
    if geometry_type == "MultiPolygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError("MultiPolygon must contain polygon parts")
        for polygon in coordinates:
            validate_geometry_coordinates("Polygon", polygon)
        return
    if geometry_type == "Point":
        validate_position(coordinates)
        return
    if geometry_type == "MultiPoint":
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError("MultiPoint must contain at least one position")
        for position in coordinates:
            validate_position(position)
        return
    if geometry_type == "LineString":
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            raise ValueError("LineString must contain at least two positions")
        for position in coordinates:
            validate_position(position)
        return
    if geometry_type == "MultiLineString":
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError("MultiLineString must contain line parts")
        for line in coordinates:
            validate_geometry_coordinates("LineString", line)
        return
    if geometry_type == "Polygon":
        if (
            not isinstance(coordinates, list)
            or not coordinates
            or any(not isinstance(ring, list) or len(ring) < 4 for ring in coordinates)
        ):
            raise ValueError("Polygon must contain rings with at least four positions")
        for ring in coordinates:
            for position in ring:
                validate_position(position)
            if ring[0][:2] != ring[-1][:2]:
                raise ValueError("Polygon rings must be closed")
        return
    raise ValueError("unsupported geometry type")


def normalise_feature_collection(payload):
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError("features must be a list")
    seen_ids = set()
    for feature in features:
        if not isinstance(feature, dict):
            raise ValueError("each item in features must be a GeoJSON Feature")
        feature.setdefault("id", f"ft-{uuid.uuid4().hex[:10]}")
        while feature["id"] in seen_ids:
            feature["id"] = f"ft-{uuid.uuid4().hex[:10]}"
        feature.setdefault("properties", {})
        seen_ids.add(feature["id"])
    validate_feature_collection(payload)
    return payload


def iter_positions(value):
    if isinstance(value, list):
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            yield value
            return
        for child in value:
            yield from iter_positions(child)


def calculate_bbox(payload):
    positions = []
    for feature in payload.get("features", []):
        geometry = feature.get("geometry") or {}
        positions.extend(iter_positions(geometry.get("coordinates", [])))
    if not positions:
        return None
    return [
        min(position[0] for position in positions),
        min(position[1] for position in positions),
        max(position[0] for position in positions),
        max(position[1] for position in positions),
    ]


def dataset_summary(
    dataset_id,
    file_name,
    payload,
    size_bytes,
    path_name,
    created_at=None,
    source_format="GeoJSON",
    crs_name=None,
    source_note=None,
    crs_kind="unknown",
):
    validate_feature_collection(payload)
    geometry_types = sorted(
        {
            feature.get("geometry", {}).get("type", "Unknown")
            for feature in payload.get("features", [])
        }
    )
    return {
        "id": dataset_id,
        "name": Path(file_name).stem or "未命名数据",
        "file_name": file_name,
        "format": source_format,
        "feature_count": len(payload.get("features", [])),
        "geometry_types": geometry_types,
        "bbox": calculate_bbox(payload),
        "size_bytes": size_bytes,
        "created_at": created_at or utc_now(),
        "path": path_name,
        "crs": crs_name or "Unknown",
        "crs_kind": crs_kind,
        "field_types": infer_field_types(payload),
        "source_note": source_note or "坐标系未提供",
    }


def decode_dbf_value(raw_value, field_type, encoding="utf-8"):
    text_bytes = raw_value.rstrip(b" \x00")
    try:
        text = text_bytes.decode(encoding).strip()
    except UnicodeDecodeError:
        text = text_bytes.decode("gbk", errors="replace").strip()
    if not text:
        return None
    if field_type in {"N", "F"}:
        try:
            return float(text) if "." in text else int(text)
        except ValueError:
            return text
    if field_type == "L":
        return text.upper() in {"Y", "T", "1"}
    return text


def read_cpg_encoding(cpg_bytes):
    label = cpg_bytes.decode("ascii", errors="ignore").strip().lower()
    aliases = {
        "utf-8": "utf-8",
        "utf8": "utf-8",
        "65001": "utf-8",
        "gbk": "gbk",
        "936": "gbk",
        "gb2312": "gbk",
    }
    return aliases.get(label, "utf-8")


def read_dbf_records(dbf_bytes, encoding="utf-8"):
    if len(dbf_bytes) < 33:
        raise ValueError("DBF file is too short")
    record_count = struct.unpack_from("<I", dbf_bytes, 4)[0]
    header_length = struct.unpack_from("<H", dbf_bytes, 8)[0]
    record_length = struct.unpack_from("<H", dbf_bytes, 10)[0]
    fields = []
    offset = 32
    while offset + 32 <= header_length and dbf_bytes[offset] != 0x0D:
        descriptor = dbf_bytes[offset : offset + 32]
        field_name = descriptor[:11].split(b"\x00", 1)[0].decode(encoding, errors="replace")
        fields.append((field_name or f"field_{len(fields) + 1}", chr(descriptor[11]), descriptor[16]))
        offset += 32
    if record_length < 1:
        raise ValueError("DBF record length is invalid")

    records = []
    for index in range(record_count):
        start = header_length + index * record_length
        record = dbf_bytes[start : start + record_length]
        if len(record) != record_length:
            raise ValueError("DBF records are truncated")
        if record[:1] == b"*":
            records.append(None)
            continue
        cursor = 1
        properties = {}
        for name, field_type, field_length in fields:
            properties[name] = decode_dbf_value(
                record[cursor : cursor + field_length],
                field_type,
                encoding,
            )
            cursor += field_length
        records.append(properties)
    return records


# ---------------------------------------------------------------------------
# .prj / CRS 识别
# ---------------------------------------------------------------------------
# 常见地理坐标系（GEOGCS）的地图基准名称，用于把 .prj 里的 DATUM 名称翻译成
# 便于展示的规范名称。
GEOGCS_ALIASES = {
    "WGS_1984": "WGS 84",
    "WGS84": "WGS 84",
    "D_WGS_1984": "WGS 84",
    "D_WGS84": "WGS 84",
    "D_Beijing_1954": "Beijing 1954",
    "Beijing_1954": "Beijing 1954",
    "D_Xian_1980": "Xian 1980",
    "Xian_1980": "Xian 1980",
    "D_China_2000": "CGCS2000",
    "China_2000": "CGCS2000",
    "D_North_American_1983": "North American Datum 1983",
    "NAD83": "North American Datum 1983",
    "D_North_American_1927": "North American Datum 1927",
    "D_ETRS_1989": "ETRS89",
    "D_OSGB_1936": "OSGB 1936",
}


def parse_prj_crs(wkt):
    """解析 .prj 的 WKT 文本，返回 (crs_name, crs_kind, epsg)。

    crs_kind 取值为 "geographic"（经纬度）、"projected"（投影坐标）或
    "unknown"。crs_name 尽量给出规范名称；epsg 为可选的 AUTHORITY 编号。
    """
    if not wkt:
        return "Unknown", "unknown", None
    compact = "".join(wkt.split())
    epsg = None
    epsg_match = re.search(r'AUTHORITY\["EPSG"\s*,\s*"(\d+)"\]', compact)
    if epsg_match:
        epsg = epsg_match.group(1)

    kind = "unknown"
    if "PROJCS" in compact:
        kind = "projected"
    elif "GEOGCS" in compact:
        kind = "geographic"

    # 主名称与内部基准：在保留空格的原始 WKT 上匹配（坐标系名称常含空格，
    # 如 "WGS 84"；compact 只用于关键字判断与 EPSG 提取）。
    name = None
    name_match = re.match(r'^(?:PROJCS|GEOGCS)\s*\[\s*"([^"]+)"', wkt)
    if name_match:
        name = name_match.group(1)

    datum = None
    for pattern in (r'GEOGCS\s*\[\s*"([^"]+)"', r'DATUM\s*\[\s*"([^"]+)"'):
        datum_match = re.search(pattern, wkt)
        if datum_match:
            datum = datum_match.group(1)
    if datum:
        datum = GEOGCS_ALIASES.get(datum, datum)

    if not name and datum:
        name = datum
    if epsg and name and epsg not in name:
        name = f"{name} (EPSG:{epsg})"
    elif epsg and not name:
        name = f"EPSG:{epsg}"
    return (name or "Unknown"), kind, epsg


def extract_epsg_from_label(label):
    """从坐标系名称（如 “CGCS2000 … (EPSG:4540)”）里提取 EPSG 编号，无则返回 None。"""
    if not label:
        return None
    match = re.search(r"EPSG[:_]?(\d+)", label)
    return match.group(1) if match else None


def build_projection_transformer(crs_wkt, epsg):
    """构造 源投影坐标系 → WGS 84(EPSG:4326) 的转换器。

    优先使用 .prj 的原始 WKT（忠实于文件里的投影参数），WKT 不可用时退回
    EPSG 编号。返回 (transformer, source) 或 (None, None)。
    """
    source = None
    if crs_wkt and "PROJCS" in crs_wkt:
        source = crs_wkt
    elif epsg:
        source = f"EPSG:{epsg}"
    if not source or not HAS_PYPROJ:
        return None, None
    try:
        transformer = Transformer.from_crs(source, "EPSG:4326", always_xy=True)
    except Exception:
        return None, None
    return transformer, source


def transform_position(position, transformer):
    x, y = position[0], position[1]
    try:
        lon, lat = transformer.transform(x, y)
    except Exception:
        return position
    if not (math.isfinite(lon) and math.isfinite(lat)):
        return position  # 超出投影有效范围的点保留原值
    result = [lon, lat]
    if len(position) > 2:
        result.extend(position[2:])  # 保留 Z 等附加维度
    return result


def transform_coordinates(coordinates, transformer):
    """递归转换 GeoJSON coordinates（点 / 线 / 面 / 多面共用）。"""
    if (
        isinstance(coordinates, list)
        and len(coordinates) >= 2
        and all(isinstance(item, (int, float)) for item in coordinates[:2])
    ):
        return transform_position(coordinates, transformer)
    if isinstance(coordinates, list):
        return [transform_coordinates(child, transformer) for child in coordinates]
    return coordinates


def project_geojson_to_wgs84(payload, crs_wkt, epsg, source_desc):
    """把投影坐标系的要素集合统一转换到 WGS 84 经纬度。

    成功返回 (converted_payload, crs_label)，其中 crs_label 形如
    “WGS 84（已从 … 投影坐标转换）”；转换不可用或失败返回 (None, None)。
    """
    if not HAS_PYPROJ:
        return None, None
    transformer, _source = build_projection_transformer(crs_wkt, epsg)
    if transformer is None:
        return None, None
    try:
        for feature in payload.get("features", []):
            geometry = feature.get("geometry") or {}
            if isinstance(geometry.get("coordinates"), list):
                geometry["coordinates"] = transform_coordinates(geometry["coordinates"], transformer)
    except Exception:
        return None, None
    source_label = source_desc or "投影坐标"
    return payload, f"WGS 84（已从 {source_label} 投影坐标转换）"


# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Shapefile 几何类型
# ---------------------------------------------------------------------------
# record_type / 声明类型 → 基础 GeoJSON 几何类型。Z 变体（11/13/15）额外携带
# 第三维 Z，M 变体（21/23/25）的 measure 值在 GeoJSON 中没有对应语义，忽略。
SHAPE_BASE_TYPE = {
    1: "Point",
    3: "LineString",
    5: "Polygon",
    8: "MultiPoint",
    11: "Point",
    13: "LineString",
    15: "Polygon",
    18: "MultiPoint",
    21: "Point",
    23: "LineString",
    25: "Polygon",
    28: "MultiPoint",
}
SUPPORTED_SHAPE_TYPES = set(SHAPE_BASE_TYPE)


def ring_signed_area(ring):
    """鞋带公式计算环的有符号面积；绝对值为面积，符号指示环绕方向。"""
    area = 0.0
    n = len(ring)
    for index in range(n):
        x1, y1 = ring[index][0], ring[index][1]
        x2, y2 = ring[(index + 1) % n][0], ring[(index + 1) % n][1]
        area += x1 * y2 - x2 * y1
    return area / 2.0


def point_in_ring(point, ring):
    """射线法判断点是否在（闭合）环内部。"""
    x, y = point[0], point[1]
    inside = False
    n = len(ring)
    for index in range(n):
        x1, y1 = ring[index][0], ring[index][1]
        x2, y2 = ring[(index + 1) % n][0], ring[(index + 1) % n][1]
        if (y1 > y) != (y2 > y):
            hit_x = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < hit_x:
                inside = not inside
    return inside


def _polygon_from_rings(rings):
    """把一组闭合环组装成标准 GeoJSON Polygon/MultiPolygon，保留洞（内环）。

    Shapefile 一个 Polygon 记录里的多个 parts，既可能是外环+洞环（内环），
    也可能是多个相互分离的外环。这里按「环的包含关系」还原：面积最大的环
    作为外环，被外环包含的较小环作为该外环的洞。这样导入后洞结构不再被
    扁平化成独立多边形，前端可正确挖空显示。
    """
    if not rings:
        raise ValueError("polygon geometry requires at least one ring")
    ordered = sorted(rings, key=lambda ring: -abs(ring_signed_area(ring)))
    polygons = []  # 每个元素: {"outer": 外环, "holes": [洞环, ...]}
    for ring in ordered:
        sample = ring[0]
        target = None
        for poly in polygons:
            if point_in_ring(sample, poly["outer"]):
                if target is None or abs(ring_signed_area(poly["outer"])) < abs(
                    ring_signed_area(target["outer"])
                ):
                    target = poly
        if target is None:
            polygons.append({"outer": ring, "holes": []})
        else:
            target["holes"].append(ring)
    if len(polygons) == 1:
        poly = polygons[0]
        return {"type": "Polygon", "coordinates": [poly["outer"]] + poly["holes"]}
    return {
        "type": "MultiPolygon",
        "coordinates": [[poly["outer"]] + poly["holes"] for poly in polygons],
    }


def split_shape_parts(parts, points):
    result = []
    for index, start in enumerate(parts):
        end = parts[index + 1] if index + 1 < len(parts) else len(points)
        # list(point) 会保留 [x, y] 或 [x, y, z] 的完整坐标（Z 类型时）。
        result.append([list(point) for point in points[start:end]])
    return result


def read_shp_records(shp_bytes):
    if len(shp_bytes) < 100:
        raise ValueError("SHP file is too short")
    declared_type = struct.unpack_from("<i", shp_bytes, 32)[0]
    if declared_type not in SUPPORTED_SHAPE_TYPES:
        raise ValueError(f"unsupported Shapefile geometry type: {declared_type}")
    features = []
    offset = 100
    while offset < len(shp_bytes):
        if offset + 8 > len(shp_bytes):
            raise ValueError("SHP record header is truncated")
        record_number, content_words = struct.unpack_from(">ii", shp_bytes, offset)
        content_start = offset + 8
        content_end = content_start + content_words * 2
        if content_end > len(shp_bytes):
            raise ValueError(f"SHP record {record_number} is truncated")
        record_type = struct.unpack_from("<i", shp_bytes, content_start)[0]
        if record_type == 0:
            features.append(None)
            offset = content_end
            continue
        if record_type not in SUPPORTED_SHAPE_TYPES:
            raise ValueError(f"unsupported Shapefile geometry type: {record_type}")
        has_z = record_type in {11, 13, 15, 18}
        if record_type in {1, 11, 21}:
            # Point / PointZ / PointM
            x, y = struct.unpack_from("<dd", shp_bytes, content_start + 4)
            coordinates = [x, y]
            if has_z:
                if content_start + 28 > content_end:
                    raise ValueError(f"SHP record {record_number} is truncated")
                z, = struct.unpack_from("<d", shp_bytes, content_start + 20)
                coordinates.append(z)
            geometry = {"type": "Point", "coordinates": coordinates}
        elif record_type in {8, 18, 28}:
            # MultiPoint / MultiPointZ / MultiPointM：box + numPoints + points
            if content_start + 40 > content_end:
                raise ValueError(f"SHP record {record_number} has an invalid header")
            num_points, = struct.unpack_from("<i", shp_bytes, content_start + 36)
            points_offset = content_start + 40
            expected_end = points_offset + num_points * 16
            if expected_end > content_end:
                raise ValueError(f"SHP record {record_number} coordinate data is truncated")
            points = [
                list(struct.unpack_from("<dd", shp_bytes, points_offset + index * 16))
                for index in range(num_points)
            ]
            if has_z:
                z_array_start = expected_end + 16  # 跳过 zmin/zmax
                z_array_end = z_array_start + num_points * 8
                if z_array_end > content_end:
                    raise ValueError(f"SHP record {record_number} Z data is truncated")
                z_values = [
                    struct.unpack_from("<d", shp_bytes, z_array_start + index * 8)[0]
                    for index in range(num_points)
                ]
                points = [point + [z] for point, z in zip(points, z_values)]
            geometry = {"type": "MultiPoint", "coordinates": points}
        elif record_type in {3, 5, 13, 15, 23, 25}:
            # PolyLine / Polygon（及 Z/M 变体）：几何头布局相同，
            # Z 类型的 Z 数组位于点数组之后。
            if content_start + 44 > content_end:
                raise ValueError(f"SHP record {record_number} has an invalid header")
            part_count, point_count = struct.unpack_from("<ii", shp_bytes, content_start + 36)
            if part_count == 0 and point_count == 0:
                features.append(None)
                offset = content_end
                continue
            if part_count < 1 or point_count < 2:
                raise ValueError(f"SHP record {record_number} has invalid coordinates")
            parts_offset = content_start + 44
            points_offset = parts_offset + part_count * 4
            expected_end = points_offset + point_count * 16
            if expected_end > content_end:
                raise ValueError(f"SHP record {record_number} coordinate data is truncated")
            parts = list(struct.unpack_from(f"<{part_count}i", shp_bytes, parts_offset))
            points = [
                struct.unpack_from("<dd", shp_bytes, points_offset + point_index * 16)
                for point_index in range(point_count)
            ]
            if has_z:
                z_array_start = expected_end + 16  # 跳过 zmin/zmax
                z_array_end = z_array_start + point_count * 8
                if z_array_end > content_end:
                    raise ValueError(f"SHP record {record_number} Z data is truncated")
                z_values = [
                    struct.unpack_from("<d", shp_bytes, z_array_start + point_index * 8)[0]
                    for point_index in range(point_count)
                ]
                points = [(x, y, z) for (x, y), z in zip(points, z_values)]
            components = split_shape_parts(parts, points)
            if SHAPE_BASE_TYPE[record_type] == "LineString":
                geometry = {
                    "type": "LineString" if len(components) == 1 else "MultiLineString",
                    "coordinates": components[0] if len(components) == 1 else components,
                }
            else:
                rings = [ring for ring in components if len(ring) >= 4]
                if not rings:
                    raise ValueError(f"SHP record {record_number} has no valid polygon rings")
                for ring in rings:
                    if ring[0] != ring[-1]:
                        ring.append(ring[0][:])
                # 先按环的闭合形状组装几何；洞结构（内环）由 build_polygon_geometry
                # 在 Polygon 层面进一步处理。
                geometry = _polygon_from_rings(rings)
        else:
            raise ValueError(f"unsupported Shapefile geometry type: {record_type}")
        features.append({"type": "Feature", "geometry": geometry, "properties": {}})
        offset = content_end
    return declared_type, features


def is_usable_archive_member(item):
    path = Path(item.filename)
    parts = {part.lower() for part in path.parts}
    return (
        not item.is_dir()
        and path.name.lower() not in {".ds_store"}
        and not path.name.startswith("._")
        and "__macosx" not in parts
    )


def convert_shapefile_zip(file_name, zip_bytes):
    if not zipfile.is_zipfile(io.BytesIO(zip_bytes)):
        raise ValueError("invalid ZIP archive")
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        members = [item for item in archive.infolist() if is_usable_archive_member(item)]
        if len(members) > MAX_ZIP_MEMBERS:
            raise ValueError(f"Shapefile ZIP cannot contain more than {MAX_ZIP_MEMBERS} files")
        if any(item.file_size > MAX_IMPORT_BYTES for item in members):
            raise ValueError(f"an extracted Shapefile component exceeds the {MAX_IMPORT_BYTES // (1024 * 1024)} MB limit")
        shp_files = [item for item in members if Path(item.filename).suffix.lower() == ".shp"]
        if not shp_files:
            geojson_files = [
                item
                for item in members
                if Path(item.filename).suffix.lower() in {".geojson", ".json"}
            ]
            if len(geojson_files) == 1:
                try:
                    payload = json.loads(archive.read(geojson_files[0]).decode("utf-8-sig"))
                    return (
                        normalise_feature_collection(payload),
                        None,
                        Path(geojson_files[0].filename).name,
                        "GeoJSON",
                    )
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ValueError("ZIP 内的 GeoJSON/JSON 文件无法读取") from exc
            if len(geojson_files) > 1:
                raise ValueError("ZIP 中包含多个 GeoJSON/JSON 文件，请只保留一个数据文件")
            raise ValueError("ZIP 中没有找到 .shp 文件；请压缩同名的 .shp/.dbf/.prj 文件")
        if len(shp_files) != 1:
            raise ValueError("ZIP 中必须只包含一个 Shapefile 图层（一个 .shp 文件）")
        shp_item = shp_files[0]
        stem = Path(shp_item.filename).stem.lower()
        matching = {
            Path(item.filename).suffix.lower(): item
            for item in members
            if Path(item.filename).stem.lower() == stem
        }
        shp_type, raw_features = read_shp_records(archive.read(shp_item))
        if shp_type not in SUPPORTED_SHAPE_TYPES:
            raise ValueError("this demo supports Point, PolyLine, and Polygon Shapefiles (incl. Z/M)")
        dbf_encoding = "utf-8"
        if matching.get(".cpg"):
            dbf_encoding = read_cpg_encoding(archive.read(matching[".cpg"]))
        if matching.get(".dbf"):
            dbf_records = read_dbf_records(archive.read(matching[".dbf"]), dbf_encoding)
            if len(dbf_records) != len(raw_features):
                raise ValueError("DBF record count does not match SHP feature count")
            for feature, properties in zip(raw_features, dbf_records):
                if feature is not None:
                    feature["properties"] = properties or {}

        features = [feature for feature in raw_features if feature is not None]
        payload = normalise_feature_collection({"type": "FeatureCollection", "features": features})
        prj_item = matching.get(".prj")
        crs_name = None
        crs_kind = "unknown"
        crs_wkt = None
        if prj_item:
            crs_wkt = archive.read(prj_item).decode("utf-8", errors="replace")
            crs_name, crs_kind, _epsg = parse_prj_crs(crs_wkt)
        return payload, crs_name, Path(shp_item.filename).name, "Shapefile", crs_kind, crs_wkt


def convert_shapefile_parts(file_name, main_bytes, sidecars):
    base_name = Path(file_name).stem.lower()
    files = {Path(name).suffix.lower(): content for name, content in sidecars.items()}
    files[".shp"] = main_bytes
    if ".shx" not in files or ".dbf" not in files:
        raise ValueError("Shapefile import requires matching .shx and .dbf files")
    shape_type, raw_features = read_shp_records(main_bytes)
    if shape_type not in SUPPORTED_SHAPE_TYPES:
        raise ValueError("this demo supports Point, PolyLine, and Polygon Shapefiles (incl. Z/M)")
    encoding = read_cpg_encoding(files[".cpg"]) if ".cpg" in files else "utf-8"
    dbf_records = read_dbf_records(files[".dbf"], encoding)
    if len(dbf_records) != len(raw_features):
        raise ValueError("DBF record count does not match SHP feature count")
    for feature, properties in zip(raw_features, dbf_records):
        if feature is not None:
            feature["properties"] = properties or {}
    features = [feature for feature in raw_features if feature is not None]
    payload = normalise_feature_collection({"type": "FeatureCollection", "features": features})
    crs_name = None
    crs_kind = "unknown"
    crs_wkt = None
    if ".prj" in files:
        crs_wkt = files[".prj"].decode("utf-8", errors="replace")
        crs_name, crs_kind, _epsg = parse_prj_crs(crs_wkt)
    return payload, crs_name, f"{base_name}.shp", crs_kind, crs_wkt


# ---------------------------------------------------------------------------
# Shapefile 导出（GeoJSON → .shp/.shx/.dbf/.prj 打包 ZIP）
# ---------------------------------------------------------------------------
# 仅依赖 Python 标准库。支持 Point(1)、PolyLine(3)、Polygon(5)、MultiPoint(8)，
# 坐标取前两维（忽略 Z）。属性写入 dBase III（.dbf），字符字段按 UTF-8 编码
# 并附带 .cpg=UTF-8，可被本模块的 read_dbf_records 读回（roundtrip）。
SHAPE_EXPORT_TYPES = {1: "Point", 3: "PolyLine", 5: "Polygon", 8: "MultiPoint"}
PRJ_WGS84_WKT = (
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
    'SPHEROID["WGS_1984",6378137.0,298.257223563]],'
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
)


def _feature_base_kind(geometry):
    """返回要素几何的导出基类：Point / MultiPoint / Line / Polygon。"""
    geom_type = (geometry or {}).get("type")
    if geom_type == "Point":
        return "Point"
    if geom_type == "MultiPoint":
        return "MultiPoint"
    if geom_type in {"LineString", "MultiLineString"}:
        return "Line"
    if geom_type in {"Polygon", "MultiPolygon"}:
        return "Polygon"
    raise ValueError(f"不支持导出的几何类型: {geom_type}")


def _walk_xy(coordinates):
    """递归产出所有 (x, y) 坐标对（只取前两维）。"""
    if (
        isinstance(coordinates, list)
        and len(coordinates) >= 2
        and all(isinstance(item, (int, float)) for item in coordinates[:2])
    ):
        yield (coordinates[0], coordinates[1])
    elif isinstance(coordinates, list):
        for child in coordinates:
            yield from _walk_xy(child)


def _bbox_of_payload(payload):
    xs, ys = [], []
    for feature in payload.get("features", []):
        for x, y in _walk_xy((feature.get("geometry") or {}).get("coordinates")):
            xs.append(x)
            ys.append(y)
    if not xs:
        return (0.0, 0.0, 0.0, 0.0)
    return (min(xs), min(ys), max(xs), max(ys))


def _line_parts_for(geometry):
    """把线/面几何转成 parts 列表（每个 part 是一组 [x, y] 坐标）。"""
    geom_type = geometry["type"]
    coords = geometry["coordinates"]
    if geom_type == "LineString":
        return [[(p[0], p[1]) for p in coords]]
    if geom_type == "MultiLineString":
        return [[(p[0], p[1]) for p in part] for part in coords]
    if geom_type == "Polygon":
        return [[(p[0], p[1]) for p in ring] for ring in coords]
    if geom_type == "MultiPolygon":
        return [
            [(p[0], p[1]) for p in ring]
            for poly in coords
            for ring in poly
        ]
    raise ValueError(f"不支持导出的几何类型: {geom_type}")


def _shapefile_type_for(geoms):
    kinds = {_feature_base_kind(geom) for geom in geoms}
    if len(kinds) > 1:
        raise ValueError("混合几何类型（点/线/面）不能导出为单个 Shapefile 图层；请先按类型拆分数据集")
    kind = kinds.pop() if kinds else "Point"
    return {"Point": 1, "MultiPoint": 8, "Line": 3, "Polygon": 5}[kind]


def _encode_shp_record_content(shp_type, geometry):
    """编码单个 Shapefile 记录内容（含类型号），返回 bytes。"""
    kind = _feature_base_kind(geometry)
    if shp_type == 1:  # Point
        x, y = geometry["coordinates"][0], geometry["coordinates"][1]
        return struct.pack("<idd", 1, x, y)
    if shp_type == 8:  # MultiPoint
        points = [(p[0], p[1]) for p in geometry["coordinates"]]
        if not points:
            return struct.pack("<ii", 8, 0)
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        header = struct.pack("<i4di", 8, min(xs), min(ys), max(xs), max(ys), len(points))
        return header + b"".join(struct.pack("<dd", x, y) for x, y in points)
    if shp_type in (3, 5):  # PolyLine / Polygon
        parts = _line_parts_for(geometry)
        points = [(x, y) for part in parts for x, y in part]
        if not points:
            raise ValueError("线/面要素没有有效坐标")
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        num_parts = len(parts)
        num_points = len(points)
        header = struct.pack(
            "<i4dii",
            shp_type,
            min(xs), min(ys), max(xs), max(ys),
            num_parts,
            num_points,
        )
        parts_bytes = b"".join(struct.pack("<i", index) for index in range(num_parts))
        points_bytes = b"".join(struct.pack("<dd", x, y) for x, y in points)
        return header + parts_bytes + points_bytes
    raise ValueError(f"不支持导出的 Shapefile 类型: {shp_type}")


def _shp_file_bytes(shp_type, records):
    """records: [(geometry, props)]，返回 .shp 与 .shx 字节。"""
    contents = []
    for geometry, _props in records:
        contents.append(_encode_shp_record_content(shp_type, geometry))

    shp_body = bytearray()
    shx_body = bytearray()
    offset_words = 50  # 从文件头之后开始计（shp 记录偏移以 16-bit word 计）
    total_words = 50
    for content in contents:
        content_words = len(content) // 2
        record_number = len(shx_body) // 8 + 1
        shp_body.extend(struct.pack(">ii", record_number, content_words))
        shp_body.extend(content)
        shx_body.extend(struct.pack(">ii", offset_words, content_words))
        offset_words += 4 + content_words
        total_words += 4 + content_words

    shp_header = bytearray(100)
    struct.pack_into(">i", shp_header, 0, 9994)
    struct.pack_into(">i", shp_header, 24, total_words)
    struct.pack_into("<i", shp_header, 28, 1000)
    struct.pack_into("<i", shp_header, 32, shp_type)
    xs, ys = [], []
    for geometry, _props in records:
        for x, y in _walk_xy(geometry["coordinates"]):
            xs.append(x)
            ys.append(y)
    if xs:
        struct.pack_into("<4d", shp_header, 36, min(xs), min(ys), max(xs), max(ys))
    shp_bytes = bytes(shp_header) + bytes(shp_body)

    shx_header = bytearray(100)
    struct.pack_into(">i", shx_header, 0, 9994)
    struct.pack_into(">i", shx_header, 24, 50 + len(shx_body) // 8)
    struct.pack_into("<i", shx_header, 28, 1000)
    struct.pack_into("<i", shx_header, 32, shp_type)
    struct.pack_into("<4d", shx_header, 36, min(xs), min(ys), max(xs), max(ys))
    shx_bytes = bytes(shx_header) + bytes(shx_body)
    return shp_bytes, shx_bytes


def _dbf_field_lengths(values):
    """按值推断 dBase 字段类型与长度。返回 (type_char, length, decimals)。"""
    non_null = [v for v in values if v is not None]
    if not non_null:
        return "C", 1, 0
    if all(isinstance(v, bool) for v in non_null):
        return "L", 1, 0
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in non_null):
        text_lengths = [len(f"{v:g}") for v in non_null]
        decimals = max(
            (len(f"{v:g}".split(".")[1]) if "." in f"{v:g}" else 0) for v in non_null
        )
        return "N", max(1, min(254, max(text_lengths))), decimals
    texts = [str(v) for v in non_null]
    # dBase 字段长度按字节计；中文字符经 UTF-8 编码后占 3 字节，需按字节数计算
    return "C", max(1, min(254, max(len(t.encode("utf-8")) for t in texts))), 0


def _encode_dbf(features):
    """把要素属性写成 dBase III（UTF-8），返回 .dbf 字节。"""
    field_names = []
    for feature in features:
        for name in (feature.get("properties") or {}):
            if name not in field_names:
                field_names.append(name)
    if not field_names:
        field_names = ["name"]
    fields = []  # (原始字段名, dBase类型, 长度, 小数位)
    for name in field_names:
        values = [((feature.get("properties") or {}).get(name)) for feature in features]
        type_char, length, decimals = _dbf_field_lengths(values)
        fields.append((name, type_char, length, decimals))
    record_count = len(features)
    header_length = 32 + 32 * len(fields) + 1
    record_length = 1 + sum(field[2] for field in fields)
    header = bytearray(header_length)
    header[0] = 0x03
    header[1:4] = (2026 & 0xFF, 10, 18)  # 最后更新日期 YY MM DD
    struct.pack_into("<I", header, 4, record_count)
    struct.pack_into("<H", header, 8, header_length)
    struct.pack_into("<H", header, 10, record_length)
    offset = 32
    for name, type_char, length, decimals in fields:
        desc = bytearray(32)
        raw_name = name.encode("utf-8")[:10]
        if not raw_name:
            raw_name = b"f1"
        desc[: len(raw_name)] = raw_name
        desc[11] = ord(type_char)
        desc[16] = length
        desc[17] = decimals
        header[offset : offset + 32] = desc
        offset += 32
    header[offset] = 0x0D
    dbf = bytes(header)
    for feature in features:
        properties = feature.get("properties") or {}
        record = bytearray(record_length)
        record[0] = 0x20
        cursor = 1
        for name, type_char, length, decimals in fields:
            value = properties.get(name)
            slot = record[cursor : cursor + length]
            if type_char == "L":
                slot[0] = 0x54 if value in (True, 1, "1", "true", "T", "t") else 0x46  # T/F
            elif type_char == "N":
                if value is None:
                    slot[:] = b" " * length
                else:
                    text = f"{value:g}".encode("utf-8")
                    slot[length - len(text) :] = text  # 右对齐
            else:
                if value is None:
                    slot[:] = b" " * length
                else:
                    text = str(value).encode("utf-8")
                    slot[: len(text)] = text
            record[cursor : cursor + length] = slot
            cursor += length
        dbf += bytes(record)
    dbf += b"\x1a"
    return dbf


def export_shapefile_zip(payload):
    """把 FeatureCollection 导出为 Shapefile ZIP，返回 zip 字节。"""
    features = [f for f in payload.get("features", []) if f.get("geometry")]
    if not features:
        raise ValueError("没有可导出的要素")
    shp_type = _shapefile_type_for([f["geometry"] for f in features])
    records = [(f["geometry"], f.get("properties") or {}) for f in features]
    shp_bytes, shx_bytes = _shp_file_bytes(shp_type, records)
    dbf_bytes = _encode_dbf(features)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("export.shp", shp_bytes)
        archive.writestr("export.shx", shx_bytes)
        archive.writestr("export.dbf", dbf_bytes)
        archive.writestr("export.prj", PRJ_WGS84_WKT)
        archive.writestr("export.cpg", "UTF-8")
    return buffer.getvalue()


def write_json_atomic(path, payload):
    temp_file = path.with_suffix(".tmp")
    temp_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_file.replace(path)


def ensure_storage():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text(json.dumps(SAMPLE_DATA, ensure_ascii=False, indent=2), encoding="utf-8")

    if not CATALOG_FILE.exists():
        initial_payload = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        initial = dataset_summary(
            "features",
            "features.geojson",
            initial_payload,
            DATA_FILE.stat().st_size,
            "features.geojson",
        )
        write_json_atomic(CATALOG_FILE, {"datasets": [initial]})

    catalog = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    if not catalog.get("datasets"):
        raise ValueError("dataset catalog cannot be empty")
    known_ids = {dataset["id"] for dataset in catalog["datasets"]}
    if not ACTIVE_DATASET_FILE.exists():
        write_json_atomic(ACTIVE_DATASET_FILE, {"active_id": catalog["datasets"][0]["id"]})
        return
    active_id = json.loads(ACTIVE_DATASET_FILE.read_text(encoding="utf-8")).get("active_id")
    if active_id not in known_ids:
        write_json_atomic(ACTIVE_DATASET_FILE, {"active_id": catalog["datasets"][0]["id"]})


def read_catalog():
    ensure_storage()
    catalog = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    # 惰性回填：老记录缺 field_types 时按存储文件重算并写回，之后不再重复读取
    changed = False
    for dataset in catalog.get("datasets", []):
        if "field_types" in dataset:
            continue
        try:
            path = dataset_path(dataset)
            payload = json.loads(path.read_text(encoding="utf-8"))
            dataset["field_types"] = infer_field_types(payload)
            changed = True
        except (KeyError, OSError, ValueError):
            dataset["field_types"] = {}
    if changed:
        write_json_atomic(CATALOG_FILE, catalog)
    return catalog


def write_catalog(catalog):
    write_json_atomic(CATALOG_FILE, catalog)


def get_active_id():
    ensure_storage()
    return json.loads(ACTIVE_DATASET_FILE.read_text(encoding="utf-8"))["active_id"]


def set_active_id(dataset_id):
    write_json_atomic(ACTIVE_DATASET_FILE, {"active_id": dataset_id})


def find_dataset(dataset_id):
    for dataset in read_catalog()["datasets"]:
        if dataset["id"] == dataset_id:
            return dataset
    raise KeyError(f"dataset not found: {dataset_id}")


def dataset_path(dataset):
    path = (DATA_DIR / dataset["path"]).resolve()
    if DATA_DIR.resolve() not in path.parents:
        raise ValueError("invalid dataset storage path")
    return path


def read_dataset(dataset_id=None):
    dataset = find_dataset(dataset_id or get_active_id())
    path = dataset_path(dataset)
    payload = json.loads(path.read_text(encoding="utf-8"))
    validate_feature_collection(payload)
    return dataset, payload


def update_dataset_metadata(dataset_id, payload, file_size=None):
    catalog = read_catalog()
    for index, dataset in enumerate(catalog["datasets"]):
        if dataset["id"] == dataset_id:
            target = dataset_path(dataset)
            catalog["datasets"][index] = dataset_summary(
                dataset_id,
                dataset["file_name"],
                payload,
                file_size if file_size is not None else target.stat().st_size,
                dataset["path"],
                dataset.get("created_at"),
                dataset.get("format", "GeoJSON"),
                dataset.get("crs"),
                dataset.get("source_note"),
            )
            write_catalog(catalog)
            return catalog["datasets"][index]
    raise KeyError(f"dataset not found: {dataset_id}")


def write_geojson(payload, dataset_id=None):
    payload = normalise_feature_collection(payload)
    dataset_id = dataset_id or get_active_id()
    dataset = find_dataset(dataset_id)
    target = dataset_path(dataset)
    write_json_atomic(target, payload)
    update_dataset_metadata(dataset_id, payload, target.stat().st_size)


def read_geojson():
    return read_dataset()[1]


def read_layers(dataset_ids):
    """读取多个数据集并合并为一个图层集合。

    每个要素的 properties.layer 覆盖为所在数据集名称（前端按 layer 分组
    显示/隐藏），并保留 dataset_id 便于溯源。
    """
    features = []
    for dataset_id in dataset_ids:
        dataset, payload = read_dataset(dataset_id)
        layer_name = dataset.get("name") or dataset.get("file_name") or dataset_id
        for feature in payload.get("features", []):
            item = dict(feature)
            props = dict(item.get("properties") or {})
            props["layer"] = layer_name
            props["dataset_id"] = dataset_id
            item["properties"] = props
            features.append(item)
    return {"type": "FeatureCollection", "features": features}


class GisDemoHandler(SimpleHTTPRequestHandler):
    server_version = "GisVectorDemo/0.3"

    def translate_path(self, path):
        clean_path = urlsplit(path).path
        if clean_path == "/":
            return str(STATIC_DIR / "index.html")
        if clean_path.startswith("/static/"):
            requested = (ROOT / clean_path.lstrip("/")).resolve()
            if STATIC_DIR.resolve() not in requested.parents:
                return str(STATIC_DIR / "index.html")
            return str(requested)
        return str(STATIC_DIR / clean_path.lstrip("/"))

    def log_message(self, fmt, *args):
        sys.stderr.write("[gis-demo] " + fmt % args + "\n")

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=400):
        self.send_json({"ok": False, "error": message}, status=status)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_REQUEST_BYTES:
            raise ValueError(f"request body cannot exceed {MAX_REQUEST_BYTES // (1024 * 1024)} MB")
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(raw or "{}")

    def do_GET(self):
        if handle_routing_request(self, "GET"):
            return
        path = urlsplit(self.path).path
        if path == "/api/layers":
            query = parse_qs(urlsplit(self.path).query)
            ids = [item for item in (query.get("ids") or [""])[0].split(",") if item]
            if ids:
                self.send_json(read_layers(ids))
            else:
                self.send_json(read_geojson())
            return

        if path == "/api/export":
            active_dataset, payload = read_dataset()
            query = parse_qs(urlsplit(self.path).query)
            export_format = (query.get("format") or ["geojson"])[0].lower()
            if export_format == "shapefile":
                try:
                    body = export_shapefile_zip(payload)
                except ValueError as exc:
                    self.send_error_json(str(exc))
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{active_dataset["id"]}-shapefile.zip"',
                )
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/geo+json; charset=utf-8")
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{active_dataset["id"]}-export.geojson"',
            )
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/datasets":
            active_id = get_active_id()
            self.send_json(
                {
                    "ok": True,
                    "active_id": active_id,
                    "datasets": [
                        {**dataset, "active": dataset["id"] == active_id}
                        for dataset in read_catalog()["datasets"]
                    ],
                }
            )
            return

        if path.startswith("/api/datasets/"):
            dataset_id = unquote(remove_prefix(path, "/api/datasets/")).strip("/")
            if dataset_id:
                dataset, payload = read_dataset(dataset_id)
                self.send_json({"ok": True, "dataset": dataset, "data": payload})
                return

        if path == "/api/status":
            active_dataset, _ = read_dataset()
            catalog = read_catalog()
            self.send_json(
                {
                    "ok": True,
                    "storage": f"data/{active_dataset['path']}",
                    "backend": "Python http.server",
                    "active_dataset": active_dataset["name"],
                    "dataset_count": len(catalog["datasets"]),
                    "geojson": "已接入",
                    "postgis": "未接入",
                    "shapefile": "已接入（ZIP/成套文件转 GeoJSON）",
                }
            )
            return

        return super().do_GET()

    def do_POST(self):
        if handle_routing_request(self, "POST"):
            return
        path = urlsplit(self.path).path
        try:
            if path == "/api/features":
                payload = self.read_json_body()
                active_id = get_active_id()
                data = read_geojson()
                feature = payload.get("feature")
                if not feature or feature.get("type") != "Feature":
                    self.send_error_json("feature must be a GeoJSON Feature")
                    return
                feature.setdefault("id", f"ft-{uuid.uuid4().hex[:10]}")
                feature.setdefault("properties", {})
                existing_ids = {item.get("id") for item in data["features"]}
                while feature["id"] in existing_ids:
                    feature["id"] = f"ft-{uuid.uuid4().hex[:10]}"
                validate_feature(feature)
                data["features"].append(feature)
                write_geojson(data, active_id)
                self.send_json({"ok": True, "feature": feature})
                return

            if path == "/api/save":
                payload = self.read_json_body()
                write_geojson(payload, get_active_id())
                self.send_json({"ok": True, "count": len(payload.get("features", []))})
                return

            if path == "/api/reset":
                set_active_id("features")
                write_geojson(SAMPLE_DATA, "features")
                self.send_json({"ok": True, "data": SAMPLE_DATA})
                return

            if path == "/api/datasets/import":
                payload = self.read_json_body()
                raw_content = payload.get("content")
                original_name = Path(str(payload.get("file_name") or "imported.geojson")).name
                suffix = Path(original_name).suffix.lower()
                source_format = "GeoJSON"
                crs_name = None
                crs_kind = "unknown"
                crs_wkt = None
                source_note = "JSON 文件直接存储"
                if suffix == ".zip":
                    try:
                        zip_bytes = base64.b64decode(str(raw_content), validate=True)
                    except Exception as exc:
                        raise ValueError("invalid base64 Shapefile ZIP content") from exc
                    if len(zip_bytes) > MAX_IMPORT_BYTES:
                        raise ValueError(f"Shapefile ZIP cannot exceed {MAX_IMPORT_BYTES // (1024 * 1024)} MB")
                    geojson, crs_name, source_name, source_format, crs_kind, crs_wkt = convert_shapefile_zip(
                        original_name, zip_bytes
                    )
                    source_note = f"从 ZIP 内的 {source_name} 读取并转换为 GeoJSON"
                elif suffix == ".shp":
                    try:
                        main_bytes = base64.b64decode(str(raw_content), validate=True)
                        if len(main_bytes) > MAX_IMPORT_BYTES:
                            raise ValueError(
                                f"Shapefile component cannot exceed {MAX_IMPORT_BYTES // (1024 * 1024)} MB"
                            )
                        sidecar_payload = payload.get("sidecars") or []
                        sidecars = {}
                        for item in sidecar_payload:
                            sidecar_name = Path(str(item.get("file_name", ""))).name
                            sidecar_content = base64.b64decode(str(item.get("content", "")), validate=True)
                            if len(sidecar_content) > MAX_IMPORT_BYTES:
                                raise ValueError(
                                    f"Shapefile component cannot exceed {MAX_IMPORT_BYTES // (1024 * 1024)} MB"
                                )
                            sidecars[sidecar_name] = sidecar_content
                        geojson, crs_name, shp_name, crs_kind, crs_wkt = convert_shapefile_parts(
                            original_name,
                            main_bytes,
                            sidecars,
                        )
                    except (KeyError, TypeError, ValueError) as exc:
                        raise ValueError(f"invalid Shapefile component upload: {exc}") from exc
                    source_format = "Shapefile"
                    source_note = f"从 {shp_name} 转换为 GeoJSON"
                else:
                    if suffix in {".prj", ".cpg", ".shx", ".dbf"}:
                        raise ValueError(
                            f"{suffix} 是 Shapefile 配套文件，不能单独导入；"
                            "请与同名的 .shp/.shx/.dbf 成套上传（.prj/.cpg 可选）"
                        )
                    if suffix not in {".geojson", ".json"}:
                        raise ValueError("only .geojson, .json, or Shapefile .zip files are supported")
                    geojson = json.loads(raw_content) if isinstance(raw_content, str) else raw_content
                    geojson = normalise_feature_collection(geojson)

                if crs_kind == "projected":
                    converted, converted_crs = project_geojson_to_wgs84(
                        geojson,
                        crs_wkt,
                        extract_epsg_from_label(crs_name),
                        crs_name,
                    )
                    if converted is not None:
                        geojson = converted
                        crs_kind = "geographic"
                        crs_name = converted_crs
                        source_note = (
                            f"{source_note}；已从投影坐标自动转换为 WGS 84 经纬度，可叠加在线底图"
                        )
                    else:
                        source_note = (
                            f"{source_note}；检测为投影坐标系，但自动转换不可用"
                            "（未安装 pyproj 或无法识别源坐标系），当前以平面坐标显示"
                        )

                dataset_id = f"ds-{uuid.uuid4().hex[:10]}"
                stored_name = f"{dataset_id}.geojson"
                target = UPLOAD_DIR / stored_name
                write_json_atomic(target, geojson)
                imported = dataset_summary(
                    dataset_id,
                    original_name,
                    geojson,
                    target.stat().st_size,
                    f"uploads/{stored_name}",
                    source_format=source_format,
                    crs_name=crs_name,
                    source_note=source_note,
                    crs_kind=crs_kind,
                )
                catalog = read_catalog()
                catalog["datasets"].append(imported)
                write_catalog(catalog)
                set_active_id(dataset_id)
                self.send_json({"ok": True, "dataset": {**imported, "active": True}})
                return

            if path.startswith("/api/datasets/") and path.endswith("/activate"):
                dataset_id = unquote(remove_suffix(remove_prefix(path, "/api/datasets/"), "/activate")).strip("/")
                find_dataset(dataset_id)
                set_active_id(dataset_id)
                dataset, data = read_dataset(dataset_id)
                self.send_json({"ok": True, "dataset": dataset, "data": data})
                return

            self.send_error_json("unknown endpoint", status=404)
        except json.JSONDecodeError as exc:
            self.send_error_json(f"invalid JSON: {exc}", status=400)
        except KeyError as exc:
            self.send_error_json(str(exc), status=404)
        except ValueError as exc:
            self.send_error_json(str(exc), status=400)
        except Exception as exc:
            status = 404 if isinstance(exc, KeyError) else 400 if isinstance(exc, ValueError) else 500
            self.send_error_json(str(exc), status=status)

    def do_DELETE(self):
        if handle_routing_request(self, "DELETE"):
            return
        path = urlsplit(self.path).path
        try:
            if path.startswith("/api/datasets/"):
                dataset_id = unquote(remove_prefix(path, "/api/datasets/")).strip("/")
                catalog = read_catalog()
                if len(catalog["datasets"]) <= 1:
                    self.send_error_json("至少保留一个数据集", status=409)
                    return
                if dataset_id == get_active_id():
                    self.send_error_json("请先切换到其他数据集，再删除当前数据集", status=409)
                    return
                dataset = find_dataset(dataset_id)
                target = dataset_path(dataset)
                if target.exists():
                    target.unlink()
                catalog["datasets"] = [item for item in catalog["datasets"] if item["id"] != dataset_id]
                write_catalog(catalog)
                self.send_json({"ok": True, "deleted": dataset_id})
                return

            feature_id = self.feature_id_from_path()
            if not feature_id:
                self.send_error_json("unknown endpoint", status=404)
                return
            data = read_geojson()
            remaining = [item for item in data["features"] if str(item.get("id")) != feature_id]
            if len(remaining) == len(data["features"]):
                self.send_error_json("feature not found", status=404)
                return
            data["features"] = remaining
            write_geojson(data)
            self.send_json({"ok": True, "id": feature_id})
        except Exception as exc:
            status = 404 if isinstance(exc, KeyError) else 400 if isinstance(exc, ValueError) else 500
            self.send_error_json(str(exc), status=status)

    def do_PUT(self):
        try:
            feature_id = self.feature_id_from_path()
            if not feature_id:
                self.send_error_json("feature id is required", status=404)
                return
            payload = self.read_json_body()
            feature = payload.get("feature")
            if not isinstance(feature, dict):
                self.send_error_json("feature is required")
                return
            feature["id"] = feature_id
            validate_feature(feature)
            data = read_geojson()
            for index, current in enumerate(data["features"]):
                if str(current.get("id")) == feature_id:
                    data["features"][index] = feature
                    write_geojson(data)
                    self.send_json({"ok": True, "feature": feature})
                    return
            self.send_error_json("feature not found", status=404)
        except Exception as exc:
            status = 404 if isinstance(exc, KeyError) else 400 if isinstance(exc, ValueError) else 500
            self.send_error_json(str(exc), status=status)

    def feature_id_from_path(self):
        path = urlsplit(self.path).path
        prefix = "/api/features/"
        if not path.startswith(prefix):
            return None
        feature_id = unquote(path[len(prefix):]).strip()
        return feature_id or None


def main():
    ensure_storage()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer(("127.0.0.1", port), GisDemoHandler)
    print(f"GIS demo running at http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()

from d_spatial import install_d_spatial
install_d_spatial(GisDemoHandler, read_dataset, write_geojson, validate_feature, STATIC_DIR)
if __name__ == "__main__":
    main()
