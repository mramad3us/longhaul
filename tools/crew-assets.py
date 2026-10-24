#!/usr/bin/env python3
# ============================================================
# LONGHAUL — Building the crew's bodies (a dev-time tool, not part of the game)
#
# The people on the room cameras (js/ui/gl/crew.js) are real rigged human
# bodies: Quaternius' Universal Base Characters (Standard, CC0 1.0,
# https://quaternius.com), a male and a female base body on one humanoid
# skeleton, their eyes and brows, and the kit's hairstyles rigged to the
# same head bone. This script repacks what the game needs from the kit's
# glTF files into assets/crew/: crew.json (the skeleton, the meshes, where
# their arrays lie) and crew.bin (the arrays), and small textures.
#
#   python3 tools/crew-assets.py "<path to Universal Base Characters[Standard]>"
#
# What it does to them:
#   - the hands are given a relaxed curl (the kit rests them flat and
#     spread), then the fingers are merged into the hands (the cameras
#     never show a finger move): 23 joints instead of 65
#   - each vertex of a body is tagged (skin, boot, hand) by where it is on
#     the body at rest, so the shader can dress it in a jumpsuit: skin
#     above the collar and past the cuffs, boots below the ankle, the suit
#     between
#   - only position, normal, the first UV set, joints and weights are kept;
#     textures are scaled down to what a camera feed can show
# Needs Pillow (PIL) for the textures.
# ============================================================

import json, math, os, struct, sys
from PIL import Image

KIT = sys.argv[1] if len(sys.argv) > 1 else None
if not KIT or not os.path.isdir(KIT):
    sys.exit('usage: crew-assets.py "<path to Universal Base Characters[Standard]>"')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'crew')
os.makedirs(OUT, exist_ok=True)

BODIES = {'male': 'Base Characters/Godot - UE/Superhero_Male_FullBody.gltf', 'female': 'Base Characters/Godot - UE/Superhero_Female_FullBody.gltf'}
HAIR_DIR = 'Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)'
HAIRS = ['Hair_SimpleParted', 'Hair_Long', 'Hair_Buns', 'Hair_Buzzed', 'Hair_BuzzedFemale', 'Hair_Beard']
SKIN_TEX = {'male': 'Base Characters/Textures/T_Superhero_Male_Ligh.png', 'female': 'Base Characters/Textures/T_Superhero_Female_Light_BaseColor.png'}

# The joints kept, in this order; every other joint folds into the nearest kept ancestor (fingers into the hand)
KEEP = ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head',
        'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
        'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r']

# ---- glTF reading ----

CT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

def load(path):
    g = json.load(open(path))
    base = os.path.dirname(path)
    bufs = [open(os.path.join(base, b['uri']), 'rb').read() for b in g['buffers']]
    return g, bufs

def accessor(g, bufs, i):
    a = g['accessors'][i]
    bv = g['bufferViews'][a['bufferView']]
    fmt, size = CT[a['componentType']]
    n = NC[a['type']]
    stride = bv.get('byteStride', size * n)
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    data = bufs[bv['buffer']]
    out = []
    for k in range(a['count']):
        vals = struct.unpack_from('<' + fmt * n, data, off + k * stride)
        if a.get('normalized'):
            m = {5121: 255, 5123: 65535, 5120: 127, 5122: 32767}[a['componentType']]
            vals = tuple(v / m for v in vals)
        out.append(vals)
    return out

# ---- matrices (column-major, as glTF) ----

def mat_trs(t, r, s):
    t = t or [0, 0, 0]; r = r or [0, 0, 0, 1]; s = s or [1, 1, 1]
    x, y, z, w = r
    R = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
         2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
         2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]
    return [R[0] * s[0], R[1] * s[0], R[2] * s[0], 0, R[3] * s[1], R[4] * s[1], R[5] * s[1], 0, R[6] * s[2], R[7] * s[2], R[8] * s[2], 0, t[0], t[1], t[2], 1]

