"""Build game map data (provinces, owners, adjacency) from the source map image.

The source map (`новая карта.png` in the repository root) shows every territory filled with its flag
and every province outlined with a thin dark *dotted* line. This script turns that picture into game
data without redrawing the map:

1. Dark dots are detected with a morphological black-hat filter; the dots are joined into closed lines
   (dilation) and the land is split into connected regions along them.
2. Regions whose lines are too faint / broken to close (e.g. the red stripe of Azerbaijan, which is
   crossed by the crescent) are divided by a seeded priority flood over the line relief, so basins meet
   exactly on the visible lines. Other oversized regions are split the same way from seeds found
   automatically (cores of the distance transform from the lines).
3. Tiny fragments are absorbed by a neighbour, every region is assigned to a territory (flag colours +
   position), polygons / label points / neighbours / shared borders are extracted and written to
   data/map.json. Coordinates are pixels of the source image (SVG viewBox = image size).
4. A pixel-identical lossless WebP copy of the image (data/map.webp, ~25% smaller than the PNG) is
   written for the browser.

Usage:  python tools/build_map_data.py [--dump]   (requires numpy, opencv-python, pillow)
"""
import heapq
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'новая карта.png')
OUT = os.path.join(ROOT, 'data', 'map.json')
DUMP = '--dump' in sys.argv

# segmentation parameters (tuned for the new map)
T_LINE = 30        # black-hat response of a border dot
LINE_DIL = 5       # joins the dots of a dotted line (gaps up to ~4 px)
MIN_SEED = 80      # minimal area of a seed region
TINY = 700         # smaller regions are absorbed by a neighbour
SPLIT_AREA = 7000  # larger regions are checked for lines that did not close
SPLIT_T = 20       # ... using weaker dots
SPLIT_D = 6.0      # ... a pocket must be at least 2*SPLIT_D px wide
SPLIT_CORE = 300   # ... and its core at least this many px

a = np.array(Image.open(SRC).convert('RGB')).astype(np.uint8)
H, W = a.shape[:2]
mx = a.max(axis=2)
ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
bh = cv2.morphologyEx(mx, cv2.MORPH_BLACKHAT, ker)
relief = cv2.GaussianBlur(bh.astype(np.float32), (0, 0), 0.8)

# ---------------------------------------------------------------- land mask
dark = (mx < 50).astype(np.uint8)
_, dl = cv2.connectedComponents(dark, connectivity=4)
edge_labels = set(np.unique(np.concatenate([dl[0], dl[-1], dl[:, 0], dl[:, -1]]))) - {0}
outside = np.isin(dl, list(edge_labels)) & (dark > 0)
land = (~outside).astype(np.uint8)
land = cv2.morphologyEx(land, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

# ------------------------------------------------------------- seed regions
border = ((bh > T_LINE) | (mx < 50)).astype(np.uint8)
border = cv2.dilate(border, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (LINE_DIL, LINE_DIL)))
mask = ((1 - border) & land).astype(np.uint8)
n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
keep = np.zeros(n, bool)
keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= MIN_SEED
lab = np.where(keep[lab], lab, 0).astype(np.int32)


def grow(lab):
    """Assign border pixels to the nearest region so regions tile the land."""
    lab = lab.copy()
    k3 = np.ones((3, 3), np.uint8)
    for _ in range(400):
        un = (lab == 0) & (land > 0)
        if not un.any():
            break
        d = cv2.dilate(lab.astype(np.float32), k3).astype(np.int32)
        upd = un & (d > 0)
        if not upd.any():
            break
        lab[upd] = d[upd]
    return lab


