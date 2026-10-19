"""Render Levels 1-3 from the plush scene and write screen-space anchors for the UI.

    exec(open(r"D:/claude_sessions/agent_office/design/3d/levels_plush_render.py").read())
    render_all()
"""
import bpy, math, json
from mathutils import Vector, Matrix
from bpy_extras.object_utils import world_to_camera_view

D = r"D:/claude_sessions/agent_office/design/3d/"
for f in ("panda_build.py", "role_types.py", "toon.py", "level1_set.py", "dormant.py", "plush.py", "role_types_plush.py"):
    exec(open(D + f, encoding="utf-8").read())


def _sp(scn, cam, p):
    v = world_to_camera_view(scn, cam, Vector(p)); return [round(v.x * 1440, 1), round((1 - v.y) * 900, 1)]


def _look(cam, target, az_deg, el_deg, dist):
    az, el = math.radians(az_deg), math.radians(el_deg)
    d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    cam.location = target + d * dist
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()


def _saved_slots(prefixes):
    saved = []
    for o in bpy.context.scene.objects:
        if o.name.startswith(prefixes):
            for x in [o] + list(o.children_recursive):
                if x.type == 'MESH':
                    saved.append((x.name, [(s.link, s.material.name if s.material else None) for s in x.material_slots],
                                  x.hide_render))
    return saved


def _restore(saved):
    for n, slots, hid in saved:
        o = bpy.data.objects[n]
        for s, (link, mn) in zip(o.material_slots, slots):
            s.material = bpy.data.materials.get(mn) if mn else None; s.link = link
        o.hide_render = hid


def render_l1(scn):
    cam = bpy.data.objects["L1Cam"]; scn.camera = cam
    scn.render.filepath = D + "renders/l1-plush.png"; bpy.ops.render.render(write_still=True)
    top = lambda n: scn.objects[n].location + Vector((0, 0, 2.7))
    agents = {n[3:]: _sp(scn, cam, top(n)) for n in
             ("L1_orch-01", "L1_prod-01", "L1_arch-01", "L1_dev-02", "L1_scout-01", "L1_dev-03", "L1_qa-01", "L1_sec-01")}
    organs = {
        "brain": _sp(scn, cam, (0, 0.5, 24.5)), "heart": _sp(scn, cam, (-7.7, 1.3, 15.0)),
        "memory": _sp(scn, cam, (-21, 10, 6.5)), "liver": _sp(scn, cam, (0, -13.5, 0.2)),
        "muscles": _sp(scn, cam, (8.5, 1.3, 9.5)), "immune": _sp(scn, cam, (14.5, -13.2, -0.4)),
        "stem": _sp(scn, cam, (-12, -14, -0.4)), "skin": _sp(scn, cam, (-20, -2, 0.1)),
        "queue": _sp(scn, cam, (11.5, -10.5, 1.5)),
    }
    return {"cells": agents, "organs": organs}


def render_l2(scn):
    """Muscles in focus: the right shoulder and both knees; everything else faded."""
    cam = bpy.data.objects["L2Cam"]; cam.data.type = 'ORTHO'
    _look(cam, Vector((0.6, -2.8, 8.0)), -60, 35.264, 120)
    cam.data.ortho_scale = 29; cam.data.shift_x = 0.15; cam.data.clip_end = 3000
    off = ("L1_orch-01", "L1_prod-01", "L1_arch-01")
    saved = _saved_slots(off)
    for o in bpy.context.scene.objects:
        if o.name.startswith(off):
            for c in o.children_recursive:
                if "_Fur" in c.name: c.hide_render = True
    make_dormant(off)
    scn.camera = cam
    scn.render.filepath = D + "renders/l2-plush.png"; bpy.ops.render.render(write_still=True)
    _restore(saved)
    top = lambda n: scn.objects[n].location + Vector((0, 0, 2.7))
    return {n[3:]: _sp(scn, cam, top(n)) for n in ("L1_dev-02", "L1_scout-01", "L1_dev-03")} | \
           {"queue": _sp(scn, cam, (11.5, -10.5, 1.5))}


