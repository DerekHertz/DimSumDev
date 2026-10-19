"""Plush pandas from the Meshy "Chubby Snorlax Panda" model: clean markings + fur shells.

    exec(open(r"D:/claude_sessions/agent_office/design/3d/plush.py").read())
    base = plush_base()                 # cleaned, painted, subdivided mesh (object "PlushBase")
    p = plush_panda("Bao", at, scale)   # a linked copy with fur shells

Source: D:/web_downloads/panda (Meshy AI). The model faces -Y, sits on z = -1, is 2 units tall.

Why not use its texture directly: the texture is a scrambled atlas with white "tuft"
shards painted onto the black shoulders. We sample it onto the mesh, then diffuse the
luminance across the surface and threshold it, which removes the shards but keeps the big
black/white regions. The face (eyes, nose, smile) and the paw beans keep the raw texture.

Fur: N shell layers pushed out along the normal. Each layer shows only the strands whose
noise value is above the layer height, so strands thin out toward the tips. The same
technique runs in three.js (instanced shells, alpha test), roughly N x the triangle count.
"""
import bpy, bmesh, math
import numpy as np
from mathutils import Vector

SRC = r"D:\web_downloads\panda\Meshy_AI_Chubby_Snorlax_Panda_0926191911_texture.blend"
WHITE = np.array((0.9, 0.86, 0.79)); BLACK = np.array((0.016, 0.014, 0.015))
FUR_LAYERS = 14
FUR_LEN = 0.045          # in model units (model is 2 units tall)
AGENT_SCALE_REF = 1.1     # fur strands are tuned at agent size


def _islands(bm):
    bm.faces.ensure_lookup_table(); seen = set(); out = []
    for f in bm.faces:
        if f.index in seen: continue
        stack = [f]; isl = []; seen.add(f.index)
        while stack:
            g = stack.pop(); isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen: seen.add(h.index); stack.append(h)
        out.append(isl)
    return out


def _is_face(c):
    return c.y < -0.3 and -0.05 < c.z < 0.8 and abs(c.x) < 0.5


