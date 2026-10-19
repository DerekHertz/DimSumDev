"""Agent-type pandas on the plush body: same hats, props and personalities, new fuzzy panda.

Run inside Blender after plush.py and role_types.py (for mat, obj_from_bm, sphere, cyl, dome,
fan, scroll_sheet, solid, PAL):
    exec(open(r"D:/claude_sessions/agent_office/design/3d/role_types_plush.py").read())
    build_plush_lineup()

Props are children of the panda and written in MODEL units (the plush model is 2 units tall,
centred on its origin, facing -Y). Anchors measured on the model:
    head centre (0, -0.02, 0.42), head top z 0.92, face front y -0.47,
    paws resting on the belly at (+-0.62, -0.5, -0.2), belly front y -0.72, sits on z -1.
The plush pose is fixed (paws on belly), so personality comes from hats, held props and
what is set down beside each panda.
"""
import bpy, bmesh, math
from mathutils import Vector

AGENT_SCALE = 1.1          # a sitting agent panda is ~2.2 tall
HC = Vector((0, -0.02, 0.42))


def _band(name, parent, blue, radius=0.64, z=0.42):
    old = bpy.data.objects.get(name)
    if old: bpy.data.objects.remove(old, do_unlink=True)
    bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=0.05, major_segments=48, minor_segments=12)
    band = bpy.context.active_object; band.name = name
    bm = bmesh.new(); bm.from_mesh(band.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y < -0.1], context='VERTS')
    bm.to_mesh(band.data); bm.free()
    band.data.materials.clear(); band.data.materials.append(blue)
    for f in band.data.polygons: f.use_smooth = True
    band.rotation_euler = (math.radians(90), 0, 0); band.location = (0, -0.02, z); band.parent = parent
    return band


def p_orchestrator(at, name="PCell_Orchestrator"):
    """The Abbot: melon-skin cap with a jade knot, folding fan open in its paw."""
    p = plush_panda(name, at, AGENT_SCALE)
    obj_from_bm(f"{name}_Cap", dome(0.6, 0.38), mat("Brain", PAL["brain"], 0.55, 0.4), p,
                loc=(0, -0.02, 0.44), scale=(1.06, 1.0, 0.9))
    obj_from_bm(f"{name}_Knot", sphere(0.08), mat("Jade", PAL["jade"], 0.25), p, loc=(0, -0.02, 0.98), subsurf=0)
    obj_from_bm(f"{name}_Fan", fan(0.5), mat("FanPaper", PAL["brain_zone"], 0.7), p,
                loc=(0.5, -0.66, -0.12), rot=(math.radians(-10), math.radians(-20), math.radians(8)))
    return p


def p_product(at, name="PCell_Product"):
    """The Storyteller: an open scroll of what users want, held out in both paws."""
    p = plush_panda(name, at, AGENT_SCALE)
    obj_from_bm(f"{name}_Scroll", scroll_sheet(1.1, 0.5), mat("Paper", PAL["paper"], 0.8), p,
                loc=(0, -0.86, -0.18), rot=(math.radians(-8), 0, 0), subsurf=1)
    for s in (-1, 1):
        obj_from_bm(f"{name}_Rod_{s}", cyl(0.04, 0.64), mat("Brain", PAL["brain"], 0.5), p,
                    loc=(s * 0.56, -0.84, -0.18), rot=(math.radians(-8), 0, 0), subsurf=0)
    return p


def p_architect(at, name="PCell_Architect"):
    """The Scholar: futou official's hat with long wings, a blueprint roll in one paw."""
    p = plush_panda(name, at, AGENT_SCALE)
    ink = mat("HatInk", PAL["ink"], 0.4, 0.3)
    obj_from_bm(f"{name}_Hat", dome(0.64, 0.12), ink, p, loc=(0, 0.0, 0.42), scale=(1.0, 0.95, 0.95))
    obj_from_bm(f"{name}_HatTop", sphere(0.3), ink, p, loc=(0, 0.12, 0.98), scale=(0.95, 0.8, 0.85))
    for s in (-1, 1):
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        w = obj_from_bm(f"{name}_Wing_{s}", bm, ink, p, loc=(s * 0.62, 0.32, 0.92),
                        scale=(0.62, 0.03, 0.13), rot=(0, math.radians(-s * 10), 0), subsurf=0)
        b = w.modifiers.new("Bevel", 'BEVEL'); b.width = 0.04; b.segments = 3
    obj_from_bm(f"{name}_Plans", cyl(0.11, 1.0), mat("Blueprint", "#9cc3ec", 0.8), p,
                loc=(-0.52, -0.72, -0.1), rot=(math.radians(70), 0, math.radians(-30)), subsurf=0)
    return p


