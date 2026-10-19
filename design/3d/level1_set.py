"""Level 1 set dressing: pillow, organ workstations, grove, qi ribbons, and placed cells.

Run inside Blender after panda_build.py, role_types.py, toon.py and level1.py
(uses mat(), obj_from_bm(), sphere(), cyl(), dome(), solid(), hex_lin(), PAL).
"""
import bpy, bmesh, math, random
from mathutils import Vector, Matrix


def rbox(size, bevel=0.3, segs=4):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bmesh.ops.bevel(bm, geom=bm.verts[:] + bm.edges[:], offset=bevel, segments=segs, affect='EDGES')
    return bm


def place(name, bm, material, loc, rot=(0, 0, 0), scale=(1, 1, 1), subsurf=0):
    return obj_from_bm(name, bm, material, None, loc=loc, rot=rot, scale=scale, subsurf=subsurf)


def surface_z(x, y, default=0.0, only=("Bao", "Pillow")):
    """Top of Bao or the pillow under (x, y); the ground (0) elsewhere. Props are ignored."""
    bpy.context.view_layer.update()
    best = default
    for name in only:
        o = bpy.data.objects.get(name)
        if not o: continue
        inv = o.matrix_world.inverted()
        ok, loc, *_ = o.ray_cast(inv @ Vector((x, y, 200)), (inv.to_3x3() @ Vector((0, 0, -1))).normalized())
        if ok: best = max(best, (o.matrix_world @ loc).z)
    return best


def pillow():
    # a puffy cushion: a squashed sphere reads as soft; a bevelled box read as a sheet
    o = place("Pillow", sphere(1.0, 48, 24), mat("PillowCloth", "#f1e6cf", 0.8, 0.4), (0.5, 14.4, 0.6),
              scale=(9.5, 5.2, 2.6), subsurf=1)
    return o


def rug(name, loc, w, d, hexcol, rot_z=0.0, lift=0.08):
    """A woven mat that marks a workstation, draped over whatever it lies on.

    Every vertex is dropped onto Bao / the pillow, so the mat follows the curve
    of the belly instead of cutting through it (or through a cell standing on it).
    """
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=14, y_segments=14, size=0.5)
    rot = Matrix.Rotation(rot_z, 3, 'Z')
    hc = surface_z(loc[0], loc[1])
    for v in bm.verts:
        p = rot @ Vector((v.co.x * w, v.co.y * d, 0)) + Vector((loc[0], loc[1], 0))
        # drape, but a mat edge never hangs more than a short fold below its centre
        v.co = Vector((p.x, p.y, max(surface_z(p.x, p.y), hc - 0.9) + lift))
    solid(bm, 0.1)
    return place(name, bm, mat(f"Rug{hexcol}", hexcol, 0.9), (0, 0, 0))


def footprint_top(x, y, w, d, rot_z=0.0):
    """Highest surface under a w x d footprint: furniture stands on this, never sinks."""
    rot = Matrix.Rotation(rot_z, 3, 'Z'); top = 0.0
    for fx in (-0.5, 0, 0.5):
        for fy in (-0.5, 0, 0.5):
            p = rot @ Vector((fx * w, fy * d, 0))
            top = max(top, surface_z(x + p.x, y + p.y))
    return top


def low_desk(name, loc, rot_z=0.0):
    x, y, z = loc
    wood = mat("Wood", PAL["wood"], 0.5)
    place(name, rbox((2.6, 1.3, 0.18), 0.08, 2), wood, (x, y, z + 0.75), rot=(0, 0, rot_z))
    for sx in (-1, 1):
        for sy in (-1, 1):
            off = Matrix.Rotation(rot_z, 3, 'Z') @ Vector((sx * 1.1, sy * 0.5, 0))
            place(f"{name}_Leg_{sx}{sy}", cyl(0.08, 0.7), wood, (x + off.x, y + off.y, z + 0.35))
    for i in range(3):
        off = Matrix.Rotation(rot_z, 3, 'Z') @ Vector((-0.7 + i * 0.7, 0, 0))
        place(f"{name}_Scroll_{i}", cyl(0.14, 0.9), mat("Paper", PAL["paper"], 0.8),
              (x + off.x, y + off.y, z + 0.98), rot=(math.radians(90), 0, rot_z))


