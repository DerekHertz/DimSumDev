#!/usr/bin/env python3
"""Package the approved Den GLBs without a runtime dependency on external files.

Requires Python 3 and Pillow for this offline authoring step. The application
uses the checked-in outputs and does not run this script while building.
"""

import argparse
import copy
import hashlib
import gzip
import io
import json
import struct
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE.parents[1] / "public" / "den"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
COMPONENT_BYTES = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
TYPE_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def read_glb(path):
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    if len(raw) < 28 or struct.unpack_from("<III", raw) != (0x46546C67, 2, len(raw)):
        raise ValueError(f"Invalid GLB header: {path.name}")
    chunks = {}
    cursor = 12
    while cursor < len(raw):
        length, kind = struct.unpack_from("<II", raw, cursor)
        cursor += 8
        if length % 4 or cursor + length > len(raw) or kind in chunks:
            raise ValueError(f"Invalid GLB chunks: {path.name}")
        chunks[kind] = raw[cursor:cursor + length]
        cursor += length
    document = json.loads(chunks[JSON_CHUNK])
    if len(document.get("buffers", [])) != 1 or "uri" in document["buffers"][0]:
        raise ValueError(f"Expected one embedded buffer: {path.name}")
    if any("uri" in image for image in document.get("images", [])):
        raise ValueError(f"Expected embedded images: {path.name}")
    binary = chunks[BIN_CHUNK]
    if document["buffers"][0]["byteLength"] > len(binary):
        raise ValueError(f"Truncated buffer: {path.name}")
    return document, binary, raw


def view_bytes(document, binary, index):
    view = document["bufferViews"][index]
    start = view.get("byteOffset", 0)
    end = start + view["byteLength"]
    if view.get("buffer", 0) != 0 or start < 0 or end > len(binary):
        raise ValueError("Buffer view exceeds embedded buffer")
    return binary[start:end]


def accessor_bytes(document, binary, index):
    accessor = document["accessors"][index]
    if "sparse" in accessor:
        raise ValueError("Sparse accessors need an explicit preservation audit")
    view = document["bufferViews"][accessor["bufferView"]]
    size = COMPONENT_BYTES[accessor["componentType"]] * TYPE_COMPONENTS[accessor["type"]]
    stride = view.get("byteStride", size)
    offset = accessor.get("byteOffset", 0)
    data = view_bytes(document, binary, accessor["bufferView"])
    if accessor["count"] and offset + (accessor["count"] - 1) * stride + size > len(data):
        raise ValueError("Accessor exceeds buffer view")
    return b"".join(data[offset + i * stride:offset + i * stride + size] for i in range(accessor["count"]))


def index_values(document, binary, index):
    accessor = document["accessors"][index]
    fmt = {5121: "B", 5123: "H", 5125: "I"}[accessor["componentType"]]
    return tuple(v[0] for v in struct.iter_unpack("<" + fmt, accessor_bytes(document, binary, index)))


def triangles(document):
    total = 0
    for mesh in document.get("meshes", []):
        for primitive in mesh["primitives"]:
            if primitive.get("mode", 4) != 4:
                raise ValueError("The approved asset set must contain triangles")
            accessor = primitive.get("indices", primitive["attributes"]["POSITION"])
            total += document["accessors"][accessor]["count"] // 3
    return total