def p_developer(at, name="PCell_Developer", tablet_tilt=62):
    """The Maker: headphones, a tablet held on the belly, milk tea within reach."""
    p = plush_panda(name, at, AGENT_SCALE)
    blue = mat("Muscles", PAL["muscles"], 0.35, 0.2)
    _band(f"{name}_Band", p, blue)
    for s in (-1, 1):
        obj_from_bm(f"{name}_Cup_{s}", cyl(0.2, 0.14), blue, p, loc=(s * 0.64, -0.02, 0.42),
                    rot=(0, math.radians(90), 0), subsurf=2)
    tab = bmesh.new(); bmesh.ops.create_cube(tab, size=1.0)
    t = obj_from_bm(f"{name}_Tablet", tab, mat("TabletShell", PAL["muscles"], 0.4), p,
                    loc=(0, -0.86, -0.18), rot=(math.radians(tablet_tilt), 0, 0), scale=(0.66, 0.44, 0.04), subsurf=0)
    b = t.modifiers.new("Bevel", 'BEVEL'); b.width = 0.02; b.segments = 3
    scr = bmesh.new(); bmesh.ops.create_grid(scr, x_segments=1, y_segments=1, size=0.5)
    a = math.radians(tablet_tilt)
    obj_from_bm(f"{name}_Screen", scr, mat("Screen", "#cfe3f7", 0.15), p,
                loc=(0, -0.86 - 0.022 * math.sin(a), -0.18 + 0.022 * math.cos(a)),
                rot=(a, 0, 0), scale=(0.6, 0.38, 1), subsurf=0)
    obj_from_bm(f"{name}_Boba", cyl(0.17, 0.46, r2=0.13), mat("MilkTea", "#c99a6b", 0.2), p,
                loc=(1.02, -0.55, -0.77), subsurf=0)
    obj_from_bm(f"{name}_BobaLid", dome(0.17, 0.0), mat("Cream", PAL["cream"], 0.3), p,
                loc=(1.02, -0.55, -0.54), scale=(1, 1, 0.45), subsurf=0)
    obj_from_bm(f"{name}_Straw", cyl(0.025, 0.4), blue, p, loc=(1.05, -0.55, -0.38), rot=(0, math.radians(12), 0), subsurf=0)
    return p


def p_scout(at, name="PCell_Scout"):
    """The Wanderer: straw douli hat, a paper lantern on a bamboo stick over its shoulder."""
    p = plush_panda(name, at, AGENT_SCALE)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=64, radius1=0.98, radius2=0.0, depth=0.5)
    obj_from_bm(f"{name}_Hat", bm, mat("Straw", PAL["straw"], 0.9, 0.3), p, loc=(0, -0.05, 1.02),
                rot=(math.radians(-6), 0, 0), subsurf=0)
    obj_from_bm(f"{name}_HatTip", sphere(0.06), mat("Bamboo", PAL["bamboo"], 0.5), p, loc=(0, -0.02, 1.28), subsurf=0)
    obj_from_bm(f"{name}_Stick", cyl(0.028, 1.3), mat("Bamboo", PAL["bamboo"], 0.5), p,
                loc=(0.82, -0.56, 0.2), rot=(0, math.radians(18), 0), subsurf=0)
    obj_from_bm(f"{name}_Lantern", sphere(0.2), mat("LanternPaper", PAL["muscles_zone"], 0.6, 0.3), p,
                loc=(1.12, -0.56, 0.62), scale=(1, 1, 1.2))
    for dz in (0.22, -0.22):
        obj_from_bm(f"{name}_LanternCap_{dz}", cyl(0.09, 0.05), mat("Muscles", PAL["muscles"], 0.35), p,
                    loc=(1.12, -0.56, 0.62 + dz), subsurf=0)
    return p


