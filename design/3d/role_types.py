"""Cell-type pandas: one body, with personality from pose, expression, and a prop.

Run inside Blender after panda_build.py:
    exec(open(r"D:/claude_sessions/agent_office/design/3d/panda_build.py").read())
    exec(open(r"D:/claude_sessions/agent_office/design/3d/role_types.py").read())
    build_lineup()

Prop colors follow the organ hues in the design system (light theme values).
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix


def hex_lin(h):
    h = h.lstrip("#"); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4) for x in c) + (1,)


def mat(name, hexcol, rough=0.6, sheen=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = hex_lin(hexcol)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Sheen Weight"].default_value = sheen
    return m


PAL = {
    "brain": "#674698", "brain_zone": "#e8dffc",
    "muscles": "#2759a2", "muscles_zone": "#d5e6ff",
    "immune": "#326a2d", "immune_zone": "#d6ecd3",
    "liver": "#006e54", "liver_zone": "#cbeee1",
    "paper": "#f3e7cc", "ink": "#1b1d20", "straw": "#c9a15e", "bamboo": "#6f9a4a",
    "wood": "#7a4e2d", "jade": "#3f9a7f", "cream": "#fbf3df", "boba": "#8a5a3c",
}


def obj_from_bm(name, bm, material, parent, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), subsurf=2, smooth=True):
    old = bpy.data.objects.get(name)
    if old: bpy.data.objects.remove(old, do_unlink=True)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = smooth
    me.materials.append(material)
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    o.location, o.rotation_euler, o.scale = loc, rot, scale
    if subsurf:
        m = o.modifiers.new("Subsurf", 'SUBSURF'); m.levels = m.render_levels = subsurf
    o.parent = parent
    return o


def sphere(r=1.0, u=24, v=16):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r); return bm


def cyl(r=1.0, depth=1.0, seg=24, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=depth)
    return bm


def dome(r=1.0, cut=0.0):
    """Upper part of a sphere (z >= cut*r), open bottom filled."""
    bm = sphere(r, 32, 20)
    geom = [v for v in bm.verts if v.co.z < cut * r - 1e-4]
    bmesh.ops.delete(bm, geom=geom, context='VERTS')
    edges = [e for e in bm.edges if e.is_boundary]
    bmesh.ops.holes_fill(bm, edges=edges, sides=0)
    return bm


def solid(bm, thick):
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=thick)
    return bm


def fan(radius=0.42, spread=150, pleats=14, depth=0.025):
    """A pleated folding fan in the XZ plane, pivot at origin, opening upward."""
    bm = bmesh.new()
    n = pleats * 2
    inner = []; outer = []
    for i in range(n + 1):
        a = math.radians(90 - spread / 2 + spread * i / n)
        y = depth if i % 2 else -depth
        inner.append(bm.verts.new((0.08 * math.cos(a), y * 0.3, 0.08 * math.sin(a))))
        outer.append(bm.verts.new((radius * math.cos(a), y, radius * math.sin(a))))
    for i in range(n):
        bm.faces.new((inner[i], inner[i + 1], outer[i + 1], outer[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return solid(bm, 0.008)


def scroll_sheet(width=0.9, height=0.5, curl=0.06):
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=20, y_segments=6, size=0.5)
    for v in bm.verts:
        x, y = v.co.x * width, v.co.y * height
        v.co = Vector((x, -curl * math.cos(math.pi * x / width) , y))
    return solid(bm, 0.01)


def lineup_positions(n, gap=2.8, y=12.0):
    x0 = -(n - 1) * gap / 2
    return [(x0 + i * gap, y, 0) for i in range(n)]


# ── the five current genomes ─────────────────────────────────────────

def orchestrator(at):
    """The Abbot: calm, content squint, conducts with a folding fan."""
    p = build_panda("Cell_Orchestrator", {
        "crown": False,
        "arm_R": ((0.6, -0.05, 1.05), (0.72, -0.5, 1.3), 0.2, 0.17),
        "eye_open": 0.3,
    }, at)
    obj_from_bm("Orch_Fan", fan(), mat("FanPaper", PAL["brain_zone"], 0.7), p,
                loc=(0.74, -0.62, 1.38), rot=(math.radians(-15), math.radians(-25), 0))
    obj_from_bm("Orch_FanRibs", fan(0.43, pleats=14, depth=0.026), mat("Brain", PAL["brain"], 0.5), p,
                loc=(0.74, -0.62, 1.38), rot=(math.radians(-15), math.radians(-25), 0),
                scale=(1, 1.3, 1), subsurf=0).hide_render = True
    # 瓜皮帽 melon-skin cap with a knot button
    obj_from_bm("Orch_Cap", dome(0.6, 0.35), mat("Brain", PAL["brain"], 0.55, 0.3), p,
                loc=(0, -0.08, 1.49), scale=(1.03, 0.95, 0.92))
    obj_from_bm("Orch_Knot", sphere(0.07), mat("Jade", PAL["jade"], 0.2), p, loc=(0, -0.08, 2.03), subsurf=0)
    return p


def product(at):
    """The Storyteller: wide-eyed and curious, reads out the scroll of what users want."""
    p = build_panda("Cell_Product", {
        "arm_L": ((0.6, -0.05, 1.0), (0.5, -0.72, 0.95), 0.2, 0.17),
        "arm_R": ((0.6, -0.05, 1.0), (0.5, -0.72, 0.95), 0.2, 0.17),
        "head": (0.0, -0.12, 1.52),
        "eye_open": 1.15,
    }, at)
    obj_from_bm("Prod_Scroll", scroll_sheet(0.95, 0.46), mat("Paper", PAL["paper"], 0.8), p,
                loc=(0, -0.93, 0.98), rot=(math.radians(-12), 0, 0), subsurf=1)
    for s in (-1, 1):
        obj_from_bm(f"Prod_Rod_{s}", cyl(0.035, 0.6), mat("Brain", PAL["brain"], 0.5), p,
                    loc=(s * 0.48, -0.9, 0.98), rot=(math.radians(-12), 0, 0), subsurf=0)
    return p


def architect(at):
    """The Scholar: serious half-lidded gaze, 幞头 official's hat, blueprint under the arm."""
    p = build_panda("Cell_Architect", {
        "crown": False,
        "arm_L": ((0.6, -0.05, 1.02), (0.55, -0.5, 0.7), 0.2, 0.17),
        "eye_open": 0.55,
    }, at)
    ink = mat("HatInk", PAL["ink"], 0.35, 0.2)
    obj_from_bm("Arch_Hat", dome(0.66, 0.1), ink, p, loc=(0, -0.08, 1.5), scale=(1.0, 0.92, 0.95))
    obj_from_bm("Arch_HatTop", sphere(0.3), ink, p, loc=(0, 0.1, 2.02), scale=(0.95, 0.8, 0.9))
    for s in (-1, 1):  # the long flat wings, fixed to the back of the crown
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        w = obj_from_bm(f"Arch_Wing_{s}", bm, ink, p, loc=(s * 0.6, 0.32, 2.0),
                        scale=(0.62, 0.03, 0.13), rot=(0, math.radians(-s * 10), 0), subsurf=0)
        b = w.modifiers.new("Bevel", 'BEVEL'); b.width = 0.04; b.segments = 3
    obj_from_bm("Arch_Plans", cyl(0.11, 1.1), mat("Blueprint", "#9cc3ec", 0.8), p,
                loc=(-0.62, -0.72, 0.78), rot=(math.radians(80), 0, math.radians(-35)), subsurf=0)
    for dz in (-0.55, 0.55):  # jade end caps on the roll
        obj_from_bm(f"Arch_PlansCap_{dz}", cyl(0.12, 0.04), mat("Brain", PAL["brain"], 0.5), p,
                    loc=Vector((-0.62, -0.72, 0.78)) + Matrix.Rotation(math.radians(-35), 3, 'Z') @ Matrix.Rotation(math.radians(80), 3, 'X') @ Vector((0, 0, dz)),
                    rot=(math.radians(80), 0, math.radians(-35)), subsurf=0)
    return p


