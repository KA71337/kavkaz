// Simplified SVG flags (viewBox 0 0 30 20) for every playable country.

const W = 30;
const H = 20;

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 4}" height="${H * 4}">${body}</svg>`;
}

function stripes(colors) {
  const h = H / colors.length;
  return colors.map((c, i) => `<rect x="0" y="${i * h}" width="${W}" height="${h + 0.05}" fill="${c}"/>`).join('');
}

function star(cx, cy, r, points, fill) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const ang = (Math.PI * i) / points - Math.PI / 2;
    pts.push(`${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

function smallCross(cx, cy) {
  return `<rect x="${cx - 0.5}" y="${cy - 2}" width="1" height="4" fill="#ff0000"/><rect x="${cx - 2}" y="${cy - 0.5}" width="4" height="1" fill="#ff0000"/>`;
}

// Colours are sampled from the source map (image.png) so re-painted territory matches it.
const FLAGS = {
  georgia: svg(
    `<rect width="${W}" height="${H}" fill="#f9f9f9"/>` +
      `<rect x="13" y="0" width="4" height="${H}" fill="#e40315"/><rect x="0" y="8" width="${W}" height="4" fill="#e40315"/>` +
      smallCross(6.5, 4) + smallCross(23.5, 4) + smallCross(6.5, 16) + smallCross(23.5, 16),
  ),
  abkhazia: svg(
    stripes(['#03863a', '#fff', '#03863a', '#fff', '#03863a', '#fff', '#03863a']) +
      `<rect x="0" y="0" width="12" height="8.6" fill="#d80411"/>` +
      `<path d="M5.2 6.6 v-2.6 q0-.6.5-.6 t.5.6 v-1.5 q0-.6.5-.6 t.5.6 v1.5 q0-.6.5-.6 t.5.6 v2.6 z" fill="#fff"/>` +
      [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const a = Math.PI * (0.95 + (i * 1.1) / 6);
        return star(6.2 + 4.4 * Math.cos(a) * -1, 4.9 + 3.4 * Math.sin(a), 0.55, 5, '#fff');
      }).join(''),
  ),
  south_ossetia: svg(stripes(['#f9f9f9', '#de0212', '#fcd504'])),
  armenia: null, // Polgonustan: raster flag, see FLAG_IMAGES below
  azerbaijan: svg(
    stripes(['#01a0d6', '#df022d', '#08a052']) +
      `<circle cx="14" cy="10" r="3" fill="#fff"/><circle cx="14.8" cy="10" r="2.45" fill="#df022d"/>` +
      star(18, 10, 1.5, 8, '#fff'),
  ),
  artsakh: svg(
    stripes(['#d8050a', '#0133a9', '#f89b05']) +
      `<path d="M30 3 h-4 v2 h-2 v2 h-2 v2 h-2 v2 h2 v2 h2 v2 h2 v2 h4 v-2 h-2 v-2 h-2 v-2 h-2 v-2 h2 v-2 h2 v-2 h2 z" fill="#fff"/>`,
  ),
  nakhchivan: null,
};
FLAGS.nakhchivan = FLAGS.azerbaijan;

// Raster flags (served by server/index.js from the repository root). 'armenia' is the internal id of
// Polgonustan; its flag is the image `полгонустан.jpeg` (3:2, same proportions as the SVG flags).
export const FLAG_IMAGES = {
  armenia: '/assets/flags/polgonustan.jpeg',
};
for (const [id, url] of Object.entries(FLAG_IMAGES)) {
  FLAGS[id] = svg(`<image href="${url}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`);
}

/** SVG markup of a flag; meant to be inlined into the document (the map uses it as a territory texture). */
export function flagSvg(countryId) {
  return FLAGS[countryId] || svg(`<rect width="${W}" height="${H}" fill="#777"/>`);
}

const cache = new Map();
/**
 * URL usable in CSS / <img>. Raster flags return their direct URL: browsers don't load external images
 * referenced from inside an SVG that is itself used as an image (data: URI in background-image).
 */
export function flagDataUri(countryId) {
  if (FLAG_IMAGES[countryId]) return FLAG_IMAGES[countryId];
  if (!cache.has(countryId)) {
    cache.set(countryId, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(flagSvg(countryId))}`);
  }
  return cache.get(countryId);
}
