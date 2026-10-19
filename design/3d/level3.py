"""Level 3: over dev-03's shoulder. dev-03 has failed tests and sits slumped on Bao's right leg.

    exec(open(r"D:/claude_sessions/agent_office/design/3d/level3.py").read())
    build_level3()

Needs level1_compose.py to have run (the organism scene). Adds a slumped dev-03,
an inflammation glow on Bao under it, and a perspective camera behind its
shoulder. Writes renders/l3-dev03-3d.png and the tablet screen's corners in
screen space (renders/l3-anchors.json) so the DOM terminal can be mapped onto it.
"""
import bpy, bmesh, math, json
from mathutils import Vector, Matrix
from bpy_extras.object_utils import world_to_camera_view

D = r"D:/claude_sessions/agent_office/design/3d/"
for f in ("panda_build.py", "role_types.py", "toon.py", "level1.py", "level1_set.py"):
    exec(open(D + f, encoding="utf-8").read())

SLUMP = {
    "head": (0.0, -0.22, 1.4),                                    # head dropped and forward
    "arm_L": ((0.6, -0.05, 0.96), (0.32, -0.66, 0.6), 0.2, 0.17),  # paws in the lap
    "arm_R": ((0.6, -0.05, 0.96), (0.32, -0.66, 0.6), 0.2, 0.17),
    "eye_open": 0.35,                                             # sad squint
}


def dev_slumped(name, at, rot_z):
    p = build_panda(name, SLUMP, at)
    blue = mat("Muscles", PAL["muscles"], 0.35, 0.1)
    hx, hy, hz = SLUMP["head"]
    # headphones, following the dropped head
    old = bpy.data.objects.get(name + "_Band")
    if old: bpy.data.objects.remove(old, do_unlink=True)
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=False, radius=0.64, segments=48)
    ring = bmesh.new()
    me = bpy.data.meshes.new(name + "_Band")
    bpy.ops.mesh.primitive_torus_add(major_radius=0.64, minor_radius=0.045, major_segments=48, minor_segments=12)
    band = bpy.context.active_object; band.name = name + "_Band"
    bmb = bmesh.new(); bmb.from_mesh(band.data)
    bmesh.ops.delete(bmb, geom=[v for v in bmb.verts if v.co.y < -0.08], context='VERTS')
    bmb.to_mesh(band.data); bmb.free(); bm.free(); ring.free()
    band.data.materials.append(blue)
    for f_ in band.data.polygons: f_.use_smooth = True
    band.rotation_euler = (math.radians(80), 0, 0); band.location = (0, hy + 0.02, hz); band.parent = p
    for s in (-1, 1):
        obj_from_bm(f"{name}_Cup_{s}", cyl(0.17, 0.12), blue, p, loc=(s * 0.64, hy, hz - 0.03),
                    rot=(0, math.radians(90), 0), subsurf=2)
    # tablet lowered into the lap, screen facing up toward the camera over the shoulder
    tab = bmesh.new(); bmesh.ops.create_cube(tab, size=1.0)
    t = obj_from_bm(f"{name}_Tablet", tab, mat("TabletShell", PAL["muscles"], 0.4), p,
                    loc=(0, -0.9, 0.7), rot=(math.radians(40), 0, 0), scale=(0.66, 0.44, 0.04), subsurf=0)
    b = t.modifiers.new("Bevel", 'BEVEL'); b.width = 0.02; b.segments = 3
    scr = bmesh.new()
    bmesh.ops.create_grid(scr, x_segments=1, y_segments=1, size=0.5)
    screen = obj_from_bm(f"{name}_Screen", scr, mat("TerminalScreen", "#11161a", 0.2), p,
                         loc=(0, -0.9 - 0.022 * math.sin(math.radians(40)), 0.7 + 0.022 * math.cos(math.radians(40))),
                         rot=(math.radians(40), 0, 0), scale=(0.6, 0.38, 1), subsurf=0)
    # milk tea knocked over, a small spill
    obj_from_bm(f"{name}_Boba", cyl(0.17, 0.46, r2=0.13), mat("MilkTea", "#c99a6b", 0.2), p,
                loc=(0.98, -0.62, 0.2), rot=(0, math.radians(90), math.radians(-30)), subsurf=0)
    spill = bmesh.new(); bmesh.ops.create_circle(spill, cap_ends=True, segments=24, radius=0.35)
    obj_from_bm(f"{name}_Spill", spill, mat("Spill", "#d9b27a", 0.15), p,
                loc=(1.3, -0.95, 0.03), scale=(1.3, 0.9, 1), subsurf=0)
    p.rotation_euler = (0, 0, rot_z)
    return p, screen