def developer(at):
    """The Maker: focused squint, headphones on, tablet in paw, boba within reach."""
    p = build_panda("Cell_Developer", {
        "arm_L": ((0.6, -0.05, 1.0), (0.42, -0.72, 0.78), 0.2, 0.17),
        "arm_R": ((0.6, -0.05, 1.0), (0.42, -0.72, 0.78), 0.2, 0.17),
        "head": (0.0, -0.14, 1.47),
        "eye_open": 0.45,
    }, at)
    blue = mat("Muscles", PAL["muscles"], 0.35, 0.1)
    # headband: a half torus over the head
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=False, radius=0.66, segments=32)
    bm2 = bmesh.new()
    old = bpy.data.objects.get("Dev_Band")
    if old: bpy.data.objects.remove(old, do_unlink=True)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.64, minor_radius=0.045, major_segments=48, minor_segments=12,
                                     location=(0, 0, 0))
    band = bpy.context.active_object; band.name = "Dev_Band"
    bmb = bmesh.new(); bmb.from_mesh(band.data)
    bmesh.ops.delete(bmb, geom=[v for v in bmb.verts if v.co.y < -0.08], context='VERTS')
    bmb.to_mesh(band.data); bmb.free()
    band.data.materials.append(blue)
    for f in band.data.polygons: f.use_smooth = True
    band.rotation_euler = (math.radians(90), 0, 0)
    band.location = (0, -0.1, 1.5); band.parent = p
    bm.free(); bm2.free()
    for s in (-1, 1):
        obj_from_bm(f"Dev_Cup_{s}", cyl(0.17, 0.12), blue, p, loc=(s * 0.64, -0.12, 1.47),
                    rot=(0, math.radians(90), 0), subsurf=2)
    tab = bmesh.new(); bmesh.ops.create_cube(tab, size=1.0)
    t = obj_from_bm("Dev_Tablet", tab, mat("TabletShell", PAL["muscles"], 0.4), p,
                    loc=(0, -0.92, 0.9), rot=(math.radians(-55), 0, 0), scale=(0.62, 0.04, 0.44), subsurf=0)
    b = t.modifiers.new("Bevel", 'BEVEL'); b.width = 0.02; b.segments = 3
    scr = bmesh.new(); bmesh.ops.create_cube(scr, size=1.0)
    obj_from_bm("Dev_Screen", scr, mat("Screen", "#cfe3f7", 0.15), p,
                loc=(0, -0.95, 0.915), rot=(math.radians(-55), 0, 0), scale=(0.54, 0.01, 0.36), subsurf=0)
    obj_from_bm("Dev_Boba", cyl(0.17, 0.46, r2=0.13), mat("MilkTea", "#c99a6b", 0.2), p,
                loc=(1.0, -0.62, 0.23), subsurf=0)
    obj_from_bm("Dev_BobaLid", dome(0.17, 0.0), mat("Cream", PAL["cream"], 0.3), p,
                loc=(1.0, -0.62, 0.46), scale=(1, 1, 0.45), subsurf=0)
    obj_from_bm("Dev_Straw", cyl(0.025, 0.4), mat("Muscles", PAL["muscles"], 0.35), p,
                loc=(1.03, -0.62, 0.62), rot=(0, math.radians(12), 0), subsurf=0)
    return p