def transform_images(document, binary, max_size):
    replacements, images = {}, []
    image_uses = {}
    def mark(texture_info, use):
        if texture_info is None:
            return
        texture = document["textures"][texture_info["index"]]
        image_uses.setdefault(texture["source"], set()).add(use)
    for material in document.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        mark(pbr.get("baseColorTexture"), "color")
        mark(material.get("emissiveTexture"), "color")
        mark(pbr.get("metallicRoughnessTexture"), "data")
        mark(material.get("normalTexture"), "data")
        mark(material.get("occlusionTexture"), "data")
    for image_index, image in enumerate(document.get("images", [])):
        index = image["bufferView"]
        raw = view_bytes(document, binary, index)
        source = Image.open(io.BytesIO(raw))
        source.load()
        original = source.size
        scale = min(1, max_size / max(source.size))
        if scale < 1:
            source = source.resize(tuple(max(1, round(n * scale)) for n in source.size), Image.Resampling.LANCZOS)
        # RGB retains every channel of fully opaque RGBA images and compresses
        # better. Transparent foliage and cloth keep their original alpha.
        if source.mode == "RGBA" and source.getextrema()[3] == (255, 255):
            source = source.convert("RGB")
        source_mime = image.get("mimeType")
        candidates = []
        if scale == 1:
            candidates.append((raw, source_mime))
        output = io.BytesIO()
        if source_mime == "image/jpeg":
            source.convert("RGB").save(output, "JPEG", quality=94, subsampling=0, optimize=True)
        elif source_mime == "image/png":
            source.save(output, "PNG", optimize=True, compress_level=9)
        else:
            raise ValueError(f"Unsupported embedded image MIME: {source_mime}")
        candidates.append((output.getvalue(), source_mime))
        # WebP is supported by the application's bundled GLTFLoader. Opaque
        # color maps use high quality compression; transparency and PNG data
        # maps use lossless encoding. Existing JPEG data maps are not made lossy
        # a second time through another codec.
        color_only = image_uses.get(image_index) == {"color"}
        if color_only or source_mime == "image/png":
            output = io.BytesIO()
            lossless = not (color_only and source.mode == "RGB")
            source.save(output, "WEBP", lossless=lossless, quality=92, method=6)
            candidates.append((output.getvalue(), "image/webp"))
        encoded, mime = min(candidates, key=lambda item: len(item[0]))
        image["mimeType"] = mime
        replacements[index] = encoded
        images.append({"width": source.width, "height": source.height, "mimeType": mime,
                       "sourceWidth": original[0], "sourceHeight": original[1]})
    webp_images = {i for i, image in enumerate(document.get("images", [])) if image["mimeType"] == "image/webp"}
    if webp_images:
        extension = "EXT_texture_webp"
        for texture in document.get("textures", []):
            if texture.get("source") in webp_images:
                texture.setdefault("extensions", {})[extension] = {"source": texture.pop("source")}
        for key in ("extensionsUsed", "extensionsRequired"):
            if extension not in document.setdefault(key, []):
                document[key].append(extension)
    return replacements, images


def narrow_indices(document, binary, replacements):
    narrowed = []
    indices = {primitive["indices"] for mesh in document.get("meshes", [])
               for primitive in mesh["primitives"] if "indices" in primitive}
    for index in sorted(indices):
        accessor = document["accessors"][index]
        view_index = accessor["bufferView"]
        view = document["bufferViews"][view_index]
        references = [a for a in document["accessors"] if a.get("bufferView") == view_index]
        if accessor["componentType"] != 5125 or len(references) != 1 or view.get("byteStride"):
            continue
        values = index_values(document, binary, index)
        if values and max(values) <= 65535:
            replacements[view_index] = struct.pack("<" + "H" * len(values), *values)
            accessor["componentType"] = 5123
            accessor.pop("byteOffset", None)
            narrowed.append(index)
    return narrowed


def write_glb(path, document, views):
    binary = bytearray()
    for index, raw in enumerate(views):
        binary.extend(b"\0" * (-len(binary) % 4))
        view = document["bufferViews"][index]
        view["buffer"] = 0
        view["byteOffset"] = len(binary)
        view["byteLength"] = len(raw)
        binary.extend(raw)
    document["buffers"][0]["byteLength"] = len(binary)
    binary.extend(b"\0" * (-len(binary) % 4))
    encoded = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode()
    encoded += b" " * (-len(encoded) % 4)
    raw = (struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary))
           + struct.pack("<II", len(encoded), JSON_CHUNK) + encoded
           + struct.pack("<II", len(binary), BIN_CHUNK) + binary)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)