def mul(a, b):
    o = [0.0] * 16
    for c in range(4):
        for r in range(4):
            o[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return o

def node_mat(n):
    return n['matrix'] if 'matrix' in n else mat_trs(n.get('translation'), n.get('rotation'), n.get('scale'))

def globals_of(g):
    G = [None] * len(g['nodes'])
    def walk(i, parent):
        G[i] = mul(parent, node_mat(g['nodes'][i]))
        for c in g['nodes'][i].get('children', []):
            walk(c, G[i])
    I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    for r in g['scenes'][g.get('scene', 0)]['nodes']:
        walk(r, I)
    return G

def parents_of(g):
    P = [-1] * len(g['nodes'])
    for i, n in enumerate(g['nodes']):
        for c in n.get('children', []):
            P[c] = i
    return P

# ---- the skeleton, kept joints and how the rest fold into them ----

def skeleton(g):
    skin = g['skins'][0]
    names = [g['nodes'][j]['name'] for j in skin['joints']]
    P = parents_of(g)
    byNode = {j: k for k, j in enumerate(skin['joints'])}
    fold = []
    for k, j in enumerate(skin['joints']):
        n = j
        while g['nodes'][n]['name'] not in KEEP:
            n = P[n]
        fold.append(KEEP.index(g['nodes'][n]['name']))
    return names, fold

def rest_of(g):
    """Each kept joint's rest (bind) pose in model space: a column-major 4×4, and its kept parent."""
    G = globals_of(g)
    P = parents_of(g)
    idx = {g['nodes'][i]['name']: i for i in range(len(g['nodes']))}
    mats, parents = [], []
    for name in KEEP:
        i = idx[name]
        mats.append(G[i])
        p = P[i]
        while p >= 0 and g['nodes'][p]['name'] not in KEEP:
            p = P[p]
        parents.append(KEEP.index(g['nodes'][p]['name']) if p >= 0 else -1)
    return mats, parents

def inverse_binds(g, bufs):
    """The skin's inverse bind matrices for the kept joints."""
    skin = g['skins'][0]
    ibm = accessor(g, bufs, skin['inverseBindMatrices'])
    names = [g['nodes'][j]['name'] for j in skin['joints']]
    return [list(ibm[names.index(n)]) for n in KEEP]

# ---- meshes ----

class Bin:
    def __init__(self): self.b = bytearray()
    def add(self, fmt, vals):
        while len(self.b) % 4: self.b.append(0)
        off = len(self.b)
        self.b += struct.pack('<%d%s' % (len(vals), fmt), *vals)
        return off

def curls(g):
    """Relaxed hands: each finger joint turned toward the palm (the palms face down at rest), a little more at
    the middle joint; per skin joint, the rigid transform (R, t) its vertices take."""
    skin = g['skins'][0]
    G = globals_of(g)
    P = parents_of(g)
    I = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0])
    def apply(T, p):
        R, t = T
        return [sum(R[r][c] * p[c] for c in range(3)) + t[r] for r in range(3)]
    def compose(A, B):
        RA, tA = A; RB, tB = B
        return ([[sum(RA[r][k] * RB[k][c] for k in range(3)) for c in range(3)] for r in range(3)], [sum(RA[r][k] * tB[k] for k in range(3)) + tA[r] for r in range(3)])
    C = {}
    for j in skin['joints']:
        n = g['nodes'][j]['name']
        par = C.get(P[j], I)
        if n.split('_')[0] in ('index', 'middle', 'ring', 'pinky') and 'leaf' not in n:
            a = {'01': 0.35, '02': 0.55, '03': 0.4}[n.split('_')[1]] * (-1 if n.endswith('_l') else 1)
            pivot = apply(par, [G[j][12], G[j][13], G[j][14]])
            c, s_ = math.cos(a), math.sin(a)
            Rz = [[c, -s_, 0], [s_, c, 0], [0, 0, 1]]
            C[j] = compose((Rz, [pivot[r] - sum(Rz[r][k] * pivot[k] for k in range(3)) for r in range(3)]), par)
        else:
            C[j] = par
    return [C[j] for j in skin['joints']], apply

def mesh_arrays(g, bufs, prim, fold, tagger=None, curl=None):
    a = prim['attributes']
    pos = accessor(g, bufs, a['POSITION'])
    nrm = accessor(g, bufs, a['NORMAL'])
    uv = accessor(g, bufs, a['TEXCOORD_0'])
    J = accessor(g, bufs, a['JOINTS_0'])
    W = accessor(g, bufs, a['WEIGHTS_0'])
    if curl:
        # the curled hands baked into the mesh: each vertex carried by its joints' transforms, by weight
        C, apply = curl
        P2, N2 = [], []
        for p, n, j4, w4 in zip(pos, nrm, J, W):
            q = [0, 0, 0]; m = [0, 0, 0]
            for j, w in zip(j4, w4):
                if w <= 0: continue
                v = apply(C[j], p)
                R = C[j][0]
                r = [sum(R[i][k] * n[k] for k in range(3)) for i in range(3)]
                for i in range(3): q[i] += w * v[i]; m[i] += w * r[i]
            tw = sum(w4) or 1
            q = [v / tw for v in q]
            l = math.sqrt(sum(v * v for v in m)) or 1
            P2.append(tuple(q)); N2.append(tuple(v / l for v in m))
        pos, nrm = P2, N2
    idx = [i for (i,) in accessor(g, bufs, prim['indices'])]
    joints, weights = [], []
    for j4, w4 in zip(J, W):
        acc = {}
        for j, w in zip(j4, w4):
            if w > 0: acc[fold[j]] = acc.get(fold[j], 0) + w
        top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(w for _, w in top) or 1
        q = [int(round(255 * w / tot)) for _, w in top]
        q[0] += 255 - sum(q)
        top += [(0, 0)] * (4 - len(top)); q += [0] * (4 - len(q))
        joints += [j for j, _ in top]; weights += q
    tags = []
    for k, p in enumerate(pos):
        tags += tagger(p, joints[k * 4:k * 4 + 4], weights[k * 4:k * 4 + 4]) if tagger else [0, 0, 0, 0]
    return {'pos': [c for p in pos for c in p], 'nrm': [c for n in nrm for c in n], 'uv': [c for t in uv for c in t], 'joints': joints, 'weights': weights, 'tags': tags, 'idx': idx, 'n': len(pos)}

