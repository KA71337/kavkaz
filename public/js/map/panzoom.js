// Mouse / touch / pen pan & zoom for an SVG via its viewBox (no layout thrashing, crisp at any zoom).

const TAP_SLOP = 8;

export class PanZoom {
  constructor(svg, bounds, { maxScale = 8, onTap, onHover, onChange } = {}) {
    this.svg = svg;
    this.bounds = bounds; // full map rect in svg units
    this.home = { ...bounds };
    this.maxScale = maxScale;
    this.onTap = onTap || (() => {});
    this.onHover = onHover || (() => {});
    this.onChange = onChange || (() => {});
    this.vb = { ...bounds };
    this.pointers = new Map();
    this.gesture = null;
    this._anim = null;
    this.bind();
    this.apply();
  }

  setHome(rect) {
    this.home = { ...rect };
  }

  /**
   * Cached client rect of the svg. Reading getBoundingClientRect on every pointermove right after a
   * viewBox write forces a style/layout flush; the box itself only changes on resize (ResizeObserver).
   */
  rect(fresh = false) {
    if (fresh || !this._rect || !this._rect.width) this._rect = this.svg.getBoundingClientRect();
    return this._rect;
  }

  /** width/height of the rendered svg, or null while it is hidden (display:none / 0×0). */
  viewAspect() {
    const r = this.rect(true);
    return r.width > 0 && r.height > 0 ? r.width / r.height : null;
  }

  /** Runs `fn` now if the svg has a size, otherwise as soon as it gets one. */
  whenSized(fn) {
    if (this.viewAspect()) {
      this._pending = null;
      fn();
    } else {
      this._pending = fn;
    }
  }