def audit_pair(source_doc, source_binary, output_doc, output_binary):
    if source_doc["meshes"] != output_doc["meshes"]:
        raise ValueError("Mesh topology or attribute mapping changed")
    if source_doc.get("nodes") != output_doc.get("nodes"):
        raise ValueError("Authored object transforms changed")
    indices = {p["indices"] for m in source_doc.get("meshes", []) for p in m["primitives"] if "indices" in p}
    for index, source_accessor in enumerate(source_doc["accessors"]):
        if index in indices:
            if index_values(source_doc, source_binary, index) != index_values(output_doc, output_binary, index):
                raise ValueError("Triangle index values changed")
        elif accessor_bytes(source_doc, source_binary, index) != accessor_bytes(output_doc, output_binary, index):
            raise ValueError("Vertex, normal, UV or animation samples changed")
        if source_accessor["count"] != output_doc["accessors"][index]["count"]:
            raise ValueError("Accessor count changed")
    for index, image in enumerate(output_doc.get("images", [])):
        decoded = Image.open(io.BytesIO(view_bytes(output_doc, output_binary, image["bufferView"])))
        decoded.verify()
    for index in range(len(output_doc["bufferViews"])):
        view_bytes(output_doc, output_binary, index)


def strip_to_color(document, binary):
    """Keep only base colour maps and make every material matte (ticket 23 budget).

    Returns a new document and binary; geometry views are copied unchanged and the
    dropped images' views are removed, so later audits compare against this pair.
    """
    document = copy.deepcopy(document)
    for material in document.get("materials", []):
        for key in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            material.pop(key, None)
        pbr = material.setdefault("pbrMetallicRoughness", {})
        pbr.pop("metallicRoughnessTexture", None)
        pbr["metallicFactor"] = 0
        pbr["roughnessFactor"] = 1
    kept_textures = sorted({m["pbrMetallicRoughness"]["baseColorTexture"]["index"]
                            for m in document.get("materials", []) if "baseColorTexture" in m["pbrMetallicRoughness"]})
    texture_map = {old: new for new, old in enumerate(kept_textures)}
    kept_images = sorted({document["textures"][t]["source"] for t in kept_textures})
    image_map = {old: new for new, old in enumerate(kept_images)}
    dropped = len(document.get("images", [])) - len(kept_images)
    dropped_views = {image["bufferView"] for i, image in enumerate(document.get("images", [])) if i not in image_map}
    view_map, views = {}, []
    for index in range(len(document["bufferViews"])):
        if index not in dropped_views:
            view_map[index] = len(views)
            views.append(view_bytes(document, binary, index))
    document["bufferViews"] = [document["bufferViews"][i] for i in sorted(view_map)]
    for accessor in document["accessors"]:
        if "bufferView" in accessor:
            accessor["bufferView"] = view_map[accessor["bufferView"]]
    document["images"] = [{**document["images"][i], "bufferView": view_map[document["images"][i]["bufferView"]]} for i in kept_images]
    document["textures"] = [{**document["textures"][t], "source": image_map[document["textures"][t]["source"]]} for t in kept_textures]
    for material in document.get("materials", []):
        color = material["pbrMetallicRoughness"].get("baseColorTexture")
        if color:
            color["index"] = texture_map[color["index"]]
    if not document["images"]:
        document.pop("images"); document.pop("textures", None)
    stripped = bytearray()
    for index, raw in enumerate(views):
        stripped.extend(b"\0" * (-len(stripped) % 4))
        document["bufferViews"][index].update(buffer=0, byteOffset=len(stripped), byteLength=len(raw))
        stripped.extend(raw)
    document["buffers"][0]["byteLength"] = len(stripped)
    return document, bytes(stripped), dropped


