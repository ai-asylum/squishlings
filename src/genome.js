// Creature genome: one seed -> a full body plan (plan type, proportions,
// appendages, palette, personality). Pure data; the Creature class turns
// this into a rig + SDF primitive list.
import * as THREE from 'three';
import { RNG } from './rng.js';

export const PLANS = ['biped', 'quad', 'hexa', 'hopper', 'flyer'];

// -- palette ----------------------------------------------------------------
// Special colorways: rare full-palette overrides.
export function applySpecial(palette, kind) {
  palette.special = kind;
  if (kind === 'golden') {
    palette.base = new THREE.Color().setHSL(0.115, 0.88, 0.6);
    palette.belly = new THREE.Color().setHSL(0.13, 0.85, 0.85);
    palette.accent = new THREE.Color().setHSL(0.09, 0.95, 0.55);
    palette.blush = new THREE.Color().setHSL(0.05, 0.9, 0.72);
  } else if (kind === 'void') {
    palette.base = new THREE.Color().setHSL(0.72, 0.45, 0.24);
    palette.belly = new THREE.Color().setHSL(0.74, 0.4, 0.5);
    palette.accent = new THREE.Color().setHSL(0.78, 0.9, 0.72);
    palette.blush = new THREE.Color().setHSL(0.85, 0.7, 0.6);
  }
  return palette;
}

// Candy/sorbet palette: pastel body, cream belly, punchy accent.
function makePalette(rng) {
  const h = rng.next();
  const scheme = rng.pickW([['analog', 3], ['comp', 2], ['triad', 1]]);
  let accentH;
  if (scheme === 'analog') accentH = (h + rng.float(0.06, 0.14) * rng.sign() + 1) % 1;
  else if (scheme === 'comp') accentH = (h + 0.5 + rng.float(-0.06, 0.06) + 1) % 1;
  else accentH = (h + 0.33 * rng.sign() + 1) % 1;

  const base = new THREE.Color().setHSL(h, rng.float(0.62, 0.8), rng.float(0.6, 0.7));
  const belly = new THREE.Color().setHSL(
    (h + rng.float(-0.04, 0.06) + 1) % 1, rng.float(0.45, 0.7), rng.float(0.82, 0.9));
  const accent = new THREE.Color().setHSL(accentH, rng.float(0.65, 0.85), rng.float(0.58, 0.7));
  const blush = new THREE.Color().setHSL(
    rng.float(0.96, 1.02) % 1, 0.75, 0.74);
  return { base, belly, accent, blush, special: null };
}

