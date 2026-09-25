import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COUNTRIES } from '../shared/countries.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MAP_FILE = path.resolve(here, '..', 'data', 'map.json');

/**
 * Loads the province graph generated from image.png (see tools/build_map_data.py)
 * and builds the lookup structures used by the game logic.
 */
export function loadMap(file = MAP_FILE) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const provinces = new Map();
  for (const p of raw.provinces) {
    provinces.set(p.id, {
      id: p.id,
      name: p.name,
      country: p.country,
      neighbors: new Set(p.neighbors),
      label: p.label,
      bbox: p.bbox,
      area: p.area,
    });
  }
  // sanity checks: adjacency must be symmetric and refer to known provinces
  for (const p of provinces.values()) {
    for (const n of p.neighbors) {
      const other = provinces.get(n);
      if (!other || !other.neighbors.has(p.id)) {
        throw new Error(`Invalid adjacency between ${p.id} and ${n}`);
      }
    }
  }
  const known = new Set(COUNTRIES.map((c) => c.id));
  for (const p of provinces.values()) {
    if (!known.has(p.country)) throw new Error(`Unknown country ${p.country} for ${p.id}`);
  }
  return { width: raw.width, height: raw.height, provinces };
}