def pack_asset(asset, source_root, output_root):
    source = source_root / asset["source"]
    source_doc, source_binary, source_raw = read_glb(source)
    dropped = 0
    if asset.get("colorOnly"):
        original_triangles = triangles(source_doc)
        source_doc, source_binary, dropped = strip_to_color(source_doc, source_binary)
        if triangles(source_doc) != original_triangles:
            raise ValueError("Colour-only stripping changed the triangle count")
    document = copy.deepcopy(source_doc)
    replacements, image_info = transform_images(document, source_binary, asset.get("maxTextureSize", 1024))
    narrowed = narrow_indices(document, source_binary, replacements)
    views = [replacements.get(i, view_bytes(source_doc, source_binary, i)) for i in range(len(document["bufferViews"]))]
    relative = Path("models") / (asset["key"].replace(".", "/") + ".glb.gz")
    output = output_root / relative
    write_glb(output, document, views)
    output_doc, output_binary, output_raw = read_glb(output)
    audit_pair(source_doc, source_binary, output_doc, output_binary)
    stored = gzip.compress(output_raw, compresslevel=9, mtime=0)
    if gzip.decompress(stored) != output_raw:
        raise ValueError("Model storage did not round-trip exactly")
    output.write_bytes(stored)
    record = {"url": "/den/" + relative.as_posix(), "kind": asset["kind"],
              "sourceFilename": source.name, "triangles": triangles(output_doc),
              "bytes": len(stored), "sha256": hashlib.sha256(stored).hexdigest(),
              "compression": "gzip", "decodedBytes": len(output_raw),
              "textures": [{k: image[k] for k in ("width", "height", "mimeType")} for image in image_info]}
    if "roleId" in asset:
        record["roleId"] = asset["roleId"]
    private = {"source": asset["source"], "sourceBytes": len(source_raw),
               "sourceSha256": hashlib.sha256(source_raw).hexdigest(),
               "packedBytes": len(output_raw), "narrowedIndexAccessors": narrowed,
               "images": image_info, "audit": "exact vertex/normal/UV samples, transforms and triangle index values retained"}
    if asset.get("colorOnly"):
        private["droppedImages"] = dropped
    return record, private


def source_root_for(asset, source_root, named_roots):
    """Most assets come from the original artifact folder; an entry naming a sourceRoot comes from that folder instead."""
    name = asset.get("sourceRoot")
    if name is None:
        return source_root
    if name not in named_roots:
        raise SystemExit(f'{asset["key"]}: unknown sourceRoot {name!r}')
    return named_roots[name]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_root", type=Path, help="The original artifact folder containing bao-customizer and frontend-layout-mockup")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--meshy-output", type=Path, default=HERE.parents[3] / "meshy_output",
                        help="Folder for catalog entries with sourceRoot meshy_output (default: meshy_output at the repo root)")
    parser.add_argument("--only", action="append", metavar="KEY",
                        help="Repack just these catalog keys from source_root into the existing manifest and audit")
    args = parser.parse_args()
    catalog = json.loads((HERE / "sources.json").read_text())
    manifest = {"version": 1, "assets": {}}
    receipt = {"version": 1, "tool": "pack-assets.py", "assets": {}}
    if args.only:
        unknown = set(args.only) - {a["key"] for a in catalog["assets"]}
        if unknown:
            raise SystemExit(f"Unknown catalog keys: {', '.join(sorted(unknown))}")
        manifest = json.loads((args.output / "manifest.json").read_text())
        receipt = json.loads((HERE / "pack-audit.json").read_text())
    for asset in catalog["assets"]:
        if asset.get("runtime") is False or (args.only and asset["key"] not in args.only):
            continue
        root = source_root_for(asset, args.source_root, {"meshy_output": args.meshy_output})
        record, private = pack_asset(asset, root, args.output)
        manifest["assets"][asset["key"]] = record
        receipt["assets"][asset["key"]] = private
        print(f'{asset["key"]}: {record["bytes"] / 1048576:.2f} MiB', flush=True)
    manifest["bytes"] = sum(a["bytes"] for a in manifest["assets"].values())
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (HERE / "pack-audit.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f'Total: {manifest["bytes"] / 1048576:.2f} MiB / {len(manifest["assets"])} regular GLBs', flush=True)


if __name__ == "__main__":
    main()