// -- genome -----------------------------------------------------------------
// `luck` (0..~2) boosts the odds of rare traits — earned by merging
// similar-sized, high-generation squishlings.
export function makeGenome(seed, forcedPlan = null, luck = 0) {
  const rng = new RNG(seed);
  const rare = (base) => Math.min(base * (1 + luck * 2.5), 0.5);
  const plan = forcedPlan || rng.pickW([
    ['biped', 3], ['quad', 2.5], ['hexa', 1.6], ['hopper', 2.2], ['flyer', 2.2],
  ]);

  const g = {
    seed, plan,
    scale: rng.float(0.8, 1.2),
    palette: makePalette(rng),
    generation: 0,
    // personality
    speed: rng.float(0.75, 1.3),
    wanderlust: rng.float(0.5, 1.0),   // how often it decides to go somewhere
    blinkRate: rng.float(0.7, 1.5),
    curiosity: rng.float(0.2, 0.9),    // chance to look at the camera / others
    bounciness: rng.float(0.8, 1.3),
  };

  // ---- torso --------------------------------------------------------------
  // Torso is 2 blobs (hip + chest). Long bodies for quads/hexa, upright
  // teardrops for hoppers, chubby uprights for bipeds, small pods for flyers.
  const r0 = rng.float(0.34, 0.46); // hip blob radius (pre-scale)
  g.body = { r0, r1: r0 * rng.float(0.8, 1.15), len: 0, upright: 0, height: 0 };

  switch (plan) {
    case 'biped':
      g.body.len = r0 * rng.float(0.4, 0.8);
      g.body.upright = rng.float(0.75, 1.0); // mostly vertical torso
      break;
    case 'quad':
      g.body.len = r0 * rng.float(1.2, 1.9);
      g.body.upright = rng.float(0.0, 0.2);
      g.body.r1 = r0 * rng.float(0.9, 1.25);
      break;
    case 'hexa':
      g.body.len = r0 * rng.float(1.0, 1.5);
      g.body.upright = rng.float(0.0, 0.15);
      g.body.r1 = r0 * rng.float(0.75, 1.0);
      break;
    case 'hopper':
      g.body.r0 = r0 * rng.float(1.15, 1.35); // one big squishy teardrop
      g.body.r1 = g.body.r0 * rng.float(0.55, 0.8);
      g.body.len = g.body.r0 * rng.float(0.65, 0.95);
      g.body.upright = 1.0;
      break;
    case 'flyer':
      g.body.r0 = r0 * rng.float(0.8, 1.0);
      g.body.r1 = g.body.r0 * rng.float(0.7, 0.95);
      g.body.len = g.body.r0 * rng.float(0.5, 0.9);
      g.body.upright = rng.float(0.35, 0.7);
      break;
  }

  // ---- head ---------------------------------------------------------------
  g.head = {
    r: g.body.r0 * rng.float(0.62, 0.95),
    up: rng.float(0.5, 0.9),      // how high above chest
    fwd: rng.float(0.05, 0.35),   // how far forward
    snout: rng.bool(0.55) ? {
      len: rng.float(0.3, 0.7), r: rng.float(0.4, 0.62), nose: rng.bool(0.6),
    } : null,
  };
  if (plan === 'hopper') g.head.r *= 0.9; // head melts into the teardrop

  // ---- eyes ---------------------------------------------------------------
  const eyeR = Math.max(g.head.r * rng.float(0.3, 0.46), 0.09);
  g.eyes = {
    r: eyeR,
    spread: rng.float(0.45, 0.75),
    up: rng.float(0.05, 0.35),
    pupil: rng.float(0.45, 0.62), // pupil size as cos-cutoff tightness
    count: rng.pickW([[1, rare(0.03)], [2, 1], [3, rare(0.035)]]),
  };
  g.blush = rng.bool(0.65);

  // ---- special colorway (rare!) --------------------------------------------
  const roll = rng.next();
  if (roll < rare(0.004)) applySpecial(g.palette, 'golden');
  else if (roll < rare(0.004) + rare(0.014)) applySpecial(g.palette, 'void');

  // ---- legs ---------------------------------------------------------------
  // hexapods very occasionally sprout a bonus pair: the coveted octopod
  const legCount = {
    biped: 2, quad: 4,
    hexa: rng.bool(rare(0.05)) ? 8 : 6,
    hopper: 0,
    flyer: rng.bool(0.7) ? 2 : 0,
  }[plan];
  g.legs = {
    count: legCount,
    len: 0, thick: 0, footR: 0, hipW: 0,
  };
  if (legCount > 0) {
    if (plan === 'biped') {
      g.legs.len = g.body.r0 * rng.float(1.35, 2.0);
      g.legs.thick = rng.float(0.12, 0.17);
      g.legs.footR = rng.float(0.15, 0.21);
      g.legs.hipW = g.body.r0 * rng.float(0.55, 0.75);
    } else if (plan === 'quad') {
      g.legs.len = g.body.r0 * rng.float(1.1, 1.6);
      g.legs.thick = rng.float(0.11, 0.16);
      g.legs.footR = rng.float(0.13, 0.18);
      g.legs.hipW = g.body.r0 * rng.float(0.65, 0.85);
    } else if (plan === 'hexa') {
      g.legs.len = g.body.r0 * rng.float(1.0, 1.35);
      g.legs.thick = rng.float(0.07, 0.1);
      g.legs.footR = rng.float(0.08, 0.11);
      g.legs.hipW = g.body.r0 * rng.float(0.8, 1.0);
    } else { // flyer danglers
      g.legs.len = g.body.r0 * rng.float(0.7, 1.0);
      g.legs.thick = rng.float(0.06, 0.08);
      g.legs.footR = rng.float(0.08, 0.11);
      g.legs.hipW = g.body.r0 * rng.float(0.4, 0.55);
    }
  }

  // ---- arms / wings -------------------------------------------------------
  if (plan === 'flyer') {
    g.wings = {
      len: g.body.r0 * rng.float(1.7, 2.4),
      thick: rng.float(0.09, 0.13),
      tipR: rng.float(0.5, 0.75), // taper
      sweep: rng.float(0.04, 0.3), // how far the tips sweep back
      tuft: rng.bool(0.7),
      pairs: rng.bool(rare(0.04)) ? 2 : 1, // dragonfly doubles are rare
    };
    g.arms = null;
  } else if (plan === 'biped' || (plan === 'hopper' && rng.bool(0.7))) {
    g.arms = {
      len: g.body.r0 * (plan === 'hopper' ? rng.float(0.5, 0.8) : rng.float(0.9, 1.3)),
      thick: rng.float(0.07, 0.1),
      handR: rng.float(0.1, 0.15),
    };
    g.wings = null;
  } else {
    g.arms = null; g.wings = null;
  }

  // ---- tail ---------------------------------------------------------------
  const tailChance = { biped: 0.55, quad: 0.85, hexa: 0.3, hopper: 0.6, flyer: 0.7 }[plan];
  g.tail = rng.bool(tailChance) ? {
    segs: rng.int(2, 3),
    len: g.body.r0 * rng.float(1.1, 2.0),
    r: g.body.r0 * rng.float(0.28, 0.45),
    taper: rng.float(0.25, 0.55),
    puff: rng.bool(0.35), // puffball tip
    flop: rng.float(0, 1), // 0 = springy, 1 = ragdoll noodle
  } : null;

  // ---- ears / antennae / crest -------------------------------------------
  const earType = rng.pickW([
    ['none', plan === 'hexa' ? 0.3 : 1.4],
    ['bunny', plan === 'hexa' ? 0.2 : 1.6],
    ['antenna', plan === 'hexa' ? 3.0 : 0.8],
    ['nub', 1.2],
  ]);
  g.ears = earType === 'none' ? null : {
    type: earType,
    len: g.head.r * (earType === 'bunny' ? rng.float(1.3, 2.1)
      : earType === 'antenna' ? rng.float(1.2, 2.0) : rng.float(0.45, 0.7)),
    r: g.head.r * (earType === 'antenna' ? rng.float(0.13, 0.2) : rng.float(0.3, 0.45)),
    spread: rng.float(0.4, 0.75),
    // antennae come in 1s (odd), 2s (normal) and lucky 3s
    count: earType === 'antenna' ? rng.pickW([[1, 0.14], [2, 1], [3, rare(0.05)]]) : 2,
    // antenna character: tip style, curl direction, segment count, floppiness
    tip: earType === 'antenna'
      ? rng.pickW([['ball', 1], ['point', 0.55], ['pom', 0.3], ['lantern', rare(0.035)]])
      : null,
    curl: rng.float(-0.45, 0.55), // rest lean: back (-) or forward (+)
    segs: earType === 'antenna' ? rng.pickW([[2, 1], [3, 0.5]]) : 2,
    flop: rng.float(0, 1),
  };

  return g;
}

