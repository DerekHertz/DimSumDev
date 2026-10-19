# Step 3 of the panda asset build. Run after build_rig.py, inside Blender:
#   exec(open(r"<repo>/apps/ui/assets-src/panda/build_face.py").read())
# Replaces the baked sleepy face with a face decal driven by a sprite atlas (spec: "Faces").
# - Removes the baked eyelid slivers from PA_Panda (the black eye patches stay).
# - Draws face-atlas.png: one agent per face frame, eyes and mouth only, transparent elsewhere.
# - Builds the "face" mesh: a thin shell lifted off the front of the head, skinned to the head bone,
#   with UVs covering atlas agent 0. A renderer selects frame i by offsetting the texture by
#   (col / cols, row / rows) in glTF UV space (v down), where col = i % cols and row = i // cols.
#   The node's extras.faceAtlas carries {cols, rows, defaultFrame, frames: {name: index}}.
import bpy
import bmesh
import os
import numpy as np
from math import cos, sin, pi
from mathutils import Vector

SCENE = "PandaAsset"
BODY = "PA_Panda"
RIG = "PA_Rig"
FACE = "face"
HERE = os.path.dirname(globals().get("__file__") or globals().get("PANDA_SRC", ""))
ATLAS_PNG = os.path.join(globals().get("PANDA_SRC", HERE), "face-atlas.png")

# The decal covers this window on the front of the head (Blender space, the panda faces -Y).
X0, X1 = -0.34, 0.34
Z0, Z1 = 0.20, 0.56
LIFT = 0.004  # how far the decal floats off the head surface
AGENT_W, AGENT_H = 256, 128
COLS, ROWS = 4, 3

FRAMES = [
    "neutral", "blink", "content_squint", "wide_eyes", "half_lidded", "focused_squint",
    "narrowed", "eyes_shut_savoring", "sour_pucker", "sleepy", "yawn",
]
DEFAULT_FRAME = "neutral"


# ---------- the atlas ----------

def to_px(x, z):
    """Head-front coordinates to agent pixels (origin top-left)."""
    return (x - X0) / (X1 - X0) * AGENT_W, (Z1 - z) / (Z1 - Z0) * AGENT_H


EYE_R = to_px(-0.225, 0.44)  # character right eye: viewer's left
EYE_L = to_px(0.225, 0.44)
MOUTH = to_px(0.0, 0.285)
EYE_SCALE = 1.4    # features are drawn at a base size, then scaled up to read at small size
MOUTH_SCALE = 1.3

CREAM = (0.96, 0.94, 0.88)
INK = (0.06, 0.05, 0.05)
PINK = (0.93, 0.55, 0.58)
SHINE = (1.0, 1.0, 1.0)


