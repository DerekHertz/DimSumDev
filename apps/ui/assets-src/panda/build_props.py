# Ticket 07 (spec.md "Export": "Props and hats are separate assets attached to sockets by name").
# Builds the three Brain-type habit props as small standalone meshes, each in its socket's local
# space (object origin (0,0,0) is the socket, at the paw's centre, so a runtime attach with an
# identity transform under the paw_L/paw_R/hat socket node puts it in the paw). Run inside
# Blender from the Python console or the Blender MCP:
#   exec(open(r"<repo>/apps/ui/assets-src/panda/build_props.py").read(), {"PANDA_SRC": r"<repo>/apps/ui/assets-src/panda"})
# Writes apps/ui/public/models/props/{fan,scroll,blueprint}.glb.
import bpy
import bmesh
import colorsys
import math
import os

SRC = globals().get("PANDA_SRC") or os.path.dirname(globals().get("__file__", ""))
OUT_DIR = os.path.normpath(os.path.join(SRC, "..", "..", "public", "models", "props"))
SCENE = "PropAssets"

# Design bounce (ticket 07, MEDIUM): the design system artifact's agent-types.md (not checked into
# this repo; see handoffs/07-designer-1.md) says a agent type's personality comes from a hat and held
# prop "in its team hue". Orchestrator/product/architect are all Brain (team-pass = wisteria, the
# artifact's tokens.json #674698 light / #c3a5f9 dark, hue ~264deg). The three props stay in that
# hue family, varied by lightness/saturation for shape-driven distinguishability rather than by
# swapping to unrelated narrative colours.
WISTERIA_HUE = 264 / 360


def wisteria(lightness, saturation):
    return colorsys.hls_to_rgb(WISTERIA_HUE, lightness, saturation)


# Where the props sit (ticket 07, design bounces 1 and 2). The socket is at the centre of the paw,
# and the paw is a ball of radius PAW_RADIUS around it (arm tail thickness 0.38), so anything within
# PAW_RADIUS of the object origin is buried in the fist. Each prop's grip point sits on the paw
# surface and its body extends out of it.
#
# Axes, in Blender's frame here (the glb export turns Blender +Z into glTF +Y, and Blender -Y into
# glTF +Z). Under the paw sockets:
#   Blender +Z (glTF +Y): out past the paw tip, along the forearm, toward the camera.
#   Blender -Y (glTF +Z): up (world up at rest, mostly up in every habit pose).
#   Blender  X (glTF  X): across the paw (world -X at rest).
# apps/ui/src/assets/prop-placement.test.mjs checks the exported result in world space.
PAW_RADIUS = 0.19
FAN_HINGE = 0.18                 # fan hinge, out past the paw tip, on the paw surface
FAN_RADIUS = 0.26                # fan blade radius (designer target 0.24 to 0.28)
SCROLL_RADIUS = 0.045
SCROLL_CENTRE = PAW_RADIUS + 0.05  # the whole rod clears the paw
BLUEPRINT_OUT = 0.17             # sheet plane, just in front of the paw
BLUEPRINT_LIFT = 0.12            # sheet's bottom edge above the paw centre
BLUEPRINT_W, BLUEPRINT_H = 0.20, 0.26


def ensure_scene():
    sc = bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)
    bpy.context.window.scene = sc
    for o in list(sc.objects):
        sc.collection.objects.unlink(o)
    return sc


def new_object(name, bm, color):
    mesh = bpy.data.meshes.get(name) or bpy.data.meshes.new(name)
    if mesh.vertices:
        mesh.clear_geometry()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.get(name) or bpy.data.objects.new(name, mesh)
    if obj.name not in bpy.context.scene.collection.objects:
        bpy.context.scene.collection.objects.link(obj)
    mat = bpy.data.materials.get(name + "Mat") or bpy.data.materials.new(name + "Mat")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*color, 1.0)
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6
    mesh.materials.clear()
    mesh.materials.append(mat)
    return obj


def make_fan():
    """A folding fan, open: a pie-wedge held closed-edge-first at the paw (paw_R). Wisteria (team
    Brain hue, agent-types.md), a mid lightness so it reads distinctly from the scroll and blueprint.

    The wedge stands upright with its face to the camera (its thin solidify axis on Blender Z, which
    is world depth). The hinge sits on the paw surface, FAN_HINGE out past the paw tip, and the
    blade rises from it (Blender -Y, up) with a radius of FAN_RADIUS, leaning slightly toward the
    camera. Design bounce 2: the old 0.16 blade hung below a hinge at the paw centre, all inside it.
    """
    bm = bmesh.new()
    radius, angle_deg, segs, thickness = FAN_RADIUS, 110, 10, 0.012
    hinge = bm.verts.new((0, 0, FAN_HINGE))
    arc = []
    start = -angle_deg / 2
    for i in range(segs + 1):
        a = math.radians(start + angle_deg * i / segs)
        arc.append(bm.verts.new((radius * math.sin(a), -radius * math.cos(a), FAN_HINGE + radius * math.cos(a) * 0.15)))
    for i in range(segs):
        bm.faces.new((hinge, arc[i], arc[i + 1]))
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=thickness)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_object("Prop_Fan", bm, wisteria(0.42, 0.45))


def make_scroll():
    """A rolled scroll, held horizontally in the paw (paw_L). Wisteria (Pass team hue), lighter
    than the fan and blueprint so the three read as distinct at a glance.

    Its length runs across the paw (Blender X), perpendicular to the forearm, and it lies just past
    the paw tip (centre SCROLL_CENTRE out along Blender Z), so the whole rod clears the paw.
    """
    from mathutils import Matrix
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=True, segments=16,
                           radius1=SCROLL_RADIUS, radius2=SCROLL_RADIUS, depth=0.30, matrix=Matrix.Identity(4))
    for v in bm.verts:
        v.co = (v.co.z, v.co.y, v.co.x + SCROLL_CENTRE)  # cone's length axis onto Blender X
    return new_object("Prop_Scroll", bm, wisteria(0.66, 0.42))


def make_blueprint():
    """An unrolled blueprint sheet, held in the left paw (paw_L is the attach socket) and steadied
    with both arms as build_clips.py's blueprint_unroll plays. Wisteria (Pass team hue), darker
    than the fan and scroll so the three read as distinct at a glance.

    The sheet stands up facing the camera (thin on Blender Z, world depth), just in front of the
    paw (BLUEPRINT_OUT), and rises from its bottom edge, which the paw holds (BLUEPRINT_LIFT above
    the paw centre). Design bounce 2: the old sheet lay flat, edge-on, centred in the paw.
    """
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= BLUEPRINT_W
        v.co.y = -(BLUEPRINT_LIFT + (v.co.y + 0.5) * BLUEPRINT_H)  # Blender -Y is up
        v.co.z = v.co.z * 0.012 + BLUEPRINT_OUT
    return new_object("Prop_Blueprint", bm, wisteria(0.28, 0.50))


def export_one(obj):
    sc = bpy.context.scene
    for o in sc.objects:
        o.select_set(o is obj)
    bpy.context.view_layer.objects.active = obj
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, obj.name.replace("Prop_", "").lower() + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, use_active_scene=True,
        export_yup=True, export_image_format="AUTO",
    )
    return path


def run():
    ensure_scene()
    objs = [make_fan(), make_scroll(), make_blueprint()]
    paths = [export_one(o) for o in objs]
    return {o.name: os.path.getsize(p) for o, p in zip(objs, paths)}


RESULT = run()