// ---------------------------------------------------------------------------
// Merge two genomes into a child. "Makes sense" rules:
//  - volume is conserved: child scale = cbrt(a³ + b³), capped for playability
//  - the bigger parent dominates plan & proportions (volume-weighted)
//  - hues pigment-mix; the smaller parent's color survives as the accent
//  - discrete parts (snout, tail, ears) are inherited from either parent
//  - 14% chance of a body-plan mutation for the occasional surprise
export function mergeGenomes(gA, gB, seed) {
  const rng = new RNG(seed);
  const lerpN = (a, b, t) => a + (b - a) * t;
  const wA = Math.pow(gA.body.r0 * gA.scale, 3);
  const wB = Math.pow(gB.body.r0 * gB.scale, 3);
  const tB = wB / (wA + wB); // 0 -> A dominates, 1 -> B dominates
  const minor = tB > 0.5 ? gA : gB;
  const mixN = (a, b) => lerpN(a, b, tB);
  // pull a plan-plausible baseline toward the parents' blend
  const pull = (base, a, b, amt = 0.65) => {
    if (a == null && b == null) return base;
    const target = a == null ? b : b == null ? a : mixN(a, b);
    return base + (target - base) * amt;
  };

  let plan;
  if (rng.bool(0.14)) plan = rng.pick(PLANS);
  else plan = rng.bool(tB) ? gB.plan : gA.plan;

  // LUCK: merging equal-sized, high-generation squishlings rolls rarer traits
  const generation = Math.max(gA.generation || 0, gB.generation || 0) + 1;
  const closeness = Math.min(wA, wB) / Math.max(wA, wB); // 1 = same volume
  const luck = closeness * (0.5 + Math.min(generation, 5) * 0.3);

  const child = makeGenome(rng.int(0, 0x7FFFFFFF), plan, luck);
  child.scale = Math.min(Math.cbrt(Math.pow(gA.scale, 3) + Math.pow(gB.scale, 3)), 4.0);
  child.generation = generation;
  child.luck = luck;

  child.body.r0 = pull(child.body.r0, gA.body.r0, gB.body.r0);
  child.body.r1 = pull(child.body.r1, gA.body.r1, gB.body.r1);
  child.body.len = pull(child.body.len, gA.body.len, gB.body.len, 0.4);
  child.head.r = pull(child.head.r, gA.head.r, gB.head.r);
  child.eyes.r = Math.max(pull(child.eyes.r, gA.eyes.r, gB.eyes.r), 0.09);
  child.eyes.pupil = mixN(gA.eyes.pupil, gB.eyes.pupil);
  child.eyes.count = rng.bool(tB) ? gB.eyes.count : gA.eyes.count;
  child.blush = gA.blush || gB.blush;

  // discrete features: inherit from either parent, prefer something over nothing
  const pickFeat = (a, b) => {
    if (a && b) return rng.bool(tB) ? b : a;
    return (a || b) && rng.bool(0.8) ? (a || b) : null;
  };
  const snout = pickFeat(gA.head.snout, gB.head.snout);
  child.head.snout = snout ? { ...snout } : child.head.snout;
  const tail = pickFeat(gA.tail, gB.tail);
  child.tail = tail ? { ...tail } : null;
  const ears = pickFeat(gA.ears, gB.ears);
  child.ears = ears ? { ...ears } : child.ears;

  if (child.legs.count > 0) {
    const la = gA.legs.count ? gA.legs : null;
    const lb = gB.legs.count ? gB.legs : null;
    child.legs.len = pull(child.legs.len, la?.len, lb?.len);
    child.legs.thick = pull(child.legs.thick, la?.thick, lb?.thick);
    child.legs.footR = pull(child.legs.footR, la?.footR, lb?.footR);
  }
  if (child.wings) {
    child.wings.len = pull(child.wings.len, gA.wings?.len, gB.wings?.len);
    child.wings.thick = pull(child.wings.thick, gA.wings?.thick, gB.wings?.thick);
    if ((gA.wings?.pairs === 2 || gB.wings?.pairs === 2) && rng.bool(0.7)) child.wings.pairs = 2;
  }

  // palette: pigment-mix hues along the shortest arc; minor parent's base
  // becomes the accent so both parents stay visible in the child
  const ca = {}, cb = {};
  const mixColor = (colA, colB, satBoost = 0) => {
    colA.getHSL(ca); colB.getHSL(cb);
    let dh = cb.h - ca.h;
    if (dh > 0.5) dh -= 1;
    if (dh < -0.5) dh += 1;
    const h = ((ca.h + dh * tB) % 1 + 1) % 1;
    return new THREE.Color().setHSL(
      h,
      Math.min(mixN(ca.s, cb.s) + satBoost, 0.92),
      mixN(ca.l, cb.l));
  };
  child.palette.base = mixColor(gA.palette.base, gB.palette.base, 0.04 * child.generation);
  child.palette.belly = mixColor(gA.palette.belly, gB.palette.belly);
  child.palette.accent = (rng.bool(0.6) ? minor.palette.base : minor.palette.accent).clone();

  child.speed = mixN(gA.speed, gB.speed);
  child.wanderlust = mixN(gA.wanderlust, gB.wanderlust);
  child.blinkRate = mixN(gA.blinkRate, gB.blinkRate);
  child.curiosity = mixN(gA.curiosity, gB.curiosity);
  child.bounciness = Math.max(gA.bounciness, gB.bounciness) * 1.03;

  // ---- lucky merge mutations (the reason to match sizes) -------------------
  if (child.ears?.type === 'antenna' && rng.bool(0.05 + luck * 0.12)) {
    child.ears.count = Math.min(3, (child.ears.count || 2) + 1);
  }
  if (child.ears?.type === 'antenna' && rng.bool(0.02 + luck * 0.05)) {
    child.ears.tip = 'lantern';
  }
  if (child.wings && child.wings.pairs !== 2 && rng.bool(0.025 + luck * 0.08)) {
    child.wings.pairs = 2;
  }
  if (child.plan === 'hexa' && child.legs.count === 6 && rng.bool(0.03 + luck * 0.1)) {
    child.legs.count = 8;
  }
  if (child.eyes.count === 2 && rng.bool(0.015 + luck * 0.05)) {
    child.eyes.count = rng.bool(0.5) ? 3 : 1;
  }
  // special colorways: inherit from a special parent, or a lucky fresh roll
  const parentSpecial = gA.palette.special || gB.palette.special;
  if (parentSpecial && rng.bool(0.4 + luck * 0.2)) {
    applySpecial(child.palette, parentSpecial);
  } else if (!child.palette.special && rng.bool(0.004 + luck * 0.03)) {
    applySpecial(child.palette, rng.bool(0.3) ? 'golden' : 'void');
  }

  return child;
}

