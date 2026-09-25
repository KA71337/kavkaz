"""Build game map data (provinces, owners, adjacency) from the source map image.

The source map (image.png in the repository root) shows every country filled
with its flag and every province outlined with a thin dark border line.  This
script turns that picture into game data without redrawing the map:

1. Thin dark lines are detected with a morphological black-hat filter and the
   land is split into connected regions along them.
2. Regions that were separated only by flag artwork (stripe transitions,
   Georgian crosses, the Azerbaijani crescent, ...) are merged back.  Such
   edges have different colours on both sides but no near-black pixels.
3. Every region is classified into a country using its flag colours and
   position, polygons / label points / neighbours / shared borders are
   extracted and written to data/map.json.

Usage:  python tools/build_map_data.py   (requires numpy, opencv-python, pillow)
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'image.png')
OUT = os.path.join(ROOT, 'data', 'map.json')

# segmentation parameters (tuned for image.png)
T_LINE = 20        # black-hat response that counts as a (possible) border line
LINE_DIL = 3       # closes 1-2px gaps in border lines
MIN_SEED = 120     # minimal area of a seed region
DIFF = 90          # colour difference that marks a flag-artwork edge
WEAK = 72          # flag-artwork edges are weaker than this (black-hat)
DARK = 90          # ... and contain no pixel darker than this
TINY = 700         # smaller regions are absorbed by a neighbour

a = np.array(Image.open(SRC).convert('RGB')).astype(np.uint8)
H, W = a.shape[:2]
mx = a.max(axis=2)
ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
bh_mx = cv2.morphologyEx(mx, cv2.MORPH_BLACKHAT, ker)
bh_ch = np.max([cv2.morphologyEx(a[:, :, c], cv2.MORPH_BLACKHAT, ker) for c in range(3)], axis=0)
bh_mx_d = cv2.dilate(bh_mx, np.ones((5, 5), np.uint8)).astype(np.float32)
bh_ch_d = cv2.dilate(bh_ch, np.ones((5, 5), np.uint8)).astype(np.float32)
mx_e = cv2.erode(mx, np.ones((5, 5), np.uint8)).astype(np.float32)

# ---------------------------------------------------------------- land mask
dark = (mx < 50).astype(np.uint8)
_, dl = cv2.connectedComponents(dark, connectivity=4)
edge_labels = set(np.unique(np.concatenate([dl[0], dl[-1], dl[:, 0], dl[:, -1]]))) - {0}
outside = np.isin(dl, list(edge_labels)) & (dark > 0)
land = (~outside).astype(np.uint8)
land = cv2.morphologyEx(land, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

# ------------------------------------------------------------- seed regions
border = ((bh_mx > T_LINE) | (mx < 50)).astype(np.uint8)
border = cv2.dilate(border, np.ones((LINE_DIL, LINE_DIL), np.uint8))
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


lab = grow(lab)


def boundary_samples(lab):
    """Yield (p, q, y, x, colour_p, colour_q) for every 4-neighbour label change."""
    res = []
    o = 5
    for dy, dx in ((0, 1), (1, 0)):
        A = lab[:H - dy, :W - dx]
        B = lab[dy:, dx:]
        m = (A != B) & (A > 0) & (B > 0)
        ys, xs = np.nonzero(m)
        va, vb = A[m], B[m]
        ya = np.clip(ys - o * dy, 0, H - 1)
        xa = np.clip(xs - o * dx, 0, W - 1)
        yb = np.clip(ys + dy + o * dy, 0, H - 1)
        xb = np.clip(xs + dx + o * dx, 0, W - 1)
        res.append((va, vb, ys, xs, dy, dx, lab[ya, xa] == va, lab[yb, xb] == vb,
                    a[ya, xa].astype(int), a[yb, xb].astype(int)))
    return res


def pair_info(lab):
    recs = {}
    for va, vb, ys, xs, dy, dx, okA, okB, colA, colB in boundary_samples(lab):
        for i in range(len(ys)):
            p, q = int(va[i]), int(vb[i])
            ca, cb, oa, ob = colA[i], colB[i], okA[i], okB[i]
            if p > q:
                p, q, ca, cb, oa, ob = q, p, cb, ca, ob, oa
            r = recs.get((p, q))
            if r is None:
                r = recs[(p, q)] = {'mx': [], 'ch': [], 'dk': [], 'y': [], 'ca': [], 'cb': []}
            y, x = ys[i], xs[i]
            r['mx'].append(bh_mx_d[y, x])
            r['ch'].append(bh_ch_d[y, x])
            r['dk'].append(mx_e[y, x])
            r['y'].append(y)
            if oa:
                r['ca'].append(ca)
            if ob:
                r['cb'].append(cb)
    out = []
    for k, r in recs.items():
        if len(r['mx']) < 5:
            continue
        diff = 0.0
        if r['ca'] and r['cb']:
            diff = float(np.abs(np.median(np.array(r['ca']), axis=0) - np.median(np.array(r['cb']), axis=0)).sum())
        hist = np.bincount(np.array(r['y']))
        band = max(hist[max(0, i - 2):i + 3].sum() for i in range(len(hist))) / len(r['y'])
        out.append(dict(p=k[0], q=k[1], len=len(r['mx']), mx=float(np.median(r['mx'])),
                        ch=float(np.median(r['ch'])), dk=float(np.median(r['dk'])), diff=diff, band=band))
    return out


def areas_of(lab):
    ids, cnt = np.unique(lab[lab > 0], return_counts=True)
    return dict(zip(ids.tolist(), cnt.tolist()))


def apply_parent(lab, parent):
    def root(x):
        seen = set()
        while x in parent and x not in seen:
            seen.add(x)
            x = parent[x]
        return x
    remap = np.arange(lab.max() + 1)
    for i in range(1, lab.max() + 1):
        remap[i] = root(i)
    return remap[lab]


# ------------------------------------------- merge flag-artwork fragments
for _ in range(3):
    info = pair_info(lab)
    area = areas_of(lab)
    cand = {}
    for e in info:
        stripe = e['ch'] < 20                                  # channel-swapping stripe edge
        artwork = e['diff'] > DIFF and e['dk'] > DARK and e['mx'] < WEAK
        hstripe = e['diff'] > DIFF and e['band'] >= 0.95 and e['ch'] < 45 and e['dk'] > 55
        if stripe or artwork or hstripe:
            s, t = (e['p'], e['q']) if area[e['p']] <= area[e['q']] else (e['q'], e['p'])
            if s not in cand or cand[s][0] < e['len']:
                cand[s] = (e['len'], t)
    if not cand:
        break
    # every region is absorbed by at most one larger neighbour -> no chain bridging
    lab = apply_parent(lab, {s: t for s, (_, t) in cand.items()})

# ------------------------------------------------ absorb tiny fragments
for _ in range(5):
    area = areas_of(lab)
    best = {}
    for e in pair_info(lab):
        for s, t in ((e['p'], e['q']), (e['q'], e['p'])):
            if area.get(s, 0) < TINY and (s not in best or best[s][0] < e['len']):
                best[s] = (e['len'], t)
    if not best:
        break
    lab = apply_parent(lab, {s: t for s, (_, t) in best.items()})

# --------------------------------------------------------- colour classes
R, G, B = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
CLS = {
    'W': (R > 200) & (G > 200) & (B > 200),                     # white
    'rG': (R > 180) & (G < 60) & (B < 33),                      # Georgian / Armenian red
    'rA': (R > 180) & (G < 60) & (B >= 33),                     # Azerbaijani red
    'Y': (R > 220) & (G > 185) & (B < 90),                      # South Ossetian yellow
    'O': (R > 210) & (G > 110) & (G <= 185) & (B < 70),         # Armenian orange
    'lB': (R < 60) & (G > 120) & (B > 170),                     # Azerbaijani blue
    'dB': (R < 60) & (G < 90) & (B > 110),                      # Armenian blue
    'Gr': (R < 70) & (G > 120) & (B < 130),                     # green
}


def fractions(m):
    tot = max(1, int(m.sum()))
    return {k: float((v & m).sum()) / tot for k, v in CLS.items()}


def label_at(x, y):
    return int(lab[y, x])


# Nakhchivan and Vayots Dzor are not separated by a closed line on the map:
# split that region by flag colour (Armenian orange vs Azerbaijani flag).
nakh = label_at(700, 860)
m = lab == nakh
fr = fractions(m)
if fr['O'] > 0.15 and (fr['lB'] + fr['Gr'] + fr['rA']) > 0.15:
    orange = cv2.GaussianBlur(CLS['O'].astype(np.float32), (0, 0), 9)
    aze = cv2.GaussianBlur((CLS['lB'] | CLS['Gr'] | CLS['rA'] | CLS['W']).astype(np.float32), (0, 0), 9)
    part = (m & (orange > aze)).astype(np.uint8)
    k, pl, ps, _ = cv2.connectedComponentsWithStats(part, connectivity=4)
    if k > 1:
        big = 1 + int(np.argmax(ps[1:, cv2.CC_STAT_AREA]))
        new_id = int(lab.max()) + 1
        lab[(pl == big) & m] = new_id
        # leftovers of the orange mask go back to the parent region
    lab = grow(np.where(lab > 0, lab, 0))

# ------------------------------------------------ split Nagorno-Karabakh
# On the source map Karabakh is a single closed outline: its inner lines (two dark line fragments
# in the southern band, the dark seams along the stripe edges and the outlined white chevron) do not
# form closed areas, so the steps above keep it as one region. For the game every visible part must
# be a separate province, so the region is divided by a seeded priority flood whose relief is the
# strength of the visible lines: basins grow from one seed per part and meet exactly on those lines.
import heapq

NK_POINT = (869, 738)
NK_SEEDS = [
    # (id, name, seed x, seed y)
    ('NK_01', 'Карабах · Север', 885, 680),
    ('NK_02', 'Карабах · Запад', 825, 728),
    ('NK_03', 'Карабах · Восток', 905, 732),
    ('NK_04', 'Карабах · Юго-запад', 828, 772),
    ('NK_05', 'Карабах · Юг', 870, 790),
    ('NK_06', 'Карабах · Юго-восток', 922, 778),
]


def split_region(lab, point, seeds):
    region = label_at(*point)
    m = lab == region
    # relief: per-channel black-hat (real dark lines) and max-channel black-hat (seams, outlines)
    relief = np.maximum(bh_ch_d, 2.0 * bh_mx_d)
    relief = cv2.GaussianBlur(relief, (0, 0), 0.8)
    # the outlined white chevron of the flag is a visible divider: make its centre line a ridge so
    # the parts on both sides meet in its middle instead of one part running along the whole band
    white = ((a.min(axis=2) > 200) & m).astype(np.uint8)
    white = cv2.morphologyEx(white, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    wd = cv2.distanceTransform(white, cv2.DIST_L2, 5)
    relief = np.where(white > 0, 150.0 + 20.0 * wd, relief).astype(np.float32)
    out = np.zeros_like(lab)
    heap = []
    new_ids = []
    base = int(lab.max()) + 1
    for k, (_, _, sx, sy) in enumerate(seeds):
        if not m[sy, sx]:
            raise SystemExit(f'NK seed {seeds[k][0]} ({sx},{sy}) lies outside the Karabakh region')
        nid = base + k
        new_ids.append(nid)
        out[sy, sx] = nid
        heapq.heappush(heap, (0.0, sx, sy, nid))
    while heap:
        pr, x, y, nid = heapq.heappop(heap)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and m[ny, nx] and not out[ny, nx]:
                out[ny, nx] = nid
                heapq.heappush(heap, (float(relief[ny, nx]), nx, ny, nid))  # Meyer flooding
    # every part must stay one connected piece (tiny detached crumbs go to the neighbour)
    for nid in new_ids:
        part = (out == nid).astype(np.uint8)
        k, pl, ps, _ = cv2.connectedComponentsWithStats(part, connectivity=4)
        if k > 2:
            big = 1 + int(np.argmax(ps[1:, cv2.CC_STAT_AREA]))
            out[(part > 0) & (pl != big)] = 0
    lab = np.where(m, out, lab)
    lab = grow(np.where(lab > 0, lab, 0))
    return lab, dict(zip(new_ids, seeds))


lab, NK_PARTS = split_region(lab, NK_POINT, NK_SEEDS)

ids = sorted(set(np.unique(lab).tolist()) - {0})

# --------------------------------------------------------------- countries
COUNTRY_POINTS = {
    # region containing these points -> fixed country
    'abkhazia': [(158, 173)],
    'south_ossetia': [(589, 316), (613, 262)],
    'nakhchivan': [(700, 860), (670, 803)],
}
fixed = {}
for cid, pts in COUNTRY_POINTS.items():
    for (x, y) in pts:
        fixed[label_at(x, y)] = cid
for nid in NK_PARTS:
    fixed[nid] = 'artsakh'

props = {}
for i in ids:
    m = lab == i
    ys, xs = np.nonzero(m)
    fr = fractions(m)
    cx, cy = float(xs.mean()), float(ys.mean())
    if i in fixed:
        country = fixed[i]
    elif fr['lB'] + fr['rA'] + (fr['Gr'] if cx > 600 else 0) > 0.5:
        country = 'azerbaijan'
    elif fr['dB'] > 0.3 or fr['O'] > 0.5 or (fr['rG'] > 0.5 and fr['W'] < 0.3 and cy > 470):
        country = 'armenia'
    else:
        country = 'georgia'
    props[i] = dict(country=country, cx=cx, cy=cy, area=int(m.sum()), mask_bbox=(xs.min(), ys.min(), xs.max(), ys.max()))

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
        lengths = len(s)
        lines[key] = (lengths, polylines)
    return lines


borders = shared_borders(lab)

COUNTRY_ORDER = ['georgia', 'abkhazia', 'south_ossetia', 'armenia', 'azerbaijan', 'artsakh', 'nakhchivan']
COUNTRY_SHORT = {
    'georgia': 'Грузия', 'abkhazia': 'Абхазия', 'south_ossetia': 'Южная Осетия', 'armenia': 'Армения',
    'azerbaijan': 'Азербайджан', 'artsakh': 'Нагорный Карабах', 'nakhchivan': 'Нахичевань',
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
# Karabakh provinces keep the ids / names of their seeds (NK_01 ... NK_06)
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
    'source': 'image.png',
    'width': W,
    'height': H,
    'countries': COUNTRY_ORDER,
    'provinces': provinces,
    'borders': border_list,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

summary = {}
for p in provinces:
    summary.setdefault(p['country'], 0)
    summary[p['country']] += 1
print('provinces:', len(provinces), summary, file=sys.stderr)
print('borders:', len(border_list), 'size KB:', os.path.getsize(OUT) // 1024, file=sys.stderr)