def plush_base():
    if "PlushBase" in bpy.data.objects:
        return bpy.data.objects["PlushBase"]
    with bpy.data.libraries.load(SRC, link=False) as (src, dst):
        dst.objects = ["Mesh_0"]
    o = dst.objects[0]; o.name = "PlushBase"; o.data.name = "PlushBase"
    bpy.context.scene.collection.objects.link(o)
    tex = o.active_material.node_tree.nodes["Image Texture"].image      # base colour atlas

    # 1. remove the shard islands (keep the eye beads and nose on the face)
    bm = bmesh.new(); bm.from_mesh(o.data)
    kill = []
    for isl in _islands(bm):
        if len(isl) < 60:
            c = sum((f.calc_center_median() for f in isl), Vector()) / len(isl)
            if not _is_face(c): kill += isl
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(o.data); bm.free()

    # 2. subdivide for smooth shape and enough vertices to carry the markings
    for s in bpy.context.scene.objects: s.select_set(False)
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    m = o.modifiers.new("Sub", 'SUBSURF'); m.levels = m.render_levels = 2
    bpy.ops.object.modifier_apply(modifier="Sub")
    bpy.ops.object.shade_smooth()

    # 3. sample the atlas per vertex
    small = tex.copy(); small.scale(1024, 1024)
    px = np.empty(1024 * 1024 * 4, dtype=np.float32); small.pixels.foreach_get(px)
    px = px.reshape(1024, 1024, 4)[:, :, :3]
    me = o.data; uv = me.uv_layers.active.data
    nv = len(me.vertices)
    acc = np.zeros((nv, 3)); cnt = np.zeros(nv)
    for poly in me.polygons:
        for li, vi in zip(poly.loop_indices, poly.vertices):
            u, v = uv[li].uv
            x = min(1023, max(0, int(u * 1023))); y = min(1023, max(0, int(v * 1023)))
            acc[vi] += px[y, x]; cnt[vi] += 1
    raw = acc / np.maximum(cnt, 1)[:, None]
    lum = raw @ np.array([0.2126, 0.7152, 0.0722])

    # 4. clean: diffuse luminance over the surface, then threshold into fur regions
    nbr = [[] for _ in range(nv)]
    for e in me.edges:
        a, b = e.vertices; nbr[a].append(b); nbr[b].append(a)
    L = lum.copy()
    for _ in range(14):
        L = np.array([(L[i] * 2 + L[n].sum()) / (2 + len(n)) if n else L[i] for i, n in enumerate(nbr)])
    t = np.clip((L - 0.25) / 0.2, 0, 1); t = t * t * (3 - 2 * t)      # soft edge, then fur fuzzes it
    col = BLACK[None, :] * (1 - t[:, None]) + WHITE[None, :] * t[:, None]

    # 5. the face: eye patches from lightly smoothed texture (so they keep their size),
    #    raw texture for the details inside them (eye whites, lids) and the nose and smile
    co = np.array([v.co[:] for v in me.vertices]); nrm = np.array([v.normal[:] for v in me.vertices])
    face = (co[:, 1] < -0.3) & (co[:, 2] > -0.05) & (co[:, 2] < 0.8) & (np.abs(co[:, 0]) < 0.55)
    Lf = lum.copy()
    for _ in range(2):
        Lf = np.array([(Lf[i] * 2 + Lf[n].sum()) / (2 + len(n)) if n else Lf[i] for i, n in enumerate(nbr)])
    patch = face & (Lf < 0.42)
    lin_raw = np.where(raw <= 0.04045, raw / 12.92, ((raw + 0.055) / 1.055) ** 2.4)
    col[face] = np.where(patch[face, None], BLACK[None, :], WHITE[None, :])
    detail = face & ((patch & (lum > 0.3)) | (~patch & (lum < 0.18)))
    col[detail] = lin_raw[detail]
    # paw beans: keep the grey pads from the texture
    soles = (nrm[:, 1] < -0.55) & (co[:, 2] < -0.35)
    grey = (np.abs(raw - raw.mean(1, keepdims=True)).max(1) < 0.08) & (lum > 0.12) & (lum < 0.55)
    col[soles & grey] = lin_raw[soles & grey]
    attr = me.color_attributes.new("Col", 'FLOAT_COLOR', 'POINT')
    attr.data.foreach_set("color", np.hstack([col, np.ones((nv, 1))]).ravel().astype(np.float32))
    me.color_attributes.active_color = attr
    # fur mask: no fur over the eye patches, nose and smile, so the sleepy face stays crisp
    fm = np.ones(nv); fm[patch | detail] = 0.0; fm[face & ~patch] *= 0.6
    for _ in range(2):
        fm = np.array([(fm[i] + fm[n].sum()) / (1 + len(n)) if n else fm[i] for i, n in enumerate(nbr)])
    fa = me.attributes.new("FurMask", 'FLOAT', 'POINT'); fa.data.foreach_set("value", fm.astype(np.float32))
    # TexMask: where the full-resolution texture is shown instead of the cleaned colours.
    # The face and the legs/feet are clean in the texture; the shards live on the torso, arms and back.
    tm = (face | (co[:, 2] < -0.45)).astype(float)
    for _ in range(3):
        tm = np.array([(tm[i] + tm[n].sum()) / (1 + len(n)) if n else tm[i] for i, n in enumerate(nbr)])
    ta = me.attributes.new("TexMask", 'FLOAT', 'POINT'); ta.data.foreach_set("value", tm.astype(np.float32))

    o["atlas"] = tex.name
    me.materials.clear(); me.materials.append(plush_skin(tex))
    o["source"] = "Meshy AI Chubby Snorlax Panda, cleaned"
    return o


def plush_color(nt, tex):
    """Base colour: the cleaned vertex colours, with the full-res texture where TexMask is 1."""
    ca = nt.nodes.new("ShaderNodeVertexColor"); ca.layer_name = "Col"
    it = nt.nodes.new("ShaderNodeTexImage"); it.image = tex
    uvn = nt.nodes.new("ShaderNodeUVMap"); nt.links.new(uvn.outputs[0], it.inputs[0])
    tm = nt.nodes.new("ShaderNodeAttribute"); tm.attribute_name = "TexMask"
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = 'RGBA'
    nt.links.new(tm.outputs["Fac"], mix.inputs[0]); nt.links.new(ca.outputs["Color"], mix.inputs[6])
    nt.links.new(it.outputs["Color"], mix.inputs[7])
    return mix.outputs[2]


