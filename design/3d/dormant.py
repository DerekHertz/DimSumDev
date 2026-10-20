"""Dormant organs: fade their props and put their agents to sleep.

    exec(open(r"D:/claude_sessions/agent_office/design/3d/dormant.py").read())
    make_dormant(("Liver_", "Heart_", "Mem_", "Stem_", "L1_qa-01", "L1_sec-01", "L1_Cub"))

Each material on a dormant object gets a "<name>·dormant" twin that mixes the
toon shade 45% toward the grove's paper colour, so it reads as faded, not grey.
In three.js: the same mix as a uniform on the toon material.
"""
import bpy

FADE = 0.45
FADE_HEX = "#e9e4d6"   # organ-stem pearl (dark-theme value) = faded paper


def _lin(h):
    h = h.lstrip("#"); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4) for x in c) + (1,)


def dormant_twin(m):
    name = m.name + "·dormant"
    t = bpy.data.materials.get(name)
    if t: return t
    t = m.copy(); t.name = name
    nt = t.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    if not out.inputs[0].links: return t
    src = out.inputs[0].links[0].from_socket
    paper = nt.nodes.new("ShaderNodeEmission"); paper.inputs[0].default_value = _lin(FADE_HEX)
    mix = nt.nodes.new("ShaderNodeMixShader"); mix.inputs[0].default_value = FADE
    nt.links.new(src, mix.inputs[1]); nt.links.new(paper.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    return t


def _objects(prefixes):
    for o in bpy.context.scene.objects:
        if o.name.startswith(prefixes):
            yield o
            yield from o.children_recursive


def make_dormant(prefixes):
    seen = set()
    for o in _objects(prefixes):
        if o.name in seen or o.type != 'MESH': continue
        seen.add(o.name)
        for slot in o.material_slots:
            m = slot.material
            if not m or m.name.endswith("·dormant") or m.name in ("ToonOutline",): continue
            if o.data.users > 1:           # shared mesh (copied agents): give this object its own slots
                slot.link = 'OBJECT'
            slot.material = dormant_twin(m)
        if "_Eye_" in o.name:              # asleep: eyes shut to a line
            o.scale.z = min(o.scale.z, 0.18)
