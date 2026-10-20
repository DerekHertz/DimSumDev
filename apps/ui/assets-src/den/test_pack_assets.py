"""Integrity tests for the offline GLB packager; run with python3 -m unittest."""

import copy
import importlib.util
import io
import json
import struct
import tempfile
import unittest
from pathlib import Path

from PIL import Image

SPEC = importlib.util.spec_from_file_location("pack_assets", Path(__file__).with_name("pack-assets.py"))
PACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACK)


def fixture(path, rgba=False):
    image = Image.new("RGBA" if rgba else "RGB", (8, 4), (40, 140, 100, 110) if rgba else (40, 140, 100))
    encoded = io.BytesIO()
    image.save(encoded, "PNG")
    views = [struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0),
             struct.pack("<9f", 0, 0, 1, 0, 0, 1, 0, 0, 1),
             struct.pack("<6f", 0, 0, 1, 0, 0, 1), struct.pack("<3I", 0, 1, 2), encoded.getvalue()]
    doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 0}],
           "bufferViews": [{"buffer": 0, "byteLength": len(raw)} for raw in views],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]},
                         {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC3"},
                         {"bufferView": 2, "componentType": 5126, "count": 3, "type": "VEC2"},
                         {"bufferView": 3, "componentType": 5125, "count": 3, "type": "SCALAR"}],
           "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3, "material": 0}]}],
           "nodes": [{"mesh": 0, "translation": [2, 0, -1]}], "scenes": [{"nodes": [0]}], "scene": 0,
           "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
           "textures": [{"source": 0}], "images": [{"bufferView": 4, "mimeType": "image/png"}]}
    PACK.write_glb(path, doc, views)