def flood(region, seeds, base, relief=relief):
    """Seeded priority flood (Meyer) inside `region` over the line relief; returns new labels."""
    out = np.zeros(lab.shape, np.int32)
    heap = []
    for k, (sx, sy) in enumerate(seeds):
        if not region[sy, sx]:
            raise SystemExit(f'seed ({sx},{sy}) lies outside its region')
        out[sy, sx] = base + k
        heapq.heappush(heap, (0.0, sx, sy, base + k))
    while heap:
        _, x, y, nid = heapq.heappop(heap)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and region[ny, nx] and not out[ny, nx]:
                out[ny, nx] = nid
                heapq.heappush(heap, (float(relief[ny, nx]), nx, ny, nid))
    # every part must stay one connected piece (detached crumbs go back to the flood of a neighbour)
    for nid in range(base, base + len(seeds)):
        part = (out == nid).astype(np.uint8)
        k, pl, ps, _ = cv2.connectedComponentsWithStats(part, connectivity=4)
        if k > 2:
            big = 1 + int(np.argmax(ps[1:, cv2.CC_STAT_AREA]))
            out[(part > 0) & (pl != big)] = 0
    return out


def chevron_relief(region):
    """Line relief where the outlined white chevron of the Karabakh flag is a ridge along its centre line,
    so the parts on both sides meet in the middle of the chevron (it has no dark line on its east side)."""
    white = ((a.min(axis=2) > 200) & region).astype(np.uint8)
    white = cv2.morphologyEx(white, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    wd = cv2.distanceTransform(white, cv2.DIST_L2, 5)
    return np.where(white > 0, 150.0 + 20.0 * wd, relief).astype(np.float32)


def split(lab, point, seeds, relief_fn=None):
    region = lab == lab[point[1], point[0]]
    out = flood(region, seeds, int(lab.max()) + 1, relief_fn(region) if relief_fn else relief)
    lab = np.where(region, out, lab)
    return grow(np.where(lab > 0, lab, 0)), sorted(set(np.unique(out).tolist()) - {0})


lab = grow(lab)

# ------------------------------------ explicit splits (lines too broken to close)
# Nagorno-Karabakh: one closed outline; the parts inside are divided by weak lines and by the
# stripe / chevron seams of the flag. Every part becomes a separate province NK_01 ... NK_04.
NK_POINT = (915, 720)
NK_SEEDS = [
    # (id, name, seed x, seed y)
    ('NK_01', 'Карабах · Север', 915, 680),
    ('NK_02', 'Карабах · Запад', 865, 735),
    ('NK_03', 'Карабах · Центр', 925, 770),  # wedge between the dotted line (x≈910) and the chevron
    ('NK_04', 'Карабах · Восток', 968, 745),
]
lab, nk_ids = split(lab, NK_POINT, [(x, y) for _, _, x, y in NK_SEEDS], chevron_relief)
NK_PARTS = dict(zip(nk_ids, NK_SEEDS))
# the red stripe of Azerbaijan: dotted lines are interrupted by the crescent and the star
AZ_RED_POINT = (1105, 675)
AZ_RED_SEEDS = [(985, 690), (1135, 620), (1200, 670), (1120, 735)]
lab, _ = split(lab, AZ_RED_POINT, AZ_RED_SEEDS)
explicit = set(nk_ids) | {int(lab[y, x]) for x, y in AZ_RED_SEEDS}

# ---------------------------------------- automatic splits of oversized regions
ids, cnt = np.unique(lab[lab > 0], return_counts=True)
for i, c in zip(ids.tolist(), cnt.tolist()):
    if c < SPLIT_AREA or i in explicit:
        continue
    m = (lab == i).astype(np.uint8)
    lines = ((bh > SPLIT_T) & (m > 0)).astype(np.uint8)
    free = (m & (1 - cv2.dilate(lines, np.ones((3, 3), np.uint8)))).astype(np.uint8)
    dist = cv2.distanceTransform(np.pad(free, 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
    k, cl, st, cen = cv2.connectedComponentsWithStats((dist >= SPLIT_D).astype(np.uint8), connectivity=4)
    seeds = []
    for j in range(1, k):
        if st[j, cv2.CC_STAT_AREA] >= SPLIT_CORE:
            yy, xx = np.nonzero(cl == j)
            t = int(np.argmax(dist[yy, xx]))  # deepest point of the core
            seeds.append((int(xx[t]), int(yy[t])))
    if len(seeds) > 1:
        ys, xs = np.nonzero(m)
        lab, _ = split(lab, (int(xs[0]), int(ys[0])), seeds)


def areas_of(lab):
    ids, cnt = np.unique(lab[lab > 0], return_counts=True)
    return dict(zip(ids.tolist(), cnt.tolist()))


def contact_lengths(lab):
    """{(p, q): number of 4-neighbour pixel pairs on the boundary between p and q}, p < q."""
    res = {}
    for dy, dx in ((0, 1), (1, 0)):
        A = lab[:H - dy, :W - dx]
        B = lab[dy:, dx:]
        m = (A != B) & (A > 0) & (B > 0)
        p = np.minimum(A[m], B[m]).astype(np.int64)
        q = np.maximum(A[m], B[m]).astype(np.int64)
        key = p * 100000 + q
        u, c = np.unique(key, return_counts=True)
        for kk, cc in zip(u.tolist(), c.tolist()):
            res[(kk // 100000, kk % 100000)] = res.get((kk // 100000, kk % 100000), 0) + cc
    return res


# ------------------------------------------------ absorb tiny fragments
for _ in range(6):
    area = areas_of(lab)
    best = {}
    for (p, q), ln in contact_lengths(lab).items():
        for s, t in ((p, q), (q, p)):
            if area.get(s, 0) < TINY and area.get(t, 0) >= area.get(s, 0) and (s not in best or best[s][0] < ln):
                best[s] = (ln, t)
    if not best:
        break
    parent = {s: t for s, (_, t) in best.items() if s not in NK_PARTS}
    # no chains: a fragment that absorbs another one this round keeps its own label
    parent = {s: t for s, t in parent.items() if t not in parent}
    if not parent:
        break
    remap = np.arange(lab.max() + 1)
    for s, t in parent.items():
        remap[s] = t
    lab = remap[lab]

ids = sorted(set(np.unique(lab).tolist()) - {0})
if DUMP:
    np.save(os.path.join(ROOT, 'tools_tmp', 'final_lab.npy'), lab)
    print('regions:', len(ids), file=sys.stderr)
    if '--seg-only' in sys.argv:
        sys.exit(0)

# --------------------------------------------------------------- territories
# Every pixel gets the nearest flag colour of the map; a province is described by its dominant colour
# and its centroid. The rules below follow the layout of the source map (north -> south):
# Russia (white/blue/red), Chechnya (dark green/white/red), Dagestan (light green/blue/red),
# Abkhazia, Georgia (white with red crosses), South Ossetia (white/red/yellow), Polgonustan
# (green/white, in place of Armenia), Azerbaijan (sky blue/red/green), Nakhchivan (Azerbaijani flag,
# south-west exclave) and Nagorno-Karabakh (red/blue/orange with the white chevron).
PALETTE = {
    'W': (250, 250, 250), 'R': (222, 27, 23), 'r': (223, 5, 43), 'O': (215, 130, 32),
    'Y': (242, 210, 44), 'g': (18, 130, 40), 'G': (22, 160, 65), 'D': (22, 88, 186),
    'B': (1, 159, 221), 'P': (5, 125, 19),
}
pk = list(PALETTE)
pal = np.array([PALETTE[k] for k in pk], np.int32)
flat = a.reshape(-1, 3).astype(np.int32)
cls = np.argmin(((flat[:, None, :] - pal[None, :, :]) ** 2).sum(axis=2), axis=1).reshape(H, W)
bright = mx > 80  # ignore the dark dots of the lines

COUNTRY_POINTS = {
    # regions containing these points -> fixed territory
    'abkhazia': [(316, 264)],
    'south_ossetia': [(662, 280), (639, 307), (679, 381)],
}
fixed = {}
for cid, pts in COUNTRY_POINTS.items():
    for (x, y) in pts:
        fixed[int(lab[y, x])] = cid
for nid in NK_PARTS:
    fixed[nid] = 'artsakh'


def classify(dom, cx, cy, green):
    # two greens in the north: Chechnya is darker (G ~130) than Dagestan (G ~145-165)
    if dom in ('g', 'G') and cy < 330:
        return 'chechnya' if green < 140 else 'dagestan'
    if dom == 'D' and cx > 820 and cy < 430:
        return 'dagestan'
    if dom == 'R' and cx > 820 and 395 < cy < 545:
        return 'dagestan'
    if 425 < cx < 800 and cy < 285 and ((dom == 'D' and cy < 200) or (dom in ('R', 'r') and cx < 740) or (dom == 'W' and cy < 160)):
        return 'russia'
    if 690 <= cx <= 910 and ((dom == 'W' and 200 <= cy <= 300) or (dom == 'R' and 240 <= cy <= 350)):
        return 'chechnya'
    if dom in ('B', 'r', 'G') and cy > 750 and cx < 890:
        return 'nakhchivan'
    if dom == 'P' or (dom == 'W' and cy > 560 and cx < 900):
        return 'armenia'
    if dom in ('B', 'r', 'G') and cy > 440:
        return 'azerbaijan'
    if dom in ('W', 'R', 'r') and cy < 545:
        return 'georgia'
    raise SystemExit(f'cannot classify province at ({cx:.0f},{cy:.0f}), colour {dom}')


props = {}
for i in ids:
    m = lab == i
    ys, xs = np.nonzero(m)
    counts = np.bincount(cls[m & bright], minlength=len(pk))
    dom = pk[int(np.argmax(counts))]
    cx, cy = float(xs.mean()), float(ys.mean())
    greens = m & bright & np.isin(cls, [pk.index('g'), pk.index('G')])
    green = float(a[..., 1][greens].mean()) if greens.any() else 0.0
    country = fixed.get(i) or classify(dom, cx, cy, green)
    props[i] = dict(country=country, cx=cx, cy=cy, area=int(m.sum()), mask_bbox=(xs.min(), ys.min(), xs.max(), ys.max()))

if DUMP:
    letters = {'russia': 'Ru', 'chechnya': 'C', 'dagestan': 'D', 'abkhazia': 'A', 'georgia': 'G', 'south_ossetia': 'S',
               'armenia': 'P', 'azerbaijan': 'z', 'nakhchivan': 'N', 'artsakh': 'K'}
    with open(os.path.join(ROOT, 'tools_tmp', 'countries.txt'), 'w', encoding='utf-8') as f:
        for y in range(0, H, 12):
            f.write('%4d ' % y + ''.join(letters[props[int(lab[y, x])]['country']][-1] if lab[y, x] else ' ' for x in range(180, 1440, 6)) + '\n')


# --------------------------------------------------------------- geometry
def path_for(mask):
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    parts = []
    for c in cnts:
        if cv2.contourArea(c) < 4:
            continue
        c = cv2.approxPolyDP(c, 0.9, True)
        pts = c.reshape(-1, 2)
        if len(pts) < 3:
            continue
        parts.append('M' + 'L'.join(f'{x},{y}' for x, y in pts) + 'Z')
    return ''.join(parts)


def label_point(mask):
    dist = cv2.distanceTransform(np.pad(mask.astype(np.uint8), 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
    y, x = np.unravel_index(int(np.argmax(dist)), dist.shape)
    return int(x), int(y), float(dist[y, x])


def shared_borders(lab):
    """Polylines along the boundary between every pair of adjacent regions."""
    pts = {}
    for dy, dx in ((0, 1), (1, 0)):
        A = lab[:H - dy, :W - dx]
        Bm = lab[dy:, dx:]
        m = (A != Bm) & (A > 0) & (Bm > 0)
        ys, xs = np.nonzero(m)
        for p, q, y, x in zip(A[m], Bm[m], ys, xs):
            key = (int(min(p, q)), int(max(p, q)))
            # midpoint of the two pixels, stored in half-pixel units
            pts.setdefault(key, set()).add((2 * int(x) + dx, 2 * int(y) + dy))
    lines = {}
    for key, s in pts.items():
        if len(s) < 3:
            continue
        grid = {}
        for p in s:
            grid.setdefault((p[0] >> 3, p[1] >> 3), []).append(p)

        def near(p):
            gx, gy = p[0] >> 3, p[1] >> 3
            for ix in (gx - 1, gx, gx + 1):
                for iy in (gy - 1, gy, gy + 1):
                    for q in grid.get((ix, iy), ()):
                        if q in s and q != p and (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 <= 8:
                            yield q
        polylines = []
        remaining = set(s)
        while remaining:
            start = min(remaining, key=lambda p: sum(1 for q in near(p) if q in remaining))
            line = [start]
            remaining.discard(start)
            cur = start
            while True:
                cands = [q for q in near(cur) if q in remaining]
                if not cands:
                    break
                nxt = min(cands, key=lambda q: (q[0] - cur[0]) ** 2 + (q[1] - cur[1]) ** 2)
                remaining.discard(nxt)
                line.append(nxt)
                cur = nxt
            if len(line) >= 3:
                arr = np.array(line, dtype=np.float32).reshape(-1, 1, 2) / 2.0
                arr = cv2.approxPolyDP(arr, 0.8, False).reshape(-1, 2)
                polylines.append([[round(float(x), 1), round(float(y), 1)] for x, y in arr])
        lines[key] = (len(s), polylines)
    return lines


borders = shared_borders(lab)

COUNTRY_ORDER = ['russia', 'chechnya', 'dagestan', 'abkhazia', 'georgia', 'south_ossetia', 'armenia', 'azerbaijan',
                 'artsakh', 'nakhchivan']
COUNTRY_SHORT = {
    'russia': 'Россия', 'chechnya': 'Чечня', 'dagestan': 'Дагестан', 'georgia': 'Грузия', 'abkhazia': 'Абхазия',
    'south_ossetia': 'Южная Осетия', 'armenia': 'Полгонустан', 'azerbaijan': 'Азербайджан',
    'artsakh': 'Нагорный Карабах', 'nakhchivan': 'Нахичевань',
}

# stable, readable ids: country prefix + number from north-west to south-east
by_country = {}
for i in ids:
    by_country.setdefault(props[i]['country'], []).append(i)
pid = {}
names = {}
for c, lst in by_country.items():
    lst.sort(key=lambda i: (round(props[i]['cy'] / 80), props[i]['cx']))
    for k, i in enumerate(lst, 1):
        pid[i] = f'{c}-{k:02d}'
        names[i] = COUNTRY_SHORT[c] if len(lst) == 1 else f'{COUNTRY_SHORT[c]} · {k}'
# Karabakh provinces keep the ids / names of their seeds (NK_01 ... NK_04)
for nid, (sid, sname, _, _) in NK_PARTS.items():
    pid[nid] = sid
    names[nid] = sname

neigh = {i: {} for i in ids}
for (p, q), (ln, _) in borders.items():
    if ln >= 3:
        neigh[p][q] = ln
        neigh[q][p] = ln

provinces = []
for i in sorted(ids, key=lambda i: pid[i]):
    m = lab == i
    lx, ly, lr = label_point(m)
    x0, y0, x1, y1 = props[i]['mask_bbox']
    provinces.append({
        'id': pid[i],
        'name': names[i],
        'country': props[i]['country'],
        'area': props[i]['area'],
        'label': [lx, ly],
        'labelRadius': round(lr, 1),
        'bbox': [int(x0), int(y0), int(x1), int(y1)],
        'neighbors': sorted(pid[j] for j in neigh[i]),
        'path': path_for(m),
    })

border_list = []
for (p, q), (ln, polylines) in sorted(borders.items(), key=lambda kv: (pid[kv[0][0]], pid[kv[0][1]])):
    if ln < 3 or not polylines:
        continue
    border_list.append({'a': pid[p], 'b': pid[q], 'length': ln, 'lines': polylines})

data = {
    'source': os.path.basename(SRC),
    'width': W,
    'height': H,
    'countries': COUNTRY_ORDER,
    'provinces': provinces,
    'borders': border_list,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

# web copy of the map: lossless, so the game shows exactly the pixels of the source image
WEB = os.path.join(ROOT, 'data', 'map.webp')
Image.fromarray(a).save(WEB, 'WEBP', lossless=True, quality=100, method=6)
if not np.array_equal(np.array(Image.open(WEB).convert('RGB')), a):
    raise SystemExit('map.webp differs from the source image')

summary = {}
for p in provinces:
    summary[p['country']] = summary.get(p['country'], 0) + 1
print('provinces:', len(provinces), summary, file=sys.stderr)
print('borders:', len(border_list), 'size KB:', os.path.getsize(OUT) // 1024, file=sys.stderr)