// ---------------------------------------------------------------------------
// Save/load: genomes are plain data except the THREE.Color palette.
export function genomeToJSON(g) {
  return {
    ...g,
    palette: {
      base: g.palette.base.getHexString(),
      belly: g.palette.belly.getHexString(),
      accent: g.palette.accent.getHexString(),
      blush: g.palette.blush.getHexString(),
      special: g.palette.special || null,
    },
  };
}

export function genomeFromJSON(o) {
  return {
    ...o,
    palette: {
      base: new THREE.Color('#' + o.palette.base),
      belly: new THREE.Color('#' + o.palette.belly),
      accent: new THREE.Color('#' + o.palette.accent),
      blush: new THREE.Color('#' + o.palette.blush),
      special: o.palette.special || null,
    },
  };
}

// Directional reach estimates (creature-local, world units) used to size the
// raymarch bounding box. Anything outside the box gets sliced flat at the box
// wall, so every part — especially the head+snout of long horizontal bodies —
// must be covered, padded for squash spread (sxz ≤ 1.25).
export function genomeExtents(g) {
  const s = g.scale;
  const horizontal = g.plan === 'quad' || g.plan === 'hexa';
  const headR = g.head.r;
  // face: head offset from chest + head ball or snout tip + eye bulge
  const snoutReach = g.head.snout
    ? headR * (0.55 + g.head.snout.len * 0.5 + g.head.snout.r) : 0;
  const faceReach = headR * (0.35 + g.head.fwd) + Math.max(headR * 1.1, snoutReach) + headR * 0.3;
  const chestFwd = horizontal
    ? g.body.len + g.body.r1 * 0.6
    : g.body.len * 0.6 + g.body.r1 * 0.35;
  const fwdReach = chestFwd + faceReach;
  const backReach = g.body.r0 * 1.4
    + (g.tail ? g.tail.len * 1.1 + g.tail.r * 1.5 : 0)
    + (horizontal ? g.body.len * 0.25 : 0);
  const sideReach = Math.max(
    Math.max(g.body.r0, g.body.r1) * 1.5,
    g.legs.count ? g.legs.hipW + g.legs.len * 0.4 + g.legs.footR * 2 : 0,
    g.wings ? g.body.r1 * 0.7 + g.wings.len * 1.12 : 0,
    g.ears ? g.ears.len + headR * g.ears.spread : 0,
    g.tail ? g.body.r0 * 0.4 + g.tail.len * 0.7 : 0,
  );
  const pad = 0.3;
  return {
    side: (sideReach * 1.25 + pad) * s,
    fwd: (fwdReach * 1.25 + pad) * s,
    back: (backReach * 1.25 + pad) * s,
    height: ((g.legs.count ? g.legs.len : 0) + g.body.r0 * 2 + g.body.len
      + headR * 2 + (g.ears ? g.ears.len : 0)) * 1.3 * s + 0.5,
  };
}