def p_security(at, name="PCell_Security"):
    """The Gatekeeper: door-god helmet with a plume, a round woven shield on its paw."""
    p = plush_panda(name, at, AGENT_SCALE)
    green = mat("Immune", PAL["immune"], 0.45, 0.3)
    obj_from_bm(f"{name}_Helmet", dome(0.66, 0.14), green, p, loc=(0, -0.02, 0.42), scale=(1.0, 0.94, 0.9))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=0.7, radius2=0.68, depth=0.07)
    obj_from_bm(f"{name}_Brim", bm, mat("ImmuneZone", PAL["immune_zone"], 0.5), p, loc=(0, -0.04, 0.52), subsurf=0)
    obj_from_bm(f"{name}_Knob", sphere(0.08), mat("ImmuneZone", PAL["immune_zone"], 0.5), p, loc=(0, -0.02, 1.04), subsurf=0)
    obj_from_bm(f"{name}_Plume", sphere(0.1), mat("Plume", PAL["cream"], 0.8, 0.6), p,
                loc=(0, 0.14, 1.22), rot=(math.radians(-35), 0, 0), scale=(0.9, 0.9, 2.4))
    sl = (-0.56, -0.82, -0.22)
    obj_from_bm(f"{name}_Shield", cyl(0.44, 0.07), mat("Straw", PAL["straw"], 0.9, 0.3), p,
                loc=sl, rot=(math.radians(82), 0, math.radians(-15)), subsurf=0)
    obj_from_bm(f"{name}_ShieldRing", cyl(0.3, 0.09), green, p, loc=sl, rot=(math.radians(82), 0, math.radians(-15)), subsurf=0)
    obj_from_bm(f"{name}_ShieldBoss", sphere(0.13), mat("ImmuneZone", PAL["immune_zone"], 0.4), p,
                loc=(sl[0] - 0.02, sl[1] - 0.06, sl[2]), scale=(1, 0.7, 1), subsurf=0)
    return p


def p_qa(at, name="PCell_QA"):
    """The Taster: jade tasting bowl and chopsticks, a jade cloth headband."""
    p = plush_panda(name, at, AGENT_SCALE)
    bowl = dome(0.26, 0.0)
    for v in bowl.verts: v.co.z = -v.co.z
    obj_from_bm(f"{name}_Bowl", solid(bowl, 0.02), mat("Liver", PAL["liver"], 0.25), p,
                loc=(-0.36, -0.86, -0.1), scale=(1, 1, 0.75), subsurf=1)
    obj_from_bm(f"{name}_Soup", cyl(0.23, 0.02), mat("Broth", "#d9b27a", 0.3), p, loc=(-0.36, -0.86, -0.13), subsurf=0)
    for dx in (-0.025, 0.025):
        obj_from_bm(f"{name}_Chopstick_{dx}", cyl(0.015, 0.66, r2=0.008), mat("Wood", PAL["wood"], 0.5), p,
                    loc=(0.18 + dx, -0.9, 0.0), rot=(math.radians(20), math.radians(-60), 0), subsurf=0)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=48, radius1=0.6, radius2=0.57, depth=0.12)
    obj_from_bm(f"{name}_Headband", solid(bm, 0.03), mat("LiverZone", PAL["liver_zone"], 0.7), p,
                loc=(0, -0.04, 0.66), rot=(math.radians(-8), 0, 0), subsurf=1)
    return p


PLUSH_TYPES = [p_orchestrator, p_product, p_architect, p_developer, p_scout, p_security, p_qa]


def build_plush_lineup(gap=2.9, y=12.0):
    x0 = -(len(PLUSH_TYPES) - 1) * gap / 2
    return [fn((x0 + i * gap, y, 0)).name for i, fn in enumerate(PLUSH_TYPES)]