def put(bin_, arrays):
    big = max(arrays['idx']) > 65535
    return {
        'count': arrays['n'], 'indices': len(arrays['idx']), 'index32': big,
        'pos': bin_.add('f', arrays['pos']), 'nrm': bin_.add('f', arrays['nrm']), 'uv': bin_.add('f', arrays['uv']),
        'joints': bin_.add('B', arrays['joints']), 'weights': bin_.add('B', arrays['weights']), 'tags': bin_.add('B', arrays['tags']),
        'idx': bin_.add('I' if big else 'H', arrays['idx']),
    }

def body_tagger(rest):
    """Skin above the collar and on the hands, boots below the ankles: where a jumpsuit ends, at rest."""
    y = lambda name: rest[KEEP.index(name)][13]
    x = lambda name: rest[KEEP.index(name)][12]
    collar = y('neck_01') + 0.035
    ankle = (y('foot_l') + y('foot_r')) / 2 + 0.11
    wrist = (abs(x('hand_l')) + abs(x('hand_r'))) / 2 - 0.012
    def tag(p, j4, w4):
        skin = 255 if p[1] > collar else 0
        hand = 255 if abs(p[0]) > wrist and p[1] > ankle + 0.4 else 0
        boot = 255 if p[1] < ankle else 0
        return [skin, boot, hand, 0]
    return tag

def texture(src, dst, size, fmt='JPEG'):
    im = Image.open(os.path.join(KIT, src)).convert('RGB' if fmt == 'JPEG' else 'RGBA').resize((size, size), Image.LANCZOS)
    im.save(os.path.join(OUT, dst), fmt, **({'quality': 88} if fmt == 'JPEG' else {}))
    return dst

def main():
    out = {'joints': KEEP, 'bodies': {}, 'hair': {}, 'source': 'Quaternius, Universal Base Characters (Standard), CC0 1.0'}
    b = Bin()
    for key, path in BODIES.items():
        g, bufs = load(os.path.join(KIT, path))
        names, fold = skeleton(g)
        rest, parents = rest_of(g)
        ibm = inverse_binds(g, bufs)
        # (the kit binds at its rest pose: rest × inverse bind is the identity)
        err = max(abs(v - (1 if c % 5 == 0 else 0)) for R, B in zip(rest, ibm) for c, v in enumerate(mul(R, B)))
        assert err < 1e-3, f'{key}: bind pose differs from rest by {err}'
        out['parents'] = parents
        meshes = {}
        for n in g['nodes']:
            if 'mesh' not in n: continue
            prim = g['meshes'][n['mesh']]['primitives'][0]
            part = {'Eyes': 'eyes', 'Eyebrows': 'brows'}.get(n['name'], 'body')
            meshes[part] = put(b, mesh_arrays(g, bufs, prim, fold, body_tagger(rest) if part == 'body' else None, curls(g) if part == 'body' else None))
        out['bodies'][key] = {'rest': rest, 'ibm': b.add('f', [v for m in ibm for v in m]), 'meshes': meshes,
                              'skin': texture(SKIN_TEX[key], f'skin-{key}.jpg', 512)}
    for name in HAIRS:
        g, bufs = load(os.path.join(KIT, HAIR_DIR, name + '.gltf'))
        names, fold = skeleton(g)
        ibm = inverse_binds(g, bufs)
        prim = g['meshes'][0]['primitives'][0]
        mat = g['materials'][prim['material']]
        img = g['images'][g['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source']]['uri']
        out['hair'][name.replace('Hair_', '').lower()] = {'mesh': put(b, mesh_arrays(g, bufs, prim, fold)), 'ibm': b.add('f', [v for m in ibm for v in m]), 'tex': img.replace('.png', '.jpg').lower()}
    for t in ['T_Hair_1_BaseColor.png', 'T_Hair_2_BaseColor.png']:
        texture(os.path.join(HAIR_DIR, t), t.replace('.png', '.jpg').lower(), 256)
    texture('Base Characters/Textures/T_Eye_Brown.png', 'eye.png', 128, 'PNG')
    open(os.path.join(OUT, 'crew.bin'), 'wb').write(b.b)
    json.dump(out, open(os.path.join(OUT, 'crew.json'), 'w'), separators=(',', ':'))
    print('crew.bin', len(b.b), 'bytes;', 'bodies', list(out['bodies']), 'hair', list(out['hair']))

main()