def alarm_glow(name, x, y, r=3.2):
    """Inflammation: a warm alarm-red glow spread on Bao under the failed cell."""
    m = bpy.data.materials.get("AlarmGlow")
    if not m:
        m = shadow_material().copy(); m.name = "AlarmGlow"
        em = next(n for n in m.node_tree.nodes if n.type == 'EMISSION')
        em.inputs[0].default_value = hex_lin("#c1291b")
    o = contact_shadow(name, x, y, r)
    o.data.materials.clear(); o.data.materials.append(m)
    return o


def build_level3():
    scn = bpy.context.scene
    src = scn.objects["L1_dev-03"]
    at = src.location.copy()
    for o in [src] + list(src.children_recursive): o.hide_render = True
    face = math.radians(18)                # facing down the leg; Bao's belly and head rise behind it
    p, screen = dev_slumped("L3_dev03", at, face)
    alarm_glow("L3_Inflame", at.x, at.y + 0.4)
    apply_toon(("L3_",))

    cam = bpy.data.objects.get("L3Cam")
    if not cam:
        cam = bpy.data.objects.new("L3Cam", bpy.data.cameras.new("L3Cam")); scn.collection.objects.link(cam)
    cam.data.type = 'PERSP'; cam.data.lens = 28; cam.data.clip_start = 0.05; cam.data.clip_end = 2000
    cam.data.shift_x = 0.0; cam.data.shift_y = 0.0
    fwd = Matrix.Rotation(face, 3, 'Z') @ Vector((0, -1, 0))      # the way dev-03 faces
    right = fwd.cross(Vector((0, 0, 1))).normalized()
    # third person, front three-quarter and a little above: the face, the tablet in its lap,
    # and Bao's body towering behind for scale
    eye = at + fwd * 4.0 + right * 1.8 + Vector((0, 0, 4.0))
    look = at + Vector((0, 0, 1.25)) - fwd * 0.4
    cam.location = eye
    cam.rotation_euler = (look - eye).to_track_quat('-Z', 'Y').to_euler()
    cam.data.dof.use_dof = True
    cam.data.dof.focus_object = p
    cam.data.dof.aperture_fstop = 2.2
    bg = scn.world.node_tree.nodes["Background"]
    world_prev = tuple(bg.inputs[0].default_value)
    bg.inputs[0].default_value = hex_lin("#e3ecd6")          # misty grove sky
    prev = scn.camera; scn.camera = cam
    scn.render.resolution_x = 2400; scn.render.resolution_y = 1500
    scn.render.filepath = D + "renders/l3-dev03-3d.png"
    bpy.ops.render.render(write_still=True)

    bpy.context.view_layer.update()
    corners = []
    for cx, cy in ((-0.5, 0.5), (0.5, 0.5), (0.5, -0.5), (-0.5, -0.5)):   # TL, TR, BR, BL of the screen quad
        w = screen.matrix_world @ Vector((cx, cy, 0))
        v = world_to_camera_view(scn, cam, w)
        corners.append([round(v.x * 1440, 1), round((1 - v.y) * 900, 1)])
    head = world_to_camera_view(scn, cam, p.matrix_world @ Vector((0, -0.2, 2.2)))
    out = {"screen": corners, "head": [round(head.x * 1440), round((1 - head.y) * 900)]}
    json.dump(out, open(D + "renders/l3-anchors.json", "w"), indent=1)

    scn.camera = prev
    bg.inputs[0].default_value = world_prev
    for o in [src] + list(src.children_recursive): o.hide_render = False
    for o in [p] + list(p.children_recursive): o.hide_render = True
    bpy.data.objects["L3_Inflame"].hide_render = True
    return out