def scout(at):
    """The Wanderer: bright-eyed, 斗笠 straw hat, lantern held high to look ahead."""
    p = build_panda("Cell_Scout", {
        "crown": False,
        "arm_R": ((0.6, -0.05, 1.05), (0.85, -0.35, 1.45), 0.2, 0.17),
        "eye_open": 1.2,
    }, at)
    straw = mat("Straw", PAL["straw"], 0.9, 0.2)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=64, radius1=0.9, radius2=0.0, depth=0.55)
    obj_from_bm("Scout_Hat", bm, straw, p, loc=(0, -0.1, 2.02), rot=(math.radians(-8), 0, 0), subsurf=0)
    obj_from_bm("Scout_HatTip", sphere(0.05), mat("Bamboo", PAL["bamboo"], 0.5), p,
                loc=(0, -0.06, 2.3), subsurf=0)
    obj_from_bm("Scout_Stick", cyl(0.025, 0.8), mat("Bamboo", PAL["bamboo"], 0.5), p,
                loc=(0.95, -0.4, 1.8), rot=(0, math.radians(35), 0), subsurf=0)
    # paper lantern hanging from the stick tip, with wooden caps
    obj_from_bm("Scout_Lantern", sphere(0.2), mat("LanternPaper", PAL["muscles_zone"], 0.6), p,
                loc=(1.22, -0.4, 1.86), scale=(1, 1, 1.2))
    for dz in (0.22, -0.22):
        obj_from_bm(f"Scout_LanternCap_{dz}", cyl(0.09, 0.05), mat("Muscles", PAL["muscles"], 0.35), p,
                    loc=(1.22, -0.4, 1.86 + dz), subsurf=0)
    return p