def hotpot(loc):
    x, y, z = loc
    wood = mat("Wood", PAL["wood"], 0.5)
    place("Liver_Table", cyl(1.9, 0.25), wood, (x, y, z + 0.8))
    for i in range(4):
        a = math.radians(45 + 90 * i)
        place(f"Liver_TableLeg_{i}", cyl(0.12, 0.7), wood, (x + 1.3 * math.cos(a), y + 1.3 * math.sin(a), z + 0.35))
    pot = dome(0.9, 0.0)
    for v in pot.verts: v.co.z = -v.co.z
    place("Liver_Pot", solid(pot, 0.06), mat("Liver", PAL["liver"], 0.25), (x, y, z + 1.55), scale=(1, 1, 0.7), subsurf=1)
    place("Liver_Broth", cyl(0.84, 0.05), mat("Broth", "#d9b27a", 0.3), (x, y, z + 1.5))
    for i in range(6):
        a = math.radians(i * 60 + 15)
        place(f"Liver_Dish_{i}", cyl(0.28, 0.1), mat("Cream", PAL["cream"], 0.3),
              (x + 1.45 * math.cos(a), y + 1.45 * math.sin(a), z + 0.98))


def drum(loc):
    x, y, z = loc
    place("Heart_Drum", cyl(1.0, 1.1), mat("Heart", "#91355a", 0.4), (x, y, z + 1.3), rot=(math.radians(90), 0, 0))
    for dy in (-0.57, 0.57):
        place(f"Heart_DrumHead_{dy}", cyl(0.95, 0.04), mat("Cream", PAL["cream"], 0.3),
              (x, y + dy, z + 1.3), rot=(math.radians(90), 0, 0))
    wood = mat("Wood", PAL["wood"], 0.5)
    for dx in (-0.7, 0.7):
        place(f"Heart_Stand_{dx}", cyl(0.08, 1.0), wood, (x + dx, y, z + 0.4), rot=(0, math.radians(dx * 20), 0))


def pavilion(loc):
    """Memory: an open pavilion with a pointed roof and a shelf of bamboo slips."""
    x, y, z = loc
    wood = mat("PavilionWood", "#8a5a3c", 0.6)
    place("Mem_Base", rbox((5.0, 5.0, 0.5), 0.15, 2), mat("Stone", "#cfc6b3", 0.9), (x, y, z + 0.25))
    for sx in (-1, 1):
        for sy in (-1, 1):
            place(f"Mem_Post_{sx}{sy}", cyl(0.18, 3.2), wood, (x + sx * 2.0, y + sy * 2.0, z + 2.1))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=4.4, radius2=0.3, depth=1.8)
    place("Mem_Roof", bm, mat("PavilionRoof", "#4f5566", 0.5), (x, y, z + 4.5), rot=(0, 0, math.radians(45)))
    place("Mem_Finial", sphere(0.3), mat("Jade", PAL["jade"], 0.2), (x, y, z + 5.5))
    place("Mem_Shelf", rbox((2.8, 0.6, 1.6), 0.05, 2), wood, (x, y + 1.5, z + 1.3))
    for i in range(5):
        place(f"Mem_Slip_{i}", cyl(0.12, 0.55), mat("Paper", PAL["paper"], 0.8),
              (x - 1.0 + i * 0.5, y + 1.2, z + 1.55), rot=(math.radians(90), 0, 0))


def basket(loc):
    """Stem: a round bamboo steamer basket for sleeping cubs."""
    x, y, z = loc
    straw = mat("Straw", PAL["straw"], 0.9, 0.2)
    ring = bmesh.new()
    bmesh.ops.create_cone(ring, cap_ends=False, segments=48, radius1=2.0, radius2=2.1, depth=1.0)
    place("Stem_Basket", solid(ring, 0.15), straw, (x, y, z + 0.5), subsurf=1)
    place("Stem_BasketFloor", cyl(1.95, 0.1), straw, (x, y, z + 0.08))
    place("Stem_Cloth", dome(1.9, 0.5), mat("Cream", PAL["cream"], 0.3), (x, y, z - 0.35), scale=(1, 1, 0.5), subsurf=1)


def stone_path(rx=20.0, ry=23.5, n=58):
    stone = mat("PathStone", "#d8cfbd", 0.95)
    for i in range(n):
        a = 2 * math.pi * i / n
        place(f"Path_{i}", rbox((1.5, 1.0, 0.18), 0.25, 2), stone,
              (rx * math.cos(a), ry * math.sin(a) + 0.5, 0.06), rot=(0, 0, a + math.pi / 2))


