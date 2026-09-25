// Map layers on top of the original map image:
//  - territory: every owner's flag is ONE texture stretched over the bounding box of the owner's whole
//    current territory and clipped to its provinces (so captured land continues the conqueror's flag);
//  - borders: dotted province borders, stronger borders between different owners;
//  - interactive province hit-areas, labels and battle markers.
import { flagSvg } from '/shared/flags.js';
import { COUNTRIES, COUNTRY_BY_ID } from '/shared/countries.js';
import { PanZoom } from './panzoom.js';
import { countryAnchor } from '../logic.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

export class MapView {
  constructor(container, map, { onProvinceClick, onProvinceHover } = {}) {
    this.map = map;
    this.byId = new Map(map.provinces.map((p) => [p.id, p]));
    this.onProvinceClick = onProvinceClick || (() => {});
    this.onProvinceHover = onProvinceHover || (() => {});
    this.pathEls = new Map();
    this.titleEls = new Map();
    this.terrEls = new Map();
    this.flagArt = new Map();
    this.borderSig = '';
    this.territorySig = '';
    this.labelSig = '';
    this.battleSig = '';
    this.pxScale = 1;
    this.build(container);
  }

  build(container) {
    const { width: W, height: H } = this.map;
    const svg = (this.svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Карта провинций' }));
    const defs = el('defs', {}, svg);
    const hatch = el('pattern', { id: 'hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('rect', { width: 7, height: 7, fill: 'rgba(0,0,0,0.38)' }, hatch);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: 'rgba(255,90,90,0.8)', 'stroke-width': 2.4 }, hatch);

    // One flag texture per country (user-space pattern; geometry is set in renderTerritory).
    for (const c of COUNTRIES) {
      const pattern = el('pattern', { id: `flag-${c.id}`, patternUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defs);
      const art = document.importNode(new DOMParser().parseFromString(flagSvg(c.id), 'image/svg+xml').documentElement, true);
      art.setAttribute('x', 0);
      art.setAttribute('y', 0);
      art.setAttribute('width', W);
      art.setAttribute('height', H);
      art.setAttribute('preserveAspectRatio', 'none');
      pattern.appendChild(art);
      this.flagArt.set(c.id, { pattern, art });
    }

    // 1) the source map is the visual base layer (sea, outline)
    el('image', { href: '/assets/map.png', x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none' }, svg);
    // 2) territory filled with the owner's flag texture
    this.gTerritory = el('g', { class: 'territory' }, svg);
    for (const p of this.map.provinces) {
      this.terrEls.set(p.id, el('path', { d: p.path, class: 'terr', 'fill-rule': 'evenodd' }, this.gTerritory));
    }
    // 3) province borders: dotted inside one owner, solid between owners
    this.gBorders = el('g', { class: 'borders' }, svg);
    // 4) province hit areas / highlight states
    this.gProv = el('g', { class: 'provinces' }, svg);
    for (const p of this.map.provinces) {
      const path = el('path', { d: p.path, class: 'prov', 'data-id': p.id, 'fill-rule': 'evenodd' }, this.gProv);
      const title = el('title', {}, path);
      title.textContent = p.name;
      this.titleEls.set(p.id, title);
      this.pathEls.set(p.id, path);
    }
    // 5) labels & battle markers
    this.gLabels = el('g', { class: 'labels' }, svg);
    this.gMarks = el('g', { class: 'marks' }, svg);
    container.appendChild(svg);

    const land = this.landBounds();
    this.pz = new PanZoom(svg, { x: 0, y: 0, w: W, h: H }, {
      maxScale: 7,
      onTap: (target) => {
        const id = target?.closest?.('[data-id]')?.getAttribute('data-id');
        this.onProvinceClick(id || null);
      },
      onHover: (target) => {
        const id = target?.closest?.('[data-id]')?.getAttribute('data-id');
        this.onProvinceHover(id || null);
      },
      onChange: (s) => this.onScale(s),
    });
    this.pz.setHome(land);
    requestAnimationFrame(() => this.pz.reset());
  }

  landBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of this.map.provinces) {
      x0 = Math.min(x0, p.bbox[0]); y0 = Math.min(y0, p.bbox[1]);
      x1 = Math.max(x1, p.bbox[2]); y1 = Math.max(y1, p.bbox[3]);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  bboxOf(pids) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of pids) {
      const b = this.byId.get(id)?.bbox;
      if (!b) continue;
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    }
    return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  focusProvinces(pids, pad) {
    const r = this.bboxOf(pids);
    if (r) this.pz.focus(r, pad);
  }

  onScale(s) {
    // panning keeps the scale: skip the style writes (they restyle every label / border)
    if (Math.abs(s - this.pxScale) < 1e-4 && this._scaled) return;
    this._scaled = true;
    this.pxScale = s;
    // keep labels readable (~12px) regardless of zoom
    const fs = Math.max(6, Math.min(40, 12.5 / s));
    this.gLabels.style.fontSize = `${fs}px`;
    this.gLabels.style.strokeWidth = `${fs * 0.24}px`;
    this.gMarks.style.fontSize = `${Math.max(8, Math.min(44, 15 / s))}px`;
    this.gMarks.style.strokeWidth = `${Math.max(1.5, 3 / s)}px`;
    // one screen pixel in map units: border widths and dash patterns stay crisp at any zoom
    this.gBorders.style.setProperty('--u', `${1 / s}px`);
  }

  /**
   * @param {object} state server snapshot
   * @param {object} ctx { mode: 'select'|'game'|'target', me, hoverCountry, selectedCountry, hoverProvince, picked, targets:Set }
   */
  render(state, ctx) {
    if (!state) return;
    const { mode, me } = ctx;
    for (const p of this.map.provinces) {
      const path = this.pathEls.get(p.id);
      const owner = state.provinces[p.id];
      const cls = ['prov'];
      if (owner !== p.country) cls.push('captured');
      if (mode === 'select') {
        const c = state.countries[owner];
        if (c?.player && c.player !== ctx.playerId) cls.push('occupied');
        if (owner === ctx.selectedCountry) cls.push('sel');
        else if (owner === ctx.hoverCountry) cls.push('hover');
      } else if (mode === 'target') {
        if (ctx.targets?.has(p.id)) cls.push('target');
        else if (owner !== me) cls.push('dim');
        if (owner === me) cls.push('mine');
        if (ctx.hoverProvince === p.id && ctx.targets?.has(p.id)) cls.push('picked');
      } else {
        if (owner === me) cls.push('mine');
        if (ctx.hoverProvince === p.id) cls.push('hover');
        if (ctx.picked === p.id) cls.push('picked');
      }
      const className = cls.join(' ');
      if (path.getAttribute('class') !== className) path.setAttribute('class', className);
    }
    // state.provinces is replaced (new object) only when some owner changed (see shared/sync.js),
    // so identity is a free "territory changed" signal: geometry work happens only after captures.
    const ownersSig = state.provinces;
    this.renderTerritory(state, ownersSig);
    this.renderBorders(state, ownersSig);
    this.renderLabels(state, ctx);
    this.renderBattles(state, ctx.now);
  }

  /**
   * Fill every province with its owner's flag. The flag of a country is a single texture spanning the
   * bounding box of ALL provinces it currently owns, so neighbouring provinces (original or captured)
   * show one continuous flag clipped to the territory's shape - never a repeated per-province flag.
   */
  renderTerritory(state, sig) {
    if (sig === this.territorySig) return;
    this.territorySig = sig;
    this.ownersGen = (this.ownersGen || 0) + 1;
    const PAD = 2; // province fills get a thin same-texture stroke to hide seams; keep it inside the tile
    const owned = new Map();
    for (const p of this.map.provinces) {
      const owner = state.provinces[p.id];
      if (!owned.has(owner)) owned.set(owner, []);
      owned.get(owner).push(p.id);
    }
    for (const [owner, pids] of owned) {
      const f = this.flagArt.get(owner);
      const r = this.bboxOf(pids);
      if (!f || !r) continue;
      const x = r.x - PAD, y = r.y - PAD, w = r.w + 2 * PAD, h = r.h + 2 * PAD;
      for (const [k, v] of Object.entries({ x, y, width: w, height: h })) f.pattern.setAttribute(k, v);
      f.art.setAttribute('width', w);
      f.art.setAttribute('height', h);
    }
    for (const p of this.map.provinces) {
      const owner = state.provinces[p.id];
      const paint = this.flagArt.has(owner) ? `url(#flag-${owner})` : '#777';
      const style = `fill:${paint};stroke:${paint}`;
      const t = this.terrEls.get(p.id);
      if (t.getAttribute('style') !== style) t.setAttribute('style', style);
      // hover tooltip: "Карабах · Север (NK_01) / Владелец: …"
      const title = `${p.name} (${p.id})\nВладелец: ${COUNTRY_BY_ID[owner]?.name ?? owner}`;
      const tEl = this.titleEls.get(p.id);
      if (tEl.textContent !== title) tEl.textContent = title;
    }
  }

  /**
   * Border polylines are created once; after a capture only the borders whose "same owner" status
   * flipped are moved between the faint (inner) and the state-border (outer) group.
   */
  renderBorders(state, sig) {
    if (sig === this.borderSig) return;
    this.borderSig = sig;
    if (!this.borderEls) {
      this.gInner = el('g', { class: 'prov-borders' }, this.gBorders);
      this.gOuter = el('g', { class: 'owner-borders' }, this.gBorders);
      this.borderEls = this.map.borders.map((b) => ({
        b,
        outer: null,
        els: b.lines.map((line) => el('polyline', { points: line.map((p) => p.join(',')).join(' ') })),
      }));
    }
    for (const item of this.borderEls) {
      // same owner -> faint dotted province border; different owners -> state border
      const outer = state.provinces[item.b.a] !== state.provinces[item.b.b];
      if (outer === item.outer) continue;
      item.outer = outer;
      const parent = outer ? this.gOuter : this.gInner;
      const cls = outer ? 'owner-border' : 'prov-border';
      for (const e of item.els) {
        e.setAttribute('class', cls);
        parent.appendChild(e); // moves the existing node
      }
    }
  }

  renderLabels(state, ctx) {
    const parts = [];
    for (const cid of Object.keys(state.countries)) {
      const c = state.countries[cid];
      if (c.eliminated) continue;
      if (ctx.mode !== 'select' && !c.player) continue;
      parts.push(`${cid}:${c.player || ''}:${c.playerName || ''}:${c.provinces}`);
    }
    const sig = `${ctx.mode}|${parts.join('|')}|${ctx.mode === 'select' ? this.ownersGen : ''}`;
    if (sig === this.labelSig) return;
    this.labelSig = sig;
    this.gLabels.replaceChildren();
    for (const cid of Object.keys(state.countries)) {
      const c = state.countries[cid];
      if (c.eliminated) continue;
      const anchor = countryAnchor(state, this.map, cid);
      if (!anchor) continue;
      const [x, y] = anchor.label;
      if (ctx.mode === 'select') {
        const t = el('text', { x, y: y - 0.2, class: 'map-label' }, this.gLabels);
        t.textContent = COUNTRY_BY_ID[cid].name;
        if (c.player) {
          const s = el('text', { x, y, dy: '1.25em', class: 'map-label sub locked' }, this.gLabels);
          s.textContent = `🔒 ${c.playerName || 'занято'}`;
        }
      } else if (c.player) {
        const s = el('text', { x, y, class: 'map-label sub' }, this.gLabels);
        s.textContent = `${c.player === ctx.playerId ? '★ ' : ''}${c.playerName}`;
      }
    }
  }

  renderBattles(state, now = Date.now()) {
    const sig = state.battles.map((b) => b.id).join(',');
    if (sig !== this.battleSig) {
      this.battleSig = sig;
      this.gMarks.replaceChildren();
      this.battleEls = new Map();
      for (const b of state.battles) {
        const p = this.byId.get(b.province);
        if (!p) continue;
        const g = el('g', { class: 'battle-mark', transform: `translate(${p.label[0]},${p.label[1]})` }, this.gMarks);
        const r = Math.max(10, Math.min(26, p.labelRadius));
        el('circle', { r, class: 'ring' }, g);
        const t = el('text', { y: 0 }, g);
        t.textContent = '⚔';
        const c = el('text', { y: '1.2em', class: 'cd' }, g);
        this.battleEls.set(b.id, { c, b });
      }
    }
    if (this.battleEls) {
      for (const { c, b } of this.battleEls.values()) {
        const s = Math.max(0, Math.ceil((b.endsAt - now) / 1000));
        const txt = `${s}с`;
        if (c.textContent !== txt) c.textContent = txt;
      }
    }
  }

  flash(pid) {
    const p = this.pathEls.get(pid);
    if (!p) return;
    p.classList.remove('flash');
    void p.getBBox();
    p.classList.add('flash');
    setTimeout(() => p.classList.remove('flash'), 1300);
  }
}