def security(at):
    """The Gatekeeper: stern, door-god helmet with a plume, round woven bamboo shield."""
    p = build_panda("Cell_Security", {
        "crown": False,
        "arm_L": ((0.6, -0.05, 1.0), (0.66, -0.58, 0.82), 0.2, 0.17),
        "eye_open": 0.6,
    }, at)
    green = mat("Immune", PAL["immune"], 0.4, 0.2)
    obj_from_bm("Sec_Helmet", dome(0.67, 0.12), green, p, loc=(0, -0.08, 1.46), scale=(1.0, 0.93, 0.9))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=0.68, radius2=0.66, depth=0.07)
    obj_from_bm("Sec_Brim", bm, mat("ImmuneZone", PAL["immune_zone"], 0.5), p, loc=(0, -0.1, 1.55),
                rot=(math.radians(-8), 0, 0), subsurf=0)
    obj_from_bm("Sec_Knob", sphere(0.08), mat("ImmuneZone", PAL["immune_zone"], 0.5), p, loc=(0, -0.05, 2.08), subsurf=0)
    obj_from_bm("Sec_Plume", sphere(0.1), mat("Plume", PAL["cream"], 0.8, 0.5), p,
                loc=(0, 0.12, 2.25), rot=(math.radians(-35), 0, 0), scale=(0.9, 0.9, 2.4))
    # round woven shield on the left arm, facing out
    shield_loc = (-0.78, -0.78, 0.86)
    obj_from_bm("Sec_Shield", cyl(0.44, 0.07), mat("Straw", PAL["straw"], 0.9, 0.2), p,
                loc=shield_loc, rot=(math.radians(80), 0, math.radians(-25)), subsurf=0)
    obj_from_bm("Sec_ShieldRing", cyl(0.3, 0.09), green, p,
                loc=shield_loc, rot=(math.radians(80), 0, math.radians(-25)), subsurf=0)
    obj_from_bm("Sec_ShieldBoss", sphere(0.13), mat("ImmuneZone", PAL["immune_zone"], 0.4), p,
                loc=Vector(shield_loc) + Vector((-0.02, -0.06, 0.0)), scale=(1, 0.7, 1), subsurf=0)
    return p


def qa(at):
    """The Taster: tries every dish before it ships; eyes shut, savoring (or wincing)."""
    p = build_panda("Cell_QA", {
        "arm_R": ((0.6, -0.05, 1.02), (0.5, -0.7, 1.02), 0.2, 0.17),
        "arm_L": ((0.6, -0.05, 1.0), (0.34, -0.74, 0.84), 0.2, 0.17),
        "eye_open": 0.3,
    }, at)
    jade = mat("Liver", PAL["liver"], 0.25, 0.1)
    bowl = dome(0.26, 0.0)
    for v in bowl.verts: v.co.z = -v.co.z
    obj_from_bm("QA_Bowl", solid(bowl, 0.02), jade, p, loc=(-0.3, -0.98, 0.98), scale=(1, 1, 0.75), subsurf=1)
    obj_from_bm("QA_Soup", cyl(0.23, 0.02), mat("Broth", "#d9b27a", 0.3), p, loc=(-0.3, -0.98, 0.95), subsurf=0)
    for dx in (-0.025, 0.025):
        obj_from_bm(f"QA_Chopstick_{dx}", cyl(0.014, 0.62, r2=0.008), mat("Wood", PAL["wood"], 0.5), p,
                    loc=(0.36 + dx, -0.98, 1.16), rot=(math.radians(25), math.radians(-60), 0), subsurf=0)
    # a folded cloth headband 头巾 in jade
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=48, radius1=0.63, radius2=0.6, depth=0.11)
    obj_from_bm("QA_Headband", solid(bm, 0.03), mat("LiverZone", PAL["liver_zone"], 0.7), p,
                loc=(0, -0.1, 1.72), rot=(math.radians(-10), 0, 0), subsurf=1)
    return p


CELL_TYPES = [orchestrator, product, architect, developer, scout, security, qa]


def build_lineup():
    made = []
    for fn, at in zip(CELL_TYPES, lineup_positions(len(CELL_TYPES))):
        made.append(fn(at).name)
    return made
