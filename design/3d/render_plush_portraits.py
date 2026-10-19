"""Transparent 3/4 portraits of the plush agent types and Bao, for the design system.

Run inside Blender (scene "Meshy" holds the PAgent_* lineup and PlushTest):
    exec(open(r"D:/claude_sessions/agent_office/design/3d/render_plush_portraits.py").read())
    bpy.app.timers.register(render_plush_portraits, first_interval=0.1)   # long: run off the MCP call
Writes renders/portraits-plush/<type>.png and a done.txt marker.
"""
import bpy, math, os
from mathutils import Vector

OUT = r"D:/claude_sessions/agent_office/design/3d/renders/portraits-plush"
ROOTS = {"PlushTest": "mascot", "PCell_Orchestrator": "orchestrator", "PCell_Product": "product",
         "PCell_Architect": "architect", "PCell_Developer": "developer", "PCell_Scout": "scout",
         "PCell_Security": "security", "PCell_QA": "qa"}


def _vis(root, on):
    o = bpy.data.objects.get(root)
    if not o: return
    for x in [o] + list(o.children_recursive):
        x.hide_render = (not on) or x.name.endswith(("BobaLid_hidden",))


def render_plush_portraits():
    scn = bpy.data.scenes["Meshy"]; bpy.context.window.scene = scn
    os.makedirs(OUT, exist_ok=True)
    marker = os.path.join(OUT, "done.txt")
    if os.path.exists(marker): os.remove(marker)
    scn.render.film_transparent = True
    scn.render.resolution_x = scn.render.resolution_y = 800
    scn.eevee.taa_render_samples = 96
    scn.view_settings.view_transform = 'AgX'; scn.view_settings.look = 'AgX - Medium High Contrast'
    scn.view_settings.exposure = 0.45
    cam = bpy.data.objects["MCam"]; cam.data.type = 'ORTHO'; cam.data.ortho_scale = 3.3
    key = bpy.data.objects["MKey"]; fill = bpy.data.objects["MFill"]
    for n in ("DevSad",):
        o = bpy.data.objects.get("PCell_" + n)
        if o: _vis(o.name, False)
    for root in ROOTS: _vis(root, False)
    base = bpy.data.objects.get("PlushBase")
    if base: base.hide_render = True
    for root, fname in ROOTS.items():
        o = bpy.data.objects.get(root)
        if not o: continue
        _vis(root, True)
        c = o.matrix_world.translation + Vector((0.15, 0, 0.15 * o.scale.z))
        az, el = math.radians(-68), math.radians(18)
        d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
        cam.location = c + d * 20; cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
        cam.data.ortho_scale = 3.3 * (o.scale.z / 1.1) if root != "PlushTest" else 2.9
        fill.location = c + Vector((-5, -6, 4)); fill.rotation_euler = (c - fill.location).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = f"{OUT}/{fname}.png"
        bpy.ops.render.render(write_still=True)
        _vis(root, False)
    for root in ROOTS: _vis(root, True)
    open(marker, "w").write("ok")
    return None