def render_l3(scn):
    """dev-03, failed: tablet dropped low, milk tea knocked over, a red glow on Bao's knee."""
    src = scn.objects["L1_dev-03"]; at = src.location.copy()
    hidden = [src] + list(src.children_recursive)
    for o in hidden: o.hide_render = True
    bpy.context.window.scene = bpy.data.scenes["Meshy"]
    sad = p_developer((40, 40, 0), name="PCell_DevSad", tablet_tilt=78)
    bpy.data.objects["PCell_DevSad_Tablet"].location.z = -0.32
    bpy.data.objects["PCell_DevSad_Screen"].location.z = -0.32 + 0.022 * math.cos(math.radians(78))
    boba = bpy.data.objects["PCell_DevSad_Boba"]; boba.rotation_euler = (0, math.radians(90), math.radians(-30))
    boba.location = (1.05, -0.6, -0.82)
    for n in ("PCell_DevSad_BobaLid", "PCell_DevSad_Straw"): bpy.data.objects[n].hide_render = True
    bpy.data.materials["Screen"].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.006, 0.009, 0.011, 1)
    import bmesh as _bm
    sp = _bm.new(); _bm.ops.create_circle(sp, cap_ends=True, segments=24, radius=0.35)
    obj_from_bm("PCell_DevSad_Spill", sp, mat("Spill", "#d9b27a", 0.15), sad, loc=(1.35, -0.9, -0.99), scale=(1.3, 0.9, 1), subsurf=0)
    untoon_scene()
    bpy.context.window.scene = scn
    face = math.radians(30)
    place_agent("PCell_DevSad", "L3_dev03", (at.x, at.y, at.z), face)
    p = scn.objects["L3_dev03"]; p.rotation_euler = (math.radians(8), 0, face)   # a little slumped forward
    glow = contact_shadow("L3_Inflame", at.x, at.y + 0.3, 3.0)
    gm = bpy.data.materials.get("AlarmGlow")
    if not gm:
        gm = shadow_material().copy(); gm.name = "AlarmGlow"
        next(n for n in gm.node_tree.nodes if n.type == 'EMISSION').inputs[0].default_value = hex_lin("#c1291b")
    glow.data.materials.clear(); glow.data.materials.append(gm)

    cam = bpy.data.objects["L3Cam"]; cam.data.type = 'PERSP'; cam.data.lens = 34
    cam.data.shift_x = 0; cam.data.shift_y = 0; cam.data.clip_start = 0.05; cam.data.clip_end = 3000
    fwd = Matrix.Rotation(face, 3, 'Z') @ Vector((0, -1, 0)); right = fwd.cross(Vector((0, 0, 1))).normalized()
    c = at + Vector((0, 0, 0.1))                      # at is the plush centre now
    eye = c + fwd * 3.8 + right * 1.5 + Vector((0, 0, 2.4)); look = c + Vector((0, 0, -0.15))
    cam.location = eye; cam.rotation_euler = (look - eye).to_track_quat('-Z', 'Y').to_euler()
    cam.data.dof.use_dof = True; cam.data.dof.focus_object = p; cam.data.dof.aperture_fstop = 2.0
    scn.camera = cam
    scn.render.filepath = D + "renders/l3-plush.png"; bpy.ops.render.render(write_still=True)
    bpy.context.view_layer.update()
    screen = next(c for c in p.children if c.name.startswith("PCell_DevSad_Screen"))
    corners = [_sp(scn, cam, screen.matrix_world @ Vector((cx, cy, 0))) for cx, cy in ((-0.5, 0.5), (0.5, 0.5), (0.5, -0.5), (-0.5, -0.5))]
    head = _sp(scn, cam, p.matrix_world @ Vector((0, 0, 1.25)))
    for o in hidden: o.hide_render = False
    for o in [p] + list(p.children_recursive): o.hide_render = True
    glow.hide_render = True
    return {"screen": corners, "head": head}


def render_all():
    scn = bpy.data.scenes["Level1"]; bpy.context.window.scene = scn
    scn.view_settings.view_transform = 'AgX'; scn.view_settings.look = 'AgX - Medium High Contrast'
    scn.view_settings.exposure = 0.45
    scn.render.film_transparent = False; scn.render.resolution_x = 2400; scn.render.resolution_y = 1500
    scn.eevee.taa_render_samples = 128      # smooths the dithered fur
    out = {"l1": render_l1(scn), "l2": render_l2(scn), "l3": render_l3(scn)}
    scn.camera = bpy.data.objects["L1Cam"]
    json.dump(out, open(D + "renders/anchors-plush.json", "w"), indent=1)
    return out
