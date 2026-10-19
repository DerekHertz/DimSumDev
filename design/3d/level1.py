"""Level 1 hero frame: giant Bao on its back in the bamboo grove, organs as workstations.

Run inside Blender after panda_build.py, role_types.py and toon.py:
    exec(open(r"D:/claude_sessions/agent_office/design/3d/level1.py").read())
    build_bao_lying()

Bao is sculpted in "panda units" (a sitting cell panda is ~2.2 tall) and scaled
by BAO_SCALE so Bao is ~10x a cell. Its head uses a local frame (R, U, F):
R = Bao's left-right, U = toward the top of the head, F = the way the face points.
"""
import bpy, math
from mathutils import Vector, Matrix

BAO_SCALE = 7.0
H = Vector((0, 1.62, 0.96))                      # head center: big, sunk into a fat neck
F = Vector((0, -0.55, 0.85)).normalized()        # face looks up and toward the feet
U = Vector((0, 0.85, 0.55)).normalized()         # top of the head
R = Vector((1, 0, 0))

LIMBS = {  # start, end, r0, r1 -- short and thick: stubby paws
    "arm_L": ((-1.0, 0.72, 0.6), (-1.42, 1.22, 0.42), 0.34, 0.31),   # up beside the head
    "arm_R": ((1.0, 0.62, 0.6), (1.58, 0.52, 0.4), 0.34, 0.31),      # flopped out to the side
    "leg_L": ((-0.62, -0.88, 0.45), (-0.95, -1.42, 0.45), 0.39, 0.36),
    "leg_R": ((0.62, -0.88, 0.45), (0.95, -1.42, 0.45), 0.39, 0.36),
}
HEAD_R = (0.86, 0.74, 0.7)   # head radii along R, U, F


def hp(r, u, f):
    """A point in the head frame."""
    return H + R * r + U * u + F * f


def head_quat():
    return Matrix((R, U, F)).transposed().to_quaternion()


def build_bao_meta():
    name = "BaoMeta"
    mb = bpy.data.metaballs.get(name) or bpy.data.metaballs.new(name)
    mb.elements.clear()
    mb.resolution, mb.render_resolution, mb.threshold = 0.035, 0.025, 0.6
    obj = bpy.data.objects.get(name)
    if not obj:
        obj = bpy.data.objects.new(name, mb); bpy.context.scene.collection.objects.link(obj)
    obj.hide_viewport = obj.hide_render = False
    f = lambda s: math.sqrt(1 - (mb.threshold / s) ** (1 / 3))

    def ball(co, Rr, s=5.0):
        e = mb.elements.new(type='BALL'); e.co = co; e.stiffness = s; e.radius = Rr / f(s)

    def ell(co, rx, ry, rz, s=5.0, rot=None):
        e = mb.elements.new(type='ELLIPSOID'); e.co = co; e.stiffness = s
        m = max(rx, ry, rz); e.radius = m / f(s)
        e.size_x, e.size_y, e.size_z = rx / m, ry / m, rz / m
        if rot is not None: e.rotation = rot

    def tuft(base, direction, length, width, s=3.0):
        d = Vector(direction).normalized()
        e = mb.elements.new(type='ELLIPSOID'); e.stiffness = s
        e.co = Vector(base) + d * length * 0.35
        e.radius = length / f(s); e.size_x, e.size_y, e.size_z = 1.0, width / length, width / length
        e.rotation = Vector((1, 0, 0)).rotation_difference(d)

    # a wide, low body with a flat-topped belly the cells can walk on
    ell((0, -0.1, 0.55), 1.12, 1.2, 0.58, 3.0)        # torso, back on the ground
    ell((0, -0.15, 0.8), 1.0, 1.02, 0.38, 3.0)        # belly plateau
    # a thick, chubby neck: nearly head-wide, so head and body read as one fat panda
    ell((0, 1.02, 0.74), 0.9, 0.42, 0.55, 3.0)
    # the head keeps its own round form on top of it (the chin crease is painted below)
    ell(H, *HEAD_R, 5.0, head_quat())
    for s in (-1, 1):
        ball(hp(s * 0.36, -0.14, 0.36), 0.34, 6.0)                    # cheeks
        # ears: round flat discs set into the crown, so the silhouette shows a clean semicircle
        ell(hp(s * 0.6, 0.6, -0.08), 0.27, 0.27, 0.1, 8.0, head_quat())
        for dz, tilt, L in ((0.0, -0.15, 0.12), (-0.16, -0.6, 0.1)):
            tuft(hp(s * 0.8, -0.1 + dz, 0.22), R * s - U * (0.3 - tilt) + F * 0.2, L, 0.08)
    ball(hp(0, -0.14, 0.62), 0.17, 6.0)                               # muzzle
    for k, (a, b, r0, r1) in LIMBS.items():
        a, b = Vector(a), Vector(b); n = 8
        for i in range(n):
            t = i / (n - 1); ball(a.lerp(b, t), r0 + (r1 - r0) * t)
        if k.startswith("arm"):
            mid = a.lerp(b, 0.5); out = (mid - Vector((0, 0, mid.z))).normalized() + Vector((0, 0, 0.6))
            tuft(mid + out.normalized() * 0.15, out, 0.2, 0.1)
    # crown cowlick
    pass  # no crown cowlick on giant Bao: at this scale it reads as a horn
    return obj