def plush_skin(tex=None):
    m = bpy.data.materials.get("PlushSkin")
    if m: return m
    m = bpy.data.materials.new("PlushSkin"); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    nt.links.new(plush_color(nt, tex), b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.95
    b.inputs["Sheen Weight"].default_value = 0.8; b.inputs["Sheen Roughness"].default_value = 0.35
    return m


def fur_material(layer, n, tex=None, strand_scale=380.0):
    name = f"PlushFur_{layer:02d}" + ("" if strand_scale == 380.0 else f"_s{int(strand_scale)}")
    m = bpy.data.materials.get(name)
    if m: return m
    h = layer / n
    m = bpy.data.materials.new(name); m.use_nodes = True
    try: m.surface_render_method = 'DITHERED'
    except Exception: m.blend_method = 'HASHED'
    nt = m.node_tree; nodes = nt.nodes; b = nodes["Principled BSDF"]
    shade = nodes.new("ShaderNodeMix"); shade.data_type = 'RGBA'; shade.blend_type = 'MULTIPLY'
    shade.inputs[0].default_value = 1.0; shade.inputs[7].default_value = (*(0.62 + 0.38 * h,) * 3, 1)   # darker at the roots
    nt.links.new(plush_color(nt, tex), shade.inputs[6]); nt.links.new(shade.outputs[2], b.inputs["Base Color"])
    tc = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = strand_scale
    noise.inputs["Detail"].default_value = 0.0
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = nodes.new("ShaderNodeMath"); ramp.operation = 'GREATER_THAN'
    ramp.inputs[1].default_value = 0.35 + 0.35 * h                  # fewer strands survive toward the tips
    mask = nodes.new("ShaderNodeAttribute"); mask.attribute_name = "FurMask"
    mul = nodes.new("ShaderNodeMath"); mul.operation = 'MULTIPLY'
    nt.links.new(noise.outputs["Fac"], ramp.inputs[0]); nt.links.new(ramp.outputs[0], mul.inputs[0])
    nt.links.new(mask.outputs["Fac"], mul.inputs[1]); nt.links.new(mul.outputs[0], b.inputs["Alpha"])
    b.inputs["Roughness"].default_value = 1.0
    b.inputs["Sheen Weight"].default_value = 1.0; b.inputs["Sheen Roughness"].default_value = 0.3
    return m


def plush_panda(name, at=(0, 0, 0), scale=1.0, rot_z=0.0, fur=True):
    """A copy of the plush base (shared mesh) placed in the scene, with fur shells as children."""
    base = plush_base()
    old = bpy.data.objects.get(name)
    if old:
        for c in list(old.children_recursive): bpy.data.objects.remove(c, do_unlink=True)
        bpy.data.objects.remove(old, do_unlink=True)
    p = bpy.data.objects.new(name, base.data); bpy.context.scene.collection.objects.link(p)
    p.scale = (scale,) * 3; p.rotation_euler = (0, 0, rot_z)
    p.location = (at[0], at[1], at[2] + 1.0 * scale)                # model sits on z = -1
    if fur:
        for i in range(1, FUR_LAYERS + 1):
            s = bpy.data.objects.new(f"{name}_Fur{i:02d}", base.data)
            bpy.context.scene.collection.objects.link(s); s.parent = p
            d = s.modifiers.new("Push", 'DISPLACE'); d.direction = 'NORMAL'; d.mid_level = 0.0
            d.strength = FUR_LEN * i / FUR_LAYERS
            s.material_slots[0].link = 'OBJECT'
            # strands ~constant in world size: big Bao gets proportionally finer noise (capped)
            strand = 380.0 * min(max(scale / AGENT_SCALE_REF, 1.0), 4.0)
            s.material_slots[0].material = fur_material(i, FUR_LAYERS, bpy.data.images[base["atlas"]], strand)
    return p


def untoon_scene():
    """Plush everywhere: props go back to their soft Principled look, no ink outlines."""
    for m in bpy.data.materials:
        if not m.use_nodes or m.name.endswith("·dormant"): continue
        nt = m.node_tree
        out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
        pb = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if not out or not pb: continue
        if out.inputs[0].links and out.inputs[0].links[0].from_node.type == 'GROUP':
            nt.links.new(pb.outputs[0], out.inputs[0])
            pb.inputs["Sheen Weight"].default_value = max(pb.inputs["Sheen Weight"].default_value, 0.3)
    for o in bpy.context.scene.objects:
        mo = o.modifiers.get("Outline")
        if mo: o.modifiers.remove(mo)