  apply() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (![this.vb.x, this.vb.y, this.vb.w, this.vb.h].every(Number.isFinite)) this.vb = { ...this.bounds };
    const { x, y, w, h } = this.vb;
    this.svg.setAttribute('viewBox', `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`);
    this.onChange(this.pxScale());
  }

  /** Gesture updates: many pointermove events per frame collapse into one viewBox write. */
  applySoon() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.apply();
    });
  }

  /** screen pixels per svg unit (preserveAspectRatio = meet) */
  pxScale() {
    const r = this.rect();
    if (!r.width || !r.height) return 1;
    return Math.min(r.width / this.vb.w, r.height / this.vb.h);
  }

  clientToSvg(cx, cy) {
    const r = this.rect();
    const s = this.pxScale();
    const ox = (r.width - this.vb.w * s) / 2;
    const oy = (r.height - this.vb.h * s) / 2;
    return { x: this.vb.x + (cx - r.left - ox) / s, y: this.vb.y + (cy - r.top - oy) / s };
  }

  clamp() {
    const b = this.bounds;
    const minW = b.w / this.maxScale;
    const maxW = b.w * 1.15;
    if (this.vb.w < minW || this.vb.w > maxW) {
      const nw = Math.min(maxW, Math.max(minW, this.vb.w));
      const f = nw / this.vb.w;
      const cx = this.vb.x + this.vb.w / 2;
      const cy = this.vb.y + this.vb.h / 2;
      this.vb.w = nw;
      this.vb.h *= f;
      this.vb.x = cx - nw / 2;
      this.vb.y = cy - this.vb.h / 2;
    }
    const cx = Math.min(b.x + b.w, Math.max(b.x, this.vb.x + this.vb.w / 2));
    const cy = Math.min(b.y + b.h, Math.max(b.y, this.vb.y + this.vb.h / 2));
    this.vb.x = cx - this.vb.w / 2;
    this.vb.y = cy - this.vb.h / 2;
  }

  zoomAt(factor, cx, cy, render = true) {
    const p = this.clientToSvg(cx, cy);
    const b = this.bounds;
    const nw = Math.min(b.w * 1.15, Math.max(b.w / this.maxScale, this.vb.w * factor));
    const f = nw / this.vb.w;
    this.vb.x = p.x - (p.x - this.vb.x) * f;
    this.vb.y = p.y - (p.y - this.vb.y) * f;
    this.vb.w = nw;
    this.vb.h *= f;
    this.clamp();
    if (render) this.applySoon();
  }

  zoomCenter(factor) {
    const r = this.svg.getBoundingClientRect();
    this.animateTo(null, factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  panBy(dxPx, dyPx) {
    const s = this.pxScale();
    this.vb.x -= dxPx / s;
    this.vb.y -= dyPx / s;
    this.clamp();
    this.applySoon();
  }

  /** Show `rect` (svg units) with padding, animated. */
  focus(rect, pad = 0.18) {
    const aspect = this.viewAspect();
    if (!aspect) return this.whenSized(() => this.focus(rect, pad));
    this._pending = null;
    const w = rect.w * (1 + pad * 2);
    const h = rect.h * (1 + pad * 2);
    let tw = Math.max(w, h * aspect);
    tw = Math.max(tw, this.bounds.w / this.maxScale);
    tw = Math.min(tw, this.bounds.w * 1.15);
    const th = tw / aspect;
    const target = { x: rect.x + rect.w / 2 - tw / 2, y: rect.y + rect.h / 2 - th / 2, w: tw, h: th };
    this.animateTo(target);
  }

  reset() {
    const aspect = this.viewAspect();
    if (!aspect) return this.whenSized(() => this.reset());
    this._pending = null;
    const h = this.home;
    const w = Math.max(h.w, h.h * aspect);
    const hh = w / aspect;
    this.animateTo({ x: h.x + h.w / 2 - w / 2, y: h.y + h.h / 2 - hh / 2, w, h: hh });
  }

  animateTo(target, factor, cx, cy) {
    cancelAnimationFrame(this._anim);
    const from = { ...this.vb };
    let to = target;
    if (!to) {
      const saved = { ...this.vb };
      this.zoomAt(factor, cx, cy, false);
      to = { ...this.vb };
      this.vb = saved;
    } else {
      // normalise aspect of target to current view aspect so interpolation is smooth
      const ar = from.w / from.h;
      if (to.w / to.h > ar) {
        const nh = to.w / ar;
        to = { ...to, y: to.y - (nh - to.h) / 2, h: nh };
      } else {
        const nw = to.h * ar;
        to = { ...to, x: to.x - (nw - to.w) / 2, w: nw };
      }
    }
    const t0 = performance.now();
    const dur = 320;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.vb = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        w: from.w + (to.w - from.w) * e,
        h: from.h + (to.h - from.h) * e,
      };
      if (k === 1) this.clamp();
      this.apply();
      if (k < 1) this._anim = requestAnimationFrame(step);
    };
    this._anim = requestAnimationFrame(step);
  }

  bind() {
    const el = this.svg;
    el.addEventListener('pointerdown', (e) => {
      cancelAnimationFrame(this._anim);
      if (!this.pointers.size) this.rect(true);
      el.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.gesture = { sx: e.clientX, sy: e.clientY, moved: false, target: e.target, pinch: false, t: performance.now() };
      } else if (this.gesture) {
        this.gesture.pinch = true;
        this.gesture.moved = true;
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') this.onHover(e.target);
        return;
      }
      const prev = this.pointers.get(e.pointerId);
      if (this.pointers.size === 1) {
        const g = this.gesture;
        if (g && !g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > TAP_SLOP) {
          g.moved = true;
          el.classList.add('dragging');
        }
        if (g?.moved) this.panBy(e.clientX - prev.x, e.clientY - prev.y);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const pm = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const pd = Math.hypot(a.x - b.x, a.y - b.y);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [c, d] = [...this.pointers.values()];
        const nm = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
        const nd = Math.hypot(c.x - d.x, c.y - d.y);
        if (pd > 0 && nd > 0) this.zoomAt(pd / nd, pm.x, pm.y);
        this.panBy(nm.x - pm.x, nm.y - pm.y);
      }
    });

    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      el.releasePointerCapture?.(e.pointerId);
      if (this.pointers.size === 0) {
        const g = this.gesture;
        el.classList.remove('dragging');
        this.gesture = null;
        if (g && !g.moved && !g.pinch && e.type === 'pointerup') this.onTap(g.target, e);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.pointers.size) this.onHover(null);
    });

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        cancelAnimationFrame(this._anim);
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomAt(Math.pow(1.0018, delta), e.clientX, e.clientY);
      },
      { passive: false },
    );
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.animateTo(null, 0.5, e.clientX, e.clientY);
    });
    // Fires on window resize, orientation change and when the game screen becomes visible.
    const onResize = () => {
      if (!this.viewAspect()) return;
      const pending = this._pending;
      this._pending = null;
      if (pending) return pending();
      this.clamp();
      this.apply();
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(el);
    else window.addEventListener('resize', onResize);
  }
}