def paint_bao(p):
    me = p.data
    WHITE = Vector((0.9, 0.84, 0.74)); BLACK = Vector((0.014, 0.012, 0.013))
    PAD = Vector((0.45, 0.28, 0.22)); BLUSH = Vector((0.95, 0.42, 0.42)); NOSE = Vector((0.005, 0.005, 0.006))
    M = Matrix((R, U, F))  # world -> head frame rows

    def sm(e0, e1, x):
        t = max(0, min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t)

    def seg(pt, a, b):
        a, b = Vector(a), Vector(b); ab = b - a
        t = max(0, min(1, (pt - a).dot(ab) / ab.length_squared)); return (a + ab * t - pt).length

    def head_ell(pt, c, r, tilt=0.0):
        d = M @ (pt - c)
        d = Matrix.Rotation(-tilt, 3, 'Z') @ d
        return math.sqrt((d.x / r[0]) ** 2 + (d.y / r[1]) ** 2 + (d.z / r[2]) ** 2)

    feet = []
    for k, (a, b, *_) in LIMBS.items():
        if k.startswith("leg"):
            feet.append(Vector(b) + (Vector(b) - Vector(a)).normalized() * 0.22)
    attr = me.color_attributes.get("Col") or me.color_attributes.new("Col", 'FLOAT_COLOR', 'POINT')
    cols = [0.0] * (len(me.vertices) * 4)
    for v in me.vertices:
        co, n, k = v.co, v.normal, 0.0
        for s in (-1, 1):
            k = max(k, 1 - sm(0.28, 0.32, (co - hp(s * 0.6, 0.6, -0.08)).length))
            k = max(k, 1 - sm(0.95, 1.03, head_ell(co, hp(s * 0.33, 0.05, 0.52), (0.2, 0.26, 0.36), s * 0.55)))
        for kk, (a, b, r0, r1) in LIMBS.items():
            end = Vector(b) + (Vector(b) - Vector(a)).normalized() * (0.22 if kk.startswith("leg") else 0.0)
            k = max(k, 1 - sm(r0 + 0.07, r0 + 0.1, seg(co, a, end)))
        # shoulder band around the sides and back, chest stays white
        band = 1 - sm(0.2, 0.25, abs(co.y - 0.72))
        k = max(k, band * (1 - sm(0.7, 0.85, co.z)))
        c = WHITE.lerp(BLACK, k)
        c = c.lerp(NOSE, 1 - sm(0.95, 1.03, head_ell(co, hp(0, -0.1, 0.79), (0.11, 0.08, 0.08))))
        # a soft shadow tone in the neck crease so head and body read as two forms
        # chin crease: a fat roll where the head sits on the neck
        crease = (1 - sm(0.0, 0.22, abs((co - H).length - HEAD_R[1] * 1.02))) * sm(0.85, 1.1, co.y) * (1 - sm(1.35, 1.6, co.y))
        c = c.lerp(c * 0.8, crease * (1 - k))
        for s in (-1, 1):
            bk = (1 - sm(0.0, 0.16, (co - hp(s * 0.52, -0.24, 0.5)).length)) * 0.55
            c = c.lerp(BLUSH, bk * (1 - k))
        for ft in feet:
            pk = (1 - sm(0.13, 0.18, (co - ft).length)) * sm(0.4, 0.75, -n.y)
            c = c.lerp(PAD, pk)
        i = v.index * 4; cols[i:i + 4] = (c.x, c.y, c.z, 1.0)
    attr.data.foreach_set("color", cols)
    me.color_attributes.active_color = attr


def bao_eyes(p):
    import bmesh
    bpy.context.view_layer.update()
    inv = p.matrix_world.inverted()
    for s, tag in ((-1, "L"), (1, "R")):
        name = f"Bao_Eye_{tag}"
        old = bpy.data.objects.get(name)
        if old: bpy.data.objects.remove(old, do_unlink=True)
        origin = hp(s * 0.31, 0.07, 3.0)
        ok, loc, nrm, _ = p.ray_cast(origin, -F)
        if not ok: continue
        me = bpy.data.meshes.new(name); bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=16, radius=0.075)
        bm.to_mesh(me); bm.free()
        for poly in me.polygons: poly.use_smooth = True
        me.materials.append(eye_material())
        e = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(e)
        e.parent = p
        e.location = loc - nrm * 0.02
        # bead flattened along the face normal, content half-closed
        e.rotation_mode = 'QUATERNION'; e.rotation_quaternion = head_quat()
        e.scale = (1.0, 0.55, 0.6)


def build_bao_lying(at=(0, 0, 0)):
    src = build_bao_meta()
    p = to_mesh("Bao", src, (0, 0, 0))   # from panda_build.py: remesh, smooth, fur material
    paint_bao(p)
    bao_eyes(p)
    p.scale = (BAO_SCALE,) * 3
    p.location = Vector(at) + Vector((0, 0, p.location.z * BAO_SCALE))
    return p