class PackAssetsTests(unittest.TestCase):
    def test_pack_preserves_geometry_and_self_containment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root / "source.glb")
            record, receipt = PACK.pack_asset({"key": "props.qa", "source": "source.glb", "kind": "prop", "roleId": "qa", "maxTextureSize": 4}, root, root / "out")
            self.assertEqual(record["url"], "/den/models/props/qa.glb.gz")
            self.assertEqual(record["triangles"], 1)
            self.assertEqual((record["textures"][0]["width"], record["textures"][0]["height"]), (4, 2))
            self.assertIn(record["textures"][0]["mimeType"], {"image/png", "image/jpeg", "image/webp"})
            self.assertEqual(receipt["narrowedIndexAccessors"], [3])
            doc, binary, _ = PACK.read_glb(root / "out/models/props/qa.glb.gz")
            self.assertEqual(doc["accessors"][3]["componentType"], 5123)
            self.assertEqual(PACK.index_values(doc, binary, 3), (0, 1, 2))
            self.assertEqual(doc["nodes"][0]["translation"], [2, 0, -1])
            self.assertTrue(all(view["byteOffset"] % 4 == 0 for view in doc["bufferViews"]))
            self.assertNotIn(str(root), json.dumps(record))

    def test_transparent_color_map_retains_lossless_alpha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root / "source.glb", rgba=True)
            record, _ = PACK.pack_asset({"key": "vegetation.bamboo", "source": "source.glb", "kind": "vegetation", "maxTextureSize": 4}, root, root / "out")
            self.assertIn(record["textures"][0]["mimeType"], {"image/png", "image/webp"})
            doc, binary, _ = PACK.read_glb(root / "out/models/vegetation/bamboo.glb.gz")
            image = Image.open(io.BytesIO(PACK.view_bytes(doc, binary, doc["images"][0]["bufferView"])))
            self.assertEqual(image.mode, "RGBA")
            self.assertEqual(image.getextrema()[3], (110, 110))
            if record["textures"][0]["mimeType"] == "image/webp":
                self.assertIn("EXT_texture_webp", doc["extensionsRequired"])
                self.assertEqual(doc["textures"][0]["extensions"]["EXT_texture_webp"]["source"], 0)
                self.assertNotIn("source", doc["textures"][0])

    def test_audit_rejects_modified_uv_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.glb"
            fixture(path)
            doc, binary, _ = PACK.read_glb(path)
            changed = bytearray(binary)
            offset = doc["bufferViews"][2]["byteOffset"]
            struct.pack_into("<f", changed, offset, 0.25)
            with self.assertRaisesRegex(ValueError, "UV"):
                PACK.audit_pair(doc, binary, copy.deepcopy(doc), changed)

    def test_color_only_keeps_one_matte_color_map_and_exact_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root / "plain.glb")
            doc, binary, _ = PACK.read_glb(root / "plain.glb")
            views = [PACK.view_bytes(doc, binary, i) for i in range(len(doc["bufferViews"]))]
            normal = io.BytesIO()
            Image.new("RGB", (8, 4), (128, 128, 255)).save(normal, "PNG")
            views.insert(0, normal.getvalue())
            doc["bufferViews"].insert(0, {"buffer": 0, "byteLength": len(views[0])})
            for item in doc["accessors"] + doc["images"]:
                item["bufferView"] += 1
            doc["images"].append({"bufferView": 0, "mimeType": "image/png"})
            doc["textures"].append({"source": 1})
            doc["materials"][0]["normalTexture"] = {"index": 1}
            doc["materials"][0]["pbrMetallicRoughness"].update(metallicRoughnessTexture={"index": 1}, metallicFactor=1)
            PACK.write_glb(root / "source.glb", doc, views)
            record, receipt = PACK.pack_asset({"key": "characters.developer", "source": "source.glb", "kind": "character", "roleId": "developer", "maxTextureSize": 4, "colorOnly": True}, root, root / "out")
            self.assertEqual(record["url"], "/den/models/characters/developer.glb.gz")
            self.assertEqual(len(record["textures"]), 1)
            self.assertEqual(receipt["droppedImages"], 1)
            out, out_binary, _ = PACK.read_glb(root / "out/models/characters/developer.glb.gz")
            material = out["materials"][0]
            self.assertNotIn("normalTexture", material)
            self.assertEqual(material["pbrMetallicRoughness"]["metallicFactor"], 0)
            self.assertEqual(material["pbrMetallicRoughness"]["roughnessFactor"], 1)
            self.assertNotIn("metallicRoughnessTexture", material["pbrMetallicRoughness"])
            self.assertEqual(len(out["images"]), 1)
            self.assertEqual(PACK.accessor_bytes(out, out_binary, 0), PACK.accessor_bytes(doc, PACK.read_glb(root / "source.glb")[1], 0))

    def test_entries_naming_a_source_root_are_read_from_that_folder(self):
        catalog = json.loads(Path(__file__).with_name("sources.json").read_text())["assets"]
        artifacts, meshy = Path("/artifacts"), Path("/meshy")
        named = [a for a in catalog if "sourceRoot" in a]
        self.assertEqual({a["key"] for a in named}, {"characters.developer", "characters.technical-writer"})
        for asset in catalog:
            expected = meshy if "sourceRoot" in asset else artifacts
            self.assertEqual(PACK.source_root_for(asset, artifacts, {"meshy_output": meshy}), expected)
        with self.assertRaises(SystemExit):
            PACK.source_root_for({"key": "x", "sourceRoot": "elsewhere"}, artifacts, {"meshy_output": meshy})

    def test_catalog_contains_approved_unique_assets_and_all_role_tools(self):
        catalog = json.loads(Path(__file__).with_name("sources.json").read_text())["assets"]
        self.assertEqual(len(catalog), 38)
        self.assertEqual(len({a["key"] for a in catalog}), 38)
        active = [a for a in catalog if a.get("runtime") is not False]
        self.assertEqual(len(active), 24)
        self.assertFalse(any(a["key"].startswith("scenery.") for a in active))
        roles = {a["roleId"] for a in catalog if a["kind"] == "prop"}
        self.assertEqual(roles, {"orchestrator", "product", "architect", "developer", "scout", "debugger", "qa", "security", "designer", "herald", "release-manager", "knowledge-keeper", "docs-writer", "stem-cub"})
        self.assertFalse(any("security-vest-preview" in a["source"] or "/hat-" in a["source"] for a in catalog))


if __name__ == "__main__":
    unittest.main()
