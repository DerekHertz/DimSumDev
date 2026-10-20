"""Level 1 with plush Bao sitting up, agents perched on it (supersedes level1_compose.py).

    exec(open(r"D:/claude_sessions/agent_office/design/3d/level1_plush.py").read())

Perches on sitting Bao (model units x BAO_S): Brain on the crown, Muscles on the right
shoulder (the arm) and both thighs, Heart drum on the left shoulder, Liver hotpot on the
grass in front of the belly, Memory pavilion to the side, Stem basket by the left foot,
Immune on the stone path. Qi ribbons go from the crown down the SIDES of the head.
"""
import bpy, math
from mathutils import Vector

D = r"D:/claude_sessions/agent_office/design/3d/"
for f in ("panda_build.py", "role_types.py", "toon.py", "level1_set.py", "dormant.py", "plush.py", "role_types_plush.py"):
    exec(open(D + f, encoding="utf-8").read())

BAO_S = 11.0
FACE_CAM = math.radians(30)


def M(x, y):
    """Bao model (x, y) to world (x, y)."""
    return (x * BAO_S, y * BAO_S)


KEEP = {"L1Cam", "L2Cam", "L3Cam", "L1Sun", "L1Ground"}
for o in list(bpy.context.scene.objects):
    if o.name not in KEEP:
        bpy.data.objects.remove(o, do_unlink=True)

bao = plush_panda("Bao", (0, 0, 0), BAO_S)
bpy.context.view_layer.update()

CROWN = [M(0, 0.05), M(-0.33, -0.12), M(0.33, -0.12)]
SH_R, SH_L = M(0.7, 0.12), M(-0.7, 0.12)
TH_R, TH_L = M(0.6, -0.62), M(-0.6, -0.62)


def top(xy, lift=0.0):
    return Vector((*xy, surface_z(*xy, only=("Bao",)) + lift))


# dormant organ set pieces
pavilion((-21.0, 10.0, 0))                               # Memory
drum((*SH_L, surface_z(*SH_L, only=("Bao",)) - 0.3))      # Heart, on the left shoulder
hotpot((0.0, -13.5, 0.0))                                 # Liver, on the grass at Bao's belly
basket((-12.0, -14.0, 0.0))                               # Stem, by the left foot
stone_path(rx=20.0, ry=20.0, n=56)                        # Immune patrol

# Muscles queue: a tray of ticket scrolls on the grass by the right foot
qx, qy = 11.5, -10.5
place("Muscles_QueueTray", rbox((2.4, 1.4, 0.25), 0.08, 2), mat("Straw", PAL["straw"], 0.9, 0.2), (qx, qy, 0.12),
      rot=(0, 0, math.radians(-10)))
for i in range(4):
    for nm, r, m in (("Scroll", 0.17, mat("Paper", PAL["paper"], 0.8)), ("Tie", 0.18, mat("Muscles", PAL["muscles"], 0.35))):
        place(f"Muscles_Queue{nm}_{i}", cyl(r, 1.1 if nm == "Scroll" else 0.08), m,
              (qx - 0.75 + i * 0.5, qy, 0.42), rot=(math.radians(90), 0, math.radians(-10)))

for i, (x, y, s) in enumerate(((-31, 24, 1), (-12, 30, 2), (18, 28, 3), (-37, 2, 4), (35, 10, 5), (-38, -21, 6))):
    bamboo_cluster(f"Grove{i}", x, y, n=6, h=17, seed=s)
flowers(rx=40, ry=36, keep_out=(21.0, 21.0))

agents = [
    ("PCell_Orchestrator", "L1_orch-01", CROWN[0]),
    ("PCell_Product", "L1_prod-01", CROWN[1]),
    ("PCell_Architect", "L1_arch-01", CROWN[2]),
    ("PCell_Developer", "L1_dev-02", SH_R),
    ("PCell_Scout", "L1_scout-01", TH_L),
    ("PCell_Developer", "L1_dev-03", TH_R),
    ("PCell_QA", "L1_qa-01", (-3.2, -13.8)),
    ("PCell_Security", "L1_sec-01", (14.5, -13.2)),
]
for src, name, (x, y) in agents:
    z = surface_z(x, y, only=("Bao",))
    place_agent(src, name, (x, y, z + 0.02 + AGENT_SCALE), FACE_CAM)   # plush origin is its centre
    contact_shadow(f"Shadow_{name[3:]}", x, y + 0.15)

# Stem: two sleeping cubs in the basket
for i, (dx, dy, rz) in enumerate(((-0.7, 0.1, 40), (0.8, -0.2, -30))):
    place_agent("PCell_QA", f"L1_Cub{i}", (-12.0 + dx, -14.0 + dy, 0.35 + 0.6 * AGENT_SCALE), math.radians(rz))
    cub = bpy.data.objects[f"L1_Cub{i}"]; cub.scale = (0.6, 0.6, 0.6)
    for c in cub.children:                                    # a cub has no props yet
        if "_Fur" not in c.name: c.hide_render = True


def arc(a, b, lift, n=13):
    a, b = Vector(a), Vector(b); pts = []
    for i in range(n):
        t = i / (n - 1); p = a.lerp(b, t)
        p.z = max(p.z, surface_z(p.x, p.y, only=("Bao",)) + 0.6 + lift * math.sin(math.pi * t))
        pts.append(p)
    return pts


def route(points, lift):
    out = []
    for a, b in zip(points, points[1:]):
        out += arc(a, b, lift)[:-1]
    return out + [points[-1]]


qi_material()
crown = top(CROWN[2], 0.5)
side_r = Vector((*M(0.62, -0.15), 15.0)); side_l = Vector((*M(-0.62, -0.15), 15.0))
ribbon("Qi_0", route([crown, side_r, top(SH_R, 0.4)], 0.5), 0.08)
ribbon("Qi_1", route([crown, side_r, top(SH_R, 0.4), Vector((*M(0.92, -0.35), 7.0)), top(TH_R, 0.4)], 0.5), 0.08)
ribbon("Qi_2", route([top(CROWN[1], 0.5), side_l, Vector((*M(-0.92, -0.2), 11.0)), Vector((*M(-0.92, -0.45), 7.0)), top(TH_L, 0.4)], 0.5), 0.08)
path0 = route([crown, side_r, top(SH_R, 0.4)], 0.5)
obj_from_bm("Qi_Bead", sphere(0.36, 16, 10), bpy.data.materials["Qi"], None, loc=tuple(path0[len(path0) // 2]), subsurf=0)

untoon_scene()
# dormant agents: no fur shells (the fade would make them opaque), skin and props faded
for n in ("L1_qa-01", "L1_sec-01", "L1_Cub0", "L1_Cub1"):
    for c in bpy.data.objects[n].children:
        if "_Fur" in c.name: c.hide_render = True
make_dormant(("Liver_", "Heart_", "Mem_", "Stem_", "L1_qa-01", "L1_sec-01", "L1_Cub"))

cam = bpy.data.objects["L1Cam"]
target = Vector((0.0, -2.0, 7.0)); az = math.radians(-60); el = math.radians(35.264)
d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
cam.location = target + d * 120; cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 62; cam.data.shift_x = 0; cam.data.clip_end = 3000