def bamboo_cluster(name, x, y, n=7, h=16, seed=1):
    rnd = random.Random(seed)
    stalk = mat("BambooStalk", "#7fa45a", 0.55)
    node = mat("BambooNode", "#5c7f3f", 0.6)
    leaf = mat("BambooLeaf", "#5d9a4c", 0.7)
    for i in range(n):
        px, py = x + rnd.uniform(-2.2, 2.2), y + rnd.uniform(-2.2, 2.2)
        hh = h * rnd.uniform(0.7, 1.1); r = rnd.uniform(0.22, 0.34)
        place(f"{name}_Stalk_{i}", cyl(r, hh), stalk, (px, py, hh / 2))
        for k in range(1, int(hh // 2.2)):
            place(f"{name}_Node_{i}_{k}", cyl(r * 1.12, 0.12), node, (px, py, k * 2.2))
        for k in range(6):
            a = rnd.uniform(0, 2 * math.pi); zz = hh * rnd.uniform(0.55, 1.0)
            place(f"{name}_Leaf_{i}_{k}", sphere(0.5, 12, 8), leaf,
                  (px + math.cos(a) * 0.9, py + math.sin(a) * 0.9, zz),
                  rot=(0, math.radians(-25), a), scale=(1.8, 0.35, 0.08))


def flowers(n=120, seed=3, rx=40, ry=36, keep_out=(21.5, 25.0)):
    rnd = random.Random(seed)
    cols = [("FlowerWhite", "#f7f2e6"), ("FlowerPeach", "#f3b6c4"), ("FlowerButter", "#efd98a")]
    for i in range(n):
        x, y = rnd.uniform(-rx, rx), rnd.uniform(-ry, ry)
        if (x / keep_out[0]) ** 2 + (y / keep_out[1]) ** 2 < 1.0: continue
        nm, hx = cols[i % 3]
        place(f"Flower_{i}", sphere(0.22, 10, 6), mat(nm, hx, 0.7), (x, y, 0.1), scale=(1, 1, 0.4))


def qi_material():
    m = bpy.data.materials.get("Qi")
    if m: return m
    m = bpy.data.materials.new("Qi"); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    e = nt.nodes.new("ShaderNodeEmission"); e.inputs[0].default_value = hex_lin("#3aced3"); e.inputs[1].default_value = 1.6
    out = nt.nodes.new("ShaderNodeOutputMaterial"); nt.links.new(e.outputs[0], out.inputs[0])
    return m


def ribbon(name, pts, width=0.09):
    """Nervous system: a silk ribbon path carrying qi."""
    cu = bpy.data.curves.get(name) or bpy.data.curves.new(name, 'CURVE')
    cu.splines.clear(); cu.dimensions = '3D'; cu.bevel_depth = width; cu.bevel_resolution = 3
    sp = cu.splines.new('BEZIER'); sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = p; bp.handle_left_type = bp.handle_right_type = 'AUTO'
    o = bpy.data.objects.get(name)
    if not o:
        o = bpy.data.objects.new(name, cu); bpy.context.scene.collection.objects.link(o)
    cu.materials.clear(); cu.materials.append(qi_material())
    return o


def place_cell(src_root, name, loc, rot_z=0.0):
    """Copy a cell panda (root + props) from the character sheet into this scene."""
    src = bpy.data.objects[src_root]
    old = bpy.data.objects.get(name)
    if old:
        for c in list(old.children_recursive): bpy.data.objects.remove(c, do_unlink=True)
        bpy.data.objects.remove(old, do_unlink=True)
    root = src.copy(); root.name = name
    bpy.context.scene.collection.objects.link(root)
    for c in src.children:
        cc = c.copy(); bpy.context.scene.collection.objects.link(cc); cc.parent = root
        cc.hide_render = c.name.endswith("FanRibs")
    root.location = Vector(loc); root.rotation_euler = (0, 0, rot_z)
    return root


def shadow_material():
    m = bpy.data.materials.get("ContactShadow")
    if m: return m
    m = bpy.data.materials.new("ContactShadow"); m.use_nodes = True
    try: m.surface_render_method = 'BLENDED'
    except Exception: m.blend_method = 'BLEND'
    nt = m.node_tree; nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord"); sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    comb = nt.nodes.new("ShaderNodeCombineXYZ"); grad = nt.nodes.new("ShaderNodeTexGradient"); grad.gradient_type = 'SPHERICAL'
    mul = nt.nodes.new("ShaderNodeMath"); mul.operation = 'MULTIPLY'; mul.inputs[1].default_value = 0.42
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    em = nt.nodes.new("ShaderNodeEmission"); em.inputs[0].default_value = hex_lin("#3b2c22")
    mix = nt.nodes.new("ShaderNodeMixShader"); out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    nt.links.new(sep.outputs[0], comb.inputs[0]); nt.links.new(sep.outputs[1], comb.inputs[1])
    nt.links.new(comb.outputs[0], grad.inputs[0]); nt.links.new(grad.outputs["Fac"], mul.inputs[0])
    nt.links.new(mul.outputs[0], mix.inputs[0]); nt.links.new(tr.outputs[0], mix.inputs[1]); nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    return m


def contact_shadow(name, x, y, r=1.1, lift=0.04):
    """A soft dark blob draped under a cell, so it sits on Bao instead of floating."""
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, cap_tris=True, segments=24, radius=1.0)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=3, use_grid_fill=True)
    for v in bm.verts:
        px, py = x + v.co.x * r, y + v.co.y * r * 0.8
        v.co = Vector((v.co.x, v.co.y * 0.8, (surface_z(px, py) + lift)))
    o = place(name, bm, shadow_material(), (x, y, 0))
    o.scale = (r, r, 1.0)
    return o
