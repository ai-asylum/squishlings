// Traits, rarity, stats, and names — the collection-game layer.
// A creature's traits are derived from its genome; each trait has a gacha
// rarity tier (C / UC / SR / SSR) and the creature's overall grade
// (N / R / SR / SSR) comes from summing trait points plus its generation.
import { mulberry32 } from './rng.js';

export const TIER_POINTS = { C: 0, UC: 1, SR: 3, SSR: 7 };

export const GRADE_META = {
  N: { label: 'N', name: 'Normal', color: '#8b93a3' },
  R: { label: 'R', name: 'Rare', color: '#4d9de0' },
  SR: { label: 'SR', name: 'Super Rare', color: '#9b5de5' },
  SSR: { label: 'SSR', name: 'SUPER SPECIAL RARE', color: '#f0a020' },
};

export const COLOR_NAMES = [
  'cherry', 'coral', 'amber', 'lemon', 'lime', 'leaf',
  'mint', 'sky', 'ocean', 'grape', 'plum', 'rose',
];

// The full catalog, for the encyclopedia. id -> {label, cat, tier, hint}
export const ALL_TRAITS = [
  { id: 'plan:biped', label: 'Biped', cat: 'Body plan', tier: 'C' },
  { id: 'plan:quad', label: 'Quadruped', cat: 'Body plan', tier: 'C' },
  { id: 'plan:hopper', label: 'Hopper', cat: 'Body plan', tier: 'C' },
  { id: 'plan:flyer', label: 'Flyer', cat: 'Body plan', tier: 'UC' },
  { id: 'plan:hexa', label: 'Hexapod', cat: 'Body plan', tier: 'UC' },
  { id: 'legs:8', label: 'Octopod', cat: 'Body plan', tier: 'SSR', hint: 'eight whole legs' },
  { id: 'wings:4', label: 'Dragonfly wings', cat: 'Body plan', tier: 'SR', hint: 'two whole pairs' },

  { id: 'eyes:2', label: 'Two eyes', cat: 'Face', tier: 'C' },
  { id: 'eyes:1', label: 'Cyclops', cat: 'Face', tier: 'SR' },
  { id: 'eyes:3', label: 'Third eye', cat: 'Face', tier: 'SR' },
  { id: 'face:blush', label: 'Blush', cat: 'Face', tier: 'C' },
  { id: 'face:snout', label: 'Snout', cat: 'Face', tier: 'C' },
  { id: 'face:nose', label: 'Button nose', cat: 'Face', tier: 'UC' },

  { id: 'ears:nub', label: 'Nub ears', cat: 'Appendages', tier: 'C' },
  { id: 'ears:bunny', label: 'Bunny ears', cat: 'Appendages', tier: 'C' },
  { id: 'ears:antenna1', label: 'Uni-antenna', cat: 'Appendages', tier: 'UC' },
  { id: 'ears:antenna2', label: 'Antennae', cat: 'Appendages', tier: 'C' },
  { id: 'ears:antenna3', label: 'Tri-antennae', cat: 'Appendages', tier: 'SR', hint: 'three wiggly feelers' },
  { id: 'ears:lantern', label: 'Lantern feelers', cat: 'Appendages', tier: 'SR', hint: 'glowy tips' },
  { id: 'tail:tail', label: 'Tail', cat: 'Appendages', tier: 'C' },
  { id: 'tail:puff', label: 'Puff tail', cat: 'Appendages', tier: 'UC' },
  { id: 'arms:stubs', label: 'Stub arms', cat: 'Appendages', tier: 'UC' },

  ...COLOR_NAMES.map((c) => ({
    id: `color:${c}`, label: c[0].toUpperCase() + c.slice(1), cat: 'Colorway', tier: 'C',
  })),
  { id: 'special:void', label: 'Void', cat: 'Colorway', tier: 'SR', hint: 'woven from night sky' },
  { id: 'special:golden', label: 'Golden', cat: 'Colorway', tier: 'SSR', hint: 'blessed and shiny' },
];

const TRAIT_BY_ID = new Map(ALL_TRAITS.map((t) => [t.id, t]));
export const traitById = (id) => TRAIT_BY_ID.get(id);

export function colorBucket(color) {
  const hsl = {};
  color.getHSL(hsl);
  return COLOR_NAMES[Math.floor(((hsl.h % 1) + 1) % 1 * 12) % 12];
}

