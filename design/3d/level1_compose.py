"""Compose the Level 1 hero frame from Bao, the set pieces and the cells.

    exec(open(r"D:/claude_sessions/agent_office/design/3d/level1_compose.py").read())

Sample data (design brief §10): Brain + Muscles live, Liver / Heart / Memory /
Immune / Stem dormant. One cell waits on the user (architect), dev-03 has failed
tests, scout reads ahead, QA and security sit asleep at dormant stations.

Every cell stands ON Bao: positions are in Bao's own units (L) and scaled with
BAO_SCALE, so resizing Bao keeps every cell on its body part. Cells get a soft
contact shadow instead of a mat.
"""
import bpy, math
from mathutils import Vector

D = r"D:/claude_sessions/agent_office/design/3d/"
for f in ("panda_build.py", "role_types.py", "toon.py", "level1.py", "level1_set.py", "dormant.py"):
    exec(open(D + f, encoding="utf-8").read())

FACE_CAM = math.radians(30)   # cells face the isometric camera (az -60)
S = BAO_SCALE


def L(x, y):
    """Bao-local (x, y) to world (x, y)."""
    return (x * S, y * S)


def on_head(r, u, f=0.42):
    """A point on Bao's forehead, in the head frame, projected to world (x, y)."""
    p = hp(r, u, f) * S
    return (p.x, p.y)


# clear the previous composition (everything except Bao, cameras, sun, ground)
KEEP = {"Bao", "Bao_Eye_L", "Bao_Eye_R", "BaoMeta", "L1Cam", "L2Cam", "L1Sun", "L1Ground"}
for o in list(bpy.context.scene.objects):
    if o.name not in KEEP:
        bpy.data.objects.remove(o, do_unlink=True)

pillow()
bpy.context.view_layer.update()

# where things live on Bao
BRAIN = [on_head(-0.4, 0.3), on_head(0.0, 0.38), on_head(0.4, 0.3)]
ARM_R = L(1.35, 0.57)
LEG_L = L(-0.78, -1.15)
LEG_R = L(0.78, -1.15)
QUEUE = L(0.03, -0.62)
HEART = L(-0.62, 0.42)
LIVER = L(0.18, -0.12)
QA_AT = L(-0.36, -0.34)

# dormant organs
pavilion((-21.0, 19.5, 0))                                          # Memory, beside the pillow
drum((*HEART, footprint_top(*HEART, 2.0, 1.4) - 0.1))               # Heart, on the chest
hotpot((*LIVER, footprint_top(*LIVER, 3.8, 3.8) - 0.15))            # Liver, on the belly
basket((0.0, -17.0, 0.0))                                           # Stem
stone_path()                                                        # Immune patrol + Skin

# Muscles queue: a bamboo tray of ticket scrolls (one scroll per queued ticket)
qz = footprint_top(*QUEUE, 2.2, 1.4)
place("Muscles_QueueTray", rbox((2.4, 1.4, 0.25), 0.08, 2), mat("Straw", PAL["straw"], 0.9, 0.2),
      (QUEUE[0], QUEUE[1], qz + 0.12), rot=(0, 0, math.radians(-10)))
for i in range(4):
    for nm, r, m in (("Scroll", 0.17, mat("Paper", PAL["paper"], 0.8)), ("Tie", 0.18, mat("Muscles", PAL["muscles"], 0.35))):
        place(f"Muscles_Queue{nm}_{i}", cyl(r, 1.1 if nm == "Scroll" else 0.08), m,
              (QUEUE[0] - 0.75 + i * 0.5, QUEUE[1], qz + 0.42), rot=(math.radians(90), 0, math.radians(-10)))

for i, (x, y, s) in enumerate(((-31, 28, 1), (-13, 33, 2), (20, 32, 3), (-39, 5, 4), (37, 13, 5), (-40, -21, 6))):
    bamboo_cluster(f"Grove{i}", x, y, n=6, h=15, seed=s)
flowers()

# cells, each on its body part, with a contact shadow
cells = [
    ("Cell_Orchestrator", "L1_orch-01", BRAIN[1]),
    ("Cell_Product", "L1_prod-01", BRAIN[0]),
    ("Cell_Architect", "L1_arch-01", BRAIN[2]),
    ("Cell_Developer", "L1_dev-02", ARM_R),
    ("Cell_Scout", "L1_scout-01", LEG_L),
    ("Cell_Developer", "L1_dev-03", LEG_R),
    ("Cell_QA", "L1_qa-01", QA_AT),
    ("Cell_Security", "L1_sec-01", (17.2, -12.6)),
]
for src, name, (x, y) in cells:
    place_cell(src, name, (x, y, footprint_top(x, y, 0.9, 0.9) + 0.02), FACE_CAM)
    contact_shadow(f"Shadow_{name[3:]}", x, y + 0.15)

# Stem: two sleeping cubs curled in the basket
for i, (dx, dy, rz) in enumerate(((-0.7, 0.1, 40), (0.8, -0.2, -30))):
    cub = build_panda(f"L1_Cub{i}", {"eye_open": 0.15}, (dx, -17.0 + dy, 0.35))
    cub.scale = (0.55, 0.55, 0.55); cub.rotation_euler = (0, 0, math.radians(rz))


# nervous system: qi ribbons draped from the Brain on Bao's head to the live Muscles cells
def arc(a, b, lift, n=13):
    a, b = Vector(a), Vector(b); pts = []
    for i in range(n):
        t = i / (n - 1); p = a.lerp(b, t)
        p.z = max(p.z, surface_z(p.x, p.y) + 0.6 + lift * math.sin(math.pi * t))
        pts.append(p)
    return pts


def route(a, via, b, lift):
    """a -> via -> b, each leg draped; ribbons go round the sides of the neck, never over the face."""
    w = Vector((*via, surface_z(*via) + 0.4))
    return arc(a, w, lift)[:-1] + arc(w, b, lift)


def top(p):
    return Vector((*p, surface_z(*p) + 0.4))


qi_material()
brain_l, brain_r = top(BRAIN[0]), top(BRAIN[2])
ribbon("Qi_0", route(brain_r, L(1.05, 1.0), top(ARM_R), 0.6), 0.07)
ribbon("Qi_1", route(brain_r, L(1.0, 0.25), top(LEG_R), 0.6), 0.07)
ribbon("Qi_2", route(brain_l, L(-0.95, 0.35), top(LEG_L), 0.6), 0.07)
bead_at = route(brain_r, L(1.05, 1.0), top(ARM_R), 0.6)[16]
obj_from_bm("Qi_Bead", sphere(0.34, 16, 10), bpy.data.materials["Qi"], None, loc=tuple(bead_at), subsurf=0)

apply_toon(("Bao", "Pillow", "L1_", "Mem_", "Heart_", "Liver_", "Muscles_", "Stem_",
            "Orch_", "Prod_", "Arch_", "Dev_", "Scout_", "Sec_", "QA_"))
make_dormant(("Liver_", "Heart_", "Mem_", "Stem_", "L1_qa-01", "L1_sec-01", "L1_Cub"))

bpy.data.objects["L1Cam"].data.ortho_scale = 64
