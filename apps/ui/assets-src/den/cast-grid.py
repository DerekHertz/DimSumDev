import sys, gzip, json, struct, io
import numpy as np
from PIL import Image, ImageDraw

def load(path):
    b = gzip.open(path).read()
    jl = struct.unpack('<I', b[12:16])[0]
    doc = json.loads(b[20:20+jl]); binchunk = b[28+jl:]
    def acc(i):
        a = doc['accessors'][i]; v = doc['bufferViews'][a['bufferView']]
        dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a['componentType']]
        w = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
        s = v.get('byteOffset',0)+a.get('byteOffset',0)
        return np.frombuffer(binchunk, dtype=dt, count=a['count']*w, offset=s).reshape(a['count'], w)
    p = doc['meshes'][0]['primitives'][0]
    pos = acc(p['attributes']['POSITION']).astype(float); uv = acc(p['attributes']['TEXCOORD_0']).astype(float); idx = acc(p['indices']).reshape(-1,3)
    iv = doc['images'][0]; v = doc['bufferViews'][iv['bufferView']]
    img = Image.open(io.BytesIO(binchunk[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']])).convert('RGB')
    # node transform (assume single node with possible matrix/scale)
    n = [n for n in doc['nodes'] if 'mesh' in n][0]
    if 'matrix' in n:
        M = np.array(n['matrix']).reshape(4,4).T
        pos = (np.c_[pos, np.ones(len(pos))] @ M.T)[:, :3]
    return pos, uv, idx, img

def normalize(pos, height=3.0):
    mn, mx = pos.min(0), pos.max(0)
    s = height/(mx[1]-mn[1]); c = (mn+mx)/2
    out = (pos - np.array([c[0], mn[1], c[2]])) * s
    return out

def render(pos, uv, idx, img, view, S=110, W=None, H=None):
    # view: 'front' x right,z toward viewer; 'back'; 'side' (viewer at +X: right=-Z)
    tex = np.asarray(img); th, tw = tex.shape[:2]
    if view == 'front': h, d = pos[:,0], pos[:,2]
    elif view == 'back': h, d = -pos[:,0], -pos[:,2]
    else: h, d = -pos[:,2], pos[:,0]
    ymax = 3.3; hr = 2.6
    W = int(2*hr*S); H = int(ymax*S)+10
    im = Image.new('RGB', (W, H), (235,235,235)); dr = ImageDraw.Draw(im)
    # grid
    for g in np.arange(-hr, hr+1e-6, .25):
        x = int((g+hr)*S); col = (150,150,150) if abs(g-round(g))<1e-6 else (210,210,210)
        dr.line([(x,0),(x,H)], fill=col)
    for g in np.arange(0, ymax+1e-6, .25):
        y = H-5-int(g*S); col = (150,150,150) if abs(g-round(g))<1e-6 else (210,210,210)
        dr.line([(0,y),(W,y)], fill=col)
    tri_d = d[idx].mean(1); order = np.argsort(tri_d)
    for t in order:
        a = idx[t]
        pts = [(int((h[i]+hr)*S), H-5-int(pos[i,1]*S)) for i in a]
        u = uv[a].mean(0); px = tex[min(th-1,int((u[1])*th)) % th, min(tw-1,int(u[0]*tw)) % tw]
        dr.polygon(pts, fill=tuple(int(c) for c in px))
    for g in range(-2, 3):
        dr.text((int((g+hr)*S)+2, 2), str(g), fill=(200,0,0))
    for g in range(0, 4):
        dr.text((2, H-5-int(g*S)-12), str(g), fill=(200,0,0))
    return im

if __name__ == '__main__':
    name = sys.argv[1]
    import os
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../public/den/models/characters/')
    pos, uv, idx, img = load(root+name+'.glb.gz')
    if len(sys.argv) > 3:
        # Posed vertices from cast-poses.mjs: front and side of each, already in rig units.
        ims = []
        for d in sys.argv[3:]:
            p = np.array(json.load(open(d))).reshape(-1, 3)
            ims += [render(p, uv, idx, img, v, S=80) for v in ('front', 'side')]
        out = Image.new('RGB', (sum(i.width for i in ims), ims[0].height)); x = 0
        for i in ims: out.paste(i, (x, 0)); x += i.width
        out.save(sys.argv[2]); sys.exit(0)
    pos = normalize(pos)
    front = (pos[:,2] > 0).mean()
    print(name, 'extent', pos.min(0).round(2), pos.max(0).round(2), 'front-half share', round(front,2))
    ims = [render(pos, uv, idx, img, v) for v in ('front','side','back')]
    W = sum(i.width for i in ims); out = Image.new('RGB', (W, ims[0].height))
    x = 0
    for i in ims: out.paste(i, (x,0)); x += i.width
    out.save(sys.argv[2])
