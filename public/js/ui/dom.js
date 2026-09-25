import { flagDataUri } from '/shared/flags.js';
import { COUNTRY_BY_ID } from '/shared/countries.js';

export const $ = (sel, root = document) => root.querySelector(sel);

const lastHtml = new WeakMap();
/**
 * Replaces innerHTML only when the markup actually changed, so frequent state broadcasts
 * don't recreate buttons under the user's finger (a tap would otherwise be lost).
 */
export function setHtml(el, html) {
  if (lastHtml.get(el) === html) return false;
  lastHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function flagHtml(countryId, cls = '') {
  return `<span class="flag ${cls}" style="background-image:url('${flagDataUri(countryId)}')" role="img" aria-label="Флаг: ${esc(countryName(countryId))}"></span>`;
}

export const countryName = (id) => COUNTRY_BY_ID[id]?.name ?? id;
export const countryColor = (id) => COUNTRY_BY_ID[id]?.color ?? '#888';

export const fmt = (n) => Math.round(n ?? 0).toLocaleString('ru-RU');

export function chanceHtml(chance) {
  const cls = chance < 35 ? 'lo' : chance < 65 ? 'mid' : 'hi';
  return `<span class="chance ${cls}">${chance}%</span>`;
}

export function timeHtml(ts) {
  const d = new Date(ts);
  return `<time>${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>`;
}