// ---------------------------------------------------------------------------
export function extractTraits(g) {
  const ids = [`plan:${g.plan}`];
  if (g.legs.count === 8) ids.push('legs:8');
  ids.push(`eyes:${g.eyes.count || 2}`);
  if (g.blush) ids.push('face:blush');
  if (g.head.snout) ids.push(g.head.snout.nose ? 'face:nose' : 'face:snout');
  if (g.ears) {
    if (g.ears.type === 'antenna') {
      ids.push(`ears:antenna${g.ears.count || 2}`);
      if (g.ears.tip === 'lantern') ids.push('ears:lantern');
    } else if (g.ears.type === 'bunny') ids.push('ears:bunny');
    else ids.push('ears:nub');
  }
  if (g.wings?.pairs === 2) ids.push('wings:4');
  if (g.tail) ids.push(g.tail.puff ? 'tail:puff' : 'tail:tail');
  if (g.arms && g.plan === 'hopper') ids.push('arms:stubs');
  if (g.palette.special) ids.push(`special:${g.palette.special}`);
  else ids.push(`color:${colorBucket(g.palette.base)}`);
  return ids.map((id) => TRAIT_BY_ID.get(id)).filter(Boolean);
}

export function gradeOf(g) {
  const traits = extractTraits(g);
  let points = 0;
  for (const t of traits) points += TIER_POINTS[t.tier];
  const gen = g.generation || 0;
  points += Math.floor(Math.min(gen, 6) / 2);
  const tier = points >= 7 ? 'SSR' : points >= 4 ? 'SR' : points >= 2 ? 'R' : 'N';
  return { points, tier, ...GRADE_META[tier], traits };
}

// ---------------------------------------------------------------------------
const fmt = (v, digits = 1) => Number(v.toFixed(digits)).toString();

export function extractStats(g, runtime = {}) {
  const s = g.scale;
  const rows = [];
  const volume = (4 / 3) * Math.PI * Math.pow(g.body.r0 * s, 3) * 1000;
  rows.push({ label: 'Volume', value: volume >= 1000 ? `${fmt(volume / 1000, 2)} kL` : `${fmt(volume, 0)} L` });
  const height = ((g.legs.count ? g.legs.len : 0) + g.body.r0 * 2 + g.body.len * 0.6 + g.head.r) * s;
  rows.push({ label: 'Height', value: `${fmt(height * 100, 0)} cm` });
  if (g.ears?.type === 'antenna') {
    rows.push({ label: 'Antennae', value: `${g.ears.count || 2} × ${fmt(g.ears.len * s * 100, 0)} cm` });
  }
  if (g.legs.count) rows.push({ label: 'Legs', value: `${g.legs.count}` });
  if (g.wings) rows.push({ label: 'Wingspan', value: `${fmt(g.wings.len * s * 2.3 * 100, 0)} cm` });
  rows.push({ label: 'Speed', bar: (g.speed - 0.7) / 0.65 });
  rows.push({ label: 'Bounce', bar: (g.bounciness - 0.75) / 0.65 });
  rows.push({ label: 'Curiosity', bar: g.curiosity });
  const flop = Math.max(g.tail?.flop ?? -1, g.ears?.flop ?? -1);
  if (flop >= 0) rows.push({ label: 'Floppiness', bar: flop });
  rows.push({ label: 'Generation', value: `${g.generation || 0}` });
  if (runtime.absorbed) rows.push({ label: 'Snacked', value: `×${runtime.absorbed}` });
  return rows;
}

// ---------------------------------------------------------------------------
const SYL_A = ['bo', 'pi', 'mo', 'zu', 'ta', 'glo', 'mi', 'snu', 'bli', 'po', 'wu', 'flo', 'ki', 'doo', 'squ', 'ni', 'bu'];
const SYL_B = ['bble', 'mp', 'nkle', 'ppy', 'zzle', 'bbo', 'ppo', 'mbi', 'ngle', 'sh', 'llo', 'ff', 'zby', 'nk'];

export function makeName(seed) {
  const r = mulberry32(seed ^ 0x5EED);
  let n = SYL_A[(r() * SYL_A.length) | 0];
  if (r() < 0.45) n += SYL_A[(r() * SYL_A.length) | 0];
  n += SYL_B[(r() * SYL_B.length) | 0];
  return n[0].toUpperCase() + n.slice(1);
}