class Agent:
    def __init__(self):
        yy, xx = np.mgrid[0:AGENT_H, 0:AGENT_W].astype(np.float32) + 0.5
        self.x, self.y = xx, yy
        self.k = 1.0
        self.rgba = np.zeros((AGENT_H, AGENT_W, 4), np.float32)

    def scaled(self, cx, cy, k, draw):
        """Runs draw() with the canvas magnified k times about (cx, cy)."""
        x, y = self.x, self.y
        self.x, self.y, self.k = cx + (x - cx) / k, cy + (y - cy) / k, k
        draw()
        self.x, self.y, self.k = x, y, 1.0

    def _over(self, sdf, colour):
        a = np.clip(0.5 - sdf * self.k, 0.0, 1.0)[..., None]
        c = np.array(colour, np.float32)
        out_a = a + self.rgba[..., 3:4] * (1 - a)
        rgb = (c * a + self.rgba[..., :3] * self.rgba[..., 3:4] * (1 - a)) / np.maximum(out_a, 1e-6)
        self.rgba = np.concatenate([rgb, out_a], axis=-1)

    def ellipse(self, cx, cy, rx, ry, colour):
        d = np.sqrt(((self.x - cx) / rx) ** 2 + ((self.y - cy) / ry) ** 2)
        self._over((d - 1.0) * min(rx, ry), colour)

    def stroke(self, pts, width, colour):
        d = np.full(self.x.shape, 1e9, np.float32)
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            abx, aby = bx - ax, by - ay
            t = np.clip(((self.x - ax) * abx + (self.y - ay) * aby) / max(abx * abx + aby * aby, 1e-6), 0, 1)
            d = np.minimum(d, np.hypot(self.x - (ax + abx * t), self.y - (ay + aby * t)))
        self._over(d - width / 2, colour)

    def arc(self, cx, cy, rx, ry, a0, a1, width, colour, n=24):
        pts = [(cx + rx * cos(a0 + (a1 - a0) * i / n), cy + ry * sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
        self.stroke(pts, width, colour)


def both(fn):
    """Draws an eye on each side; fn(agent, cx, cy, s) gets s = +1 on the viewer's right."""
    return lambda c: [c.scaled(*eye, EYE_SCALE, lambda e=eye, s=s: fn(c, *e, s)) for eye, s in ((EYE_R, -1), (EYE_L, 1))]


def open_eye(c, cx, cy, s, r=15, pupil=10, shine=4):
    c.ellipse(cx, cy, r, r, CREAM)
    c.ellipse(cx + 1, cy + 2, pupil, pupil, INK)
    c.ellipse(cx - 3, cy - 3, shine, shine, SHINE)


def closed_line(c, cx, cy, s, bend=3):
    c.stroke([(cx - 13, cy), (cx, cy + bend), (cx + 13, cy)], 4, CREAM)


def happy_arc(c, cx, cy, s):          # ^ : content, squinting with pleasure
    c.arc(cx, cy + 6, 13, 11, pi * 1.1, pi * 1.9, 4, CREAM)


def savour_arc(c, cx, cy, s):         # u : eyes shut, savouring
    c.arc(cx, cy - 4, 13, 9, pi * 0.1, pi * 0.9, 4, CREAM)


def sleepy_arc(c, cx, cy, s):         # low, heavy closed lids
    c.arc(cx, cy, 13, 6, pi * 0.05, pi * 0.95, 4, CREAM)


def half_lid(c, cx, cy, s):
    open_eye(c, cx, cy + 2, s)
    c.ellipse(cx, cy - 9, 17, 11, INK)          # the lid covers the top half
    c.stroke([(cx - 15, cy - 1), (cx + 15, cy - 1)], 3, CREAM)


def focused(c, cx, cy, s):
    c.ellipse(cx, cy, 15, 8, CREAM)
    c.ellipse(cx + 1, cy + 1, 7, 7, INK)
    c.ellipse(cx - 2, cy - 2, 2.5, 2.5, SHINE)


def narrowed(c, cx, cy, s):           # flat, slightly slanted: unimpressed
    c.stroke([(cx - 14, cy - 2 * s), (cx + 14, cy + 2 * s)], 5, CREAM)
    c.ellipse(cx + 2 * s, cy + 3, 5, 3, CREAM)


def squeeze(c, cx, cy, s):            # > <
    tip = cx - 6 * s  # points toward the nose
    c.stroke([(tip + 12 * s, cy - 8), (tip, cy), (tip + 12 * s, cy + 8)], 4, CREAM)


def wide(c, cx, cy, s):
    c.ellipse(cx, cy, 19, 19, CREAM)
    c.ellipse(cx, cy + 1, 8, 8, INK)
    c.ellipse(cx - 5, cy - 5, 4, 4, SHINE)
    c.ellipse(cx + 4, cy + 5, 2, 2, SHINE)


def mouth_w(c):                       # the resting plush mouth
    mx, my = MOUTH
    c.arc(mx - 6, my - 2, 6, 5, pi * 0.05, pi * 0.95, 3, INK)
    c.arc(mx + 6, my - 2, 6, 5, pi * 0.05, pi * 0.95, 3, INK)


def mouth_smile(c):
    mx, my = MOUTH
    c.arc(mx, my - 5, 12, 8, pi * 0.1, pi * 0.9, 3, INK)


def mouth_flat(c):
    mx, my = MOUTH
    c.stroke([(mx - 7, my), (mx + 7, my)], 3, INK)


def mouth_frown(c):
    mx, my = MOUTH
    c.arc(mx, my + 5, 8, 5, pi * 1.15, pi * 1.85, 3, INK)


def mouth_o(c, r=4):
    mx, my = MOUTH
    c.ellipse(mx, my, r, r * 1.2, INK)


def mouth_savour(c):
    mx, my = MOUTH
    c.arc(mx, my - 5, 12, 8, pi * 0.1, pi * 0.9, 3, INK)
    c.ellipse(mx + 4, my + 4, 4, 3.5, PINK)


def mouth_pucker(c):
    mx, my = MOUTH
    c.ellipse(mx, my, 4, 4, INK)
    for a in range(6):
        ang = a * pi / 3
        c.stroke([(mx + 5 * cos(ang), my + 5 * sin(ang)), (mx + 8 * cos(ang), my + 8 * sin(ang))], 2, INK)


def mouth_yawn(c):
    mx, my = MOUTH
    c.ellipse(mx, my + 3, 10, 13, INK)
    c.ellipse(mx, my + 9, 6, 5, PINK)


FACES = {
    "neutral": (both(open_eye), mouth_w),
    "blink": (both(closed_line), mouth_w),
    "content_squint": (both(happy_arc), mouth_smile),
    "wide_eyes": (both(wide), mouth_o),
    "half_lidded": (both(half_lid), mouth_flat),
    "focused_squint": (both(focused), mouth_flat),
    "narrowed": (both(narrowed), mouth_frown),
    "eyes_shut_savoring": (both(savour_arc), mouth_savour),
    "sour_pucker": (both(squeeze), mouth_pucker),
    "sleepy": (both(sleepy_arc), lambda c: mouth_o(c, 3)),
    "yawn": (both(lambda c, cx, cy, s: closed_line(c, cx, cy, s, bend=-2)), mouth_yawn),
}


def draw_atlas():
    atlas = np.zeros((ROWS * AGENT_H, COLS * AGENT_W, 4), np.float32)
    for i, name in enumerate(FRAMES):
        c = Agent()
        eyes, mouth = FACES[name]
        eyes(c)
        c.scaled(*MOUTH, MOUTH_SCALE, lambda: mouth(c))
        r, k = divmod(i, COLS)
        atlas[r * AGENT_H:(r + 1) * AGENT_H, k * AGENT_W:(k + 1) * AGENT_W] = c.rgba
    name = "face_atlas"
    img = bpy.data.images.get(name)
    if img and tuple(img.size) != (COLS * AGENT_W, ROWS * AGENT_H):
        bpy.data.images.remove(img)
        img = None
    img = img or bpy.data.images.new(name, COLS * AGENT_W, ROWS * AGENT_H, alpha=True)
    img.alpha_mode = "STRAIGHT"
    img.pixels.foreach_set(np.flipud(atlas).ravel())  # Blender rows run bottom-up
    img.filepath_raw = ATLAS_PNG
    img.file_format = "PNG"
    img.save()
    img.pack()
    return img


# ---------- the decal ----------

def remove_baked_eyelids(body):
    """The baked sleepy eyes are two small dark slivers sitting on the eye patches."""
    bm = bmesh.new()
    bm.from_mesh(body.data)
    seen, doomed = set(), []
    for v in bm.verts:
        if v in seen:
            continue
        comp, stack = [], [v]
        seen.add(v)
        while stack:
            x = stack.pop()
            comp.append(x)
            for e in x.link_edges:
                o = e.other_vert(x)
                if o not in seen:
                    seen.add(o)
                    stack.append(o)
        c = sum((x.co for x in comp), Vector()) / len(comp)
        if len(comp) < 300 and abs(abs(c.x) - 0.19) < 0.06 and abs(c.z - 0.44) < 0.04 and c.y < -0.25:
            doomed += comp
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(body.data)
    bm.free()
    return len(doomed)


def in_window(co):
    return X0 <= co.x <= X1 and Z0 <= co.z <= Z1 and co.y < -0.1


def build_decal(sc, body, rig, img):
    """Copies the frontmost head surface inside the window, lifts it along its normals and maps it
    onto atlas agent 0."""
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.faces.ensure_lookup_table()
    head_idx = body.vertex_groups["head"].index
    dl = bm.verts.layers.deform.active

    def is_head(v):
        return v[dl].get(head_idx, 0.0) > 0.99

    faces = [f for f in bm.faces if f.normal.y < -0.15 and all(in_window(v.co) and is_head(v) for v in f.verts)]
    # The head is two stacked shells; keep only the frontmost surface (the one a ray from the front hits).
    from mathutils.bvhtree import BVHTree
    tree = BVHTree.FromBMesh(bm)
    front = []
    for f in faces:
        c = f.calc_center_median()
        hit = tree.ray_cast(c + Vector((0, -1, 0)), Vector((0, 1, 0)))
        if hit[2] is not None and hit[2] == f.index:
            front.append(f)
    out = bmesh.new()
    vmap = {}
    uv = out.loops.layers.uv.new("UVMap")
    for f in front:
        vs = []
        for v in f.verts:
            if v not in vmap:
                vmap[v] = out.verts.new(v.co + v.normal * LIFT)
            vs.append(vmap[v])
        nf = out.faces.new(vs)
        for loop in nf.loops:
            co = loop.vert.co
            u = (co.x - X0) / (X1 - X0)
            t = (Z1 - co.z) / (Z1 - Z0)                     # 0 at the top of the window
            loop[uv].uv = (u / COLS, 1.0 - t / ROWS)          # agent 0 is the atlas's top-left
    bm.free()
    me = bpy.data.meshes.get(FACE + "Mesh")
    if me:
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(FACE + "Mesh")
    out.to_mesh(me)
    out.free()
    for p in me.polygons:
        p.use_smooth = True

    old = bpy.data.objects.get(FACE)
    if old:
        bpy.data.objects.remove(old)
    ob = bpy.data.objects.new(FACE, me)
    sc.collection.objects.link(ob)
    me.materials.append(face_material(img))
    g = ob.vertex_groups.new(name="head")
    g.add([v.index for v in me.vertices], 1.0, "REPLACE")
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    ob.parent = rig
    ob["faceAtlas"] = {
        "cols": COLS, "rows": ROWS, "defaultFrame": DEFAULT_FRAME,
        "frames": {n: i for i, n in enumerate(FRAMES)},
    }
    return ob


def face_material(img):
    name = "face_atlas"
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Roughness"].default_value = 0.9
    mat.surface_render_method = "BLENDED"
    mat.use_backface_culling = True
    return mat


def run():
    sc = bpy.data.scenes[SCENE]
    bpy.context.window.scene = sc
    body, rig = bpy.data.objects[BODY], bpy.data.objects[RIG]
    removed = remove_baked_eyelids(body)
    img = draw_atlas()
    face = build_decal(sc, body, rig, img)
    return removed, face


if __name__ == "__main__" or True:
    _removed, _face = run()
    result = {"eyelid_verts_removed": _removed, "face_faces": len(_face.data.polygons), "atlas": ATLAS_PNG}
