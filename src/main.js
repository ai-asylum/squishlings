// Bootstrap: scene, camera, world, creature lifecycle, input (orbit / grab /
// pet / hatch), merge-and-collect game systems (cards, dex, lineage, stage
// growth, idle spawner), HUD wiring, adaptive resolution, and the main loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  ENV, buildSky, buildGround, buildRocks, buildGrass, buildMotes, ShadowPool,
  buildBushes, buildTrees, buildForest, buildMountains, updatePropAnims,
  props, spawnProp, removeProp,
} from './world.js';
import { makeGenome, mergeGenomes, genomeToJSON, genomeFromJSON, PLANS } from './genome.js';
import { Creature } from './creature.js';
import { MergeBlob } from './merge.js';
import { FX } from './fx.js';
import { randomSeed } from './rng.js';
import { extractTraits, gradeOf, makeName } from './traits.js';
import * as ui from './ui.js';

// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
let pixelRatioCap = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatioCap);
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 4.6, 10.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.8, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 3.5;
controls.maxDistance = 18;
controls.maxPolarAngle = 1.42;
controls.minPolarAngle = 0.25;

buildSky(scene);
buildGround(scene);
buildRocks(scene);
const grass = buildGrass(scene);
const motes = buildMotes(scene);
const shadows = new ShadowPool(scene, 64);
const fx = new FX(scene);

// ---------------------------------------------------------------------------
// persistence (encyclopedia + stage tier survive reloads)
const store = {
  load(key, def) {
    try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
  },
  save(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
  },
};
const dex = new Set(store.load('squish.dex', []));
let stageTier = store.load('squish.stage', 0);

// ---------------------------------------------------------------------------
// katamari stage growth: bigger squishlings unlock bigger scenery
const STAGES = [
  { at: 1.35, toast: '🌿 Your squishlings feel bigger… bushes sprout!', build: buildBushes },
  { at: 1.9, toast: '🌳 Trees rise around the meadow!', build: buildTrees },
  { at: 2.6, toast: '🌲 A whole forest gathers…', build: buildForest },
  { at: 3.3, toast: '⛰️ Mountains awaken on the horizon!', build: buildMountains },
];

function applyStageSideEffects() {
  ENV.arenaRadius = 7 + stageTier * 1.8;
  controls.maxDistance = 18 + stageTier * 3;
  ENV.fogRange.set(14 + stageTier * 2.5, 30 + stageTier * 5.5);
}
for (let i = 0; i < stageTier; i++) STAGES[i].build(scene, false);
applyStageSideEffects();

function checkStage() {
  let maxScale = 0;
  for (const c of creatures) {
    if (!c.dead && c.dieT < 0) maxScale = Math.max(maxScale, c.g.scale);
  }
  while (stageTier < STAGES.length && maxScale >= STAGES[stageTier].at) {
    const s = STAGES[stageTier];
    stageTier++;
    store.save('squish.stage', stageTier);
    s.build(scene, true);
    applyStageSideEffects();
    ui.showToast(s.toast);
    startShake(0.5, 0.07);
  }
}

// ---------------------------------------------------------------------------
// creature lifecycle
const creatures = [];
const spawnQueue = [];
const mergeBlobs = [];
const MAX_CREATURES = 10;

// camera shake (merges, evolutions, stage-ups)
let shakeT = 0, shakeDur = 1, shakeAmp = 0;
function startShake(dur, amp) { shakeT = dur; shakeDur = dur; shakeAmp = amp; }
let lastGulpToast = 0;

function ringSpot(i, n) {
  const a = (i / Math.max(n, 1)) * Math.PI * 2 + Math.random() * 0.6;
  const r = 2.2 + Math.random() * 1.8;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

// dex: register a genome's traits, return the freshly discovered ids
function unlockTraits(genome) {
  const fresh = [];
  for (const t of extractTraits(genome)) {
    if (!dex.has(t.id)) { dex.add(t.id); fresh.push(t); }
  }
  if (fresh.length) {
    store.save('squish.dex', [...dex]);
    const rare = fresh.filter((t) => t.tier !== 'C');
    if (rare.length) {
      ui.showToast(`✨ New trait${rare.length > 1 ? 's' : ''} discovered: ${rare.map((t) => t.label).join(', ')}!`);
    }
  }
  return new Set(fresh.map((t) => t.id));
}

function hatchGenome() {
  const g = makeGenome(randomSeed(), null);
  g.scale = 0.55 + Math.random() * 0.3; // hatchlings start small
  return g;
}

function spawnCreature(genome, x, z, parents = null, opts = {}) {
  const c = new Creature(genome, scene, fx);
  c.spawnAt(x, z);
  const grade = gradeOf(genome);
  c.lineage = opts.lineage || {
    name: makeName(genome.seed),
    color: '#' + genome.palette.base.getHexString(),
    tier: grade.tier,
    plan: genome.plan,
    parents,
  };
  c.absorbedCount = opts.absorbed || 0;
  c.newTraitIds = unlockTraits(genome);
  creatures.push(c);
  if (!opts.quiet) fx.confetti(new THREE.Vector3(x, 0.6 * genome.scale, z), genome.palette);
  updateCount();
  return c;
}

// ---------------------------------------------------------------------------
// save / load: the whole crowd persists across sessions
let resetting = false; // reload fires pagehide -> don't re-save what we just wiped
function saveGame() {
  if (resetting) return;
  store.save('squish.save', {
    meter: spawnMeter,
    creatures: creatures.filter((c) => !c.dead && c.dieT < 0).map((c) => ({
      g: genomeToJSON(c.g),
      lin: c.lineage,
      ab: c.absorbedCount,
      x: +c.pos.x.toFixed(2),
      z: +c.pos.z.toFixed(2),
    })),
  });
}

function loadGame() {
  const save = store.load('squish.save', null);
  if (!save?.creatures?.length) return false;
  spawnMeter = save.meter || 0;
  for (const e of save.creatures) {
    try {
      const c = spawnCreature(genomeFromJSON(e.g), e.x, e.z, null,
        { quiet: true, lineage: e.lin, absorbed: e.ab });
      c.spawnT = 0.5; // quick pop, not a full ceremony
    } catch { /* corrupt entry — skip it */ }
  }
  return creatures.length > 0;
}

function doSpawn(entry) {
  const g = hatchGenome();
  if (entry.plan) {
    const forced = makeGenome(randomSeed(), entry.plan);
    forced.scale = g.scale;
    return spawnCreature(forced, entry.x, entry.z);
  }
  return spawnCreature(g, entry.x, entry.z);
}

function livingCount() {
  return creatures.filter((c) => c.dieT < 0 && !c.dead).length
    + spawnQueue.length + mergeBlobs.length;
}

// ---------------------------------------------------------------------------
// Hard collision between two squishlings.
//  - similar volumes -> the full evolution ceremony (goo swirl, new genome)
//  - mismatched     -> the big one simply absorbs the little one and grows
function requestMerge(a, b) {
  if (a.dead || b.dead) return;
  const volA = Math.pow(a.g.scale, 3);
  const volB = Math.pow(b.g.scale, 3);
  const ratio = Math.min(volA, volB) / Math.max(volA, volB);

  if (ratio < 0.45) {
    const big = volA >= volB ? a : b;
    const small = volA >= volB ? b : a;
    if (heldCreature === small) {
      heldCreature = null; pointerDown = null; controls.enabled = true; ui.hideCard();
    }
    if (performance.now() - lastGulpToast > 6000) {
      lastGulpToast = performance.now();
      ui.showToast(`🍴 gulp! ${small.lineage?.name || 'the little one'} was way smaller — `
        + 'squishlings only evolve when they match in size!');
    }
    small.dead = true;
    fx.pop(small.bodyCenter, small.g.palette);
    fx.landDust(new THREE.Vector3(big.pos.x, 0.05, big.pos.z), 0.8);
    fx.heartsBurst(big.bodyCenter);
    big.setScale(Math.min(Math.cbrt(volA + volB), 4.0));
    big.squash.kick(-5);
    big.excited = 1;
    big.happyT = 1;
    big.absorbedCount++;
    startShake(0.15, 0.03);
    updateCount();
    checkStage();
    if (heldCreature === big) ui.showCard(big); // live-refresh the stats card
    return;
  }

  if (heldCreature === a || heldCreature === b) {
    heldCreature = null;
    pointerDown = null;
    controls.enabled = true;
    ui.hideCard();
  }
  const blob = new MergeBlob(scene, fx, a, b);
  blob.childGenome = mergeGenomes(a.g, b.g, randomSeed());
  blob.parentLineages = [a.lineage, b.lineage];
  blob.parentColors = [a.g.palette.base.clone(), b.g.palette.base.clone()];
  fx.pop(blob.pos, a.g.palette);
  fx.pop(blob.pos, b.g.palette);
  fx.landDust(new THREE.Vector3(blob.pos.x, 0.05, blob.pos.z), 1.2);
  startShake(0.28, 0.05);
  a.dead = true;
  b.dead = true;
  mergeBlobs.push(blob);
  updateCount();
}

// ---------------------------------------------------------------------------
// A thrown squishling hit a stage prop: eat it if clearly bigger, else BONK.
function onPropHit(c, p) {
  const cVol = Math.pow(c.g.scale, 3);
  if (cVol >= p.vol * 2) {
    removeProp(p);
    fx.gulpBits(new THREE.Vector3(p.x, p.h * 0.5, p.z), p.kind);
    c.setScale(Math.min(Math.cbrt(cVol + p.vol * 0.35), 4.0));
    c.squash.kick(-4);
    c.happyT = 1;
    c.absorbedCount++;
    fx.heartsBurst(c.bodyCenter);
    startShake(0.12, 0.025);
    checkStage();
    if (heldCreature === c) ui.showCard(c);
  } else {
    c.bonk(p);
    fx.landDust(new THREE.Vector3((c.pos.x + p.x) / 2, 0.3, (c.pos.z + p.z) / 2), 1.3);
    startShake(0.32, 0.08);
    if (performance.now() - lastGulpToast > 8000) {
      lastGulpToast = performance.now();
      ui.showToast(`💫 too big! ${c.lineage?.name || 'it'} needs to grow before eating that`);
    }
  }
}

// props regrow on a timer, up to a cap per kind (once the stage unlocks them)
const PROP_CAPS = { rock: 7, bush: 8, tree: 7, bigtree: 14 };
const PROP_RANGE = { rock: [4.5, 8], bush: [6.5, 9.5], tree: [9, 12.5], bigtree: [12, 17] };
const PROP_STAGE = { rock: 0, bush: 1, tree: 2, bigtree: 3 };
let propRespawnT = 9;
function respawnProps() {
  const under = Object.keys(PROP_CAPS).filter((k) =>
    stageTier >= PROP_STAGE[k] && props.filter((p) => p.kind === k).length < PROP_CAPS[k]);
  if (!under.length) return;
  const kind = under[(Math.random() * under.length) | 0];
  const a = Math.random() * Math.PI * 2;
  const [rMin, rMax] = PROP_RANGE[kind];
  const r = rMin + Math.random() * (rMax - rMin);
  const x = Math.cos(a) * r, z = Math.sin(a) * r;
  spawnProp(scene, kind, x, z, true);
  fx.tapRipple(x, z);
}

const countEl = document.getElementById('count');
function updateCount() { countEl.textContent = `${livingCount()}/${MAX_CREATURES}`; }
function flashCount() {
  countEl.classList.remove('flash');
  void countEl.offsetWidth; // restart the animation
  countEl.classList.add('flash');
}

// ---------------------------------------------------------------------------
// hatch meter: fills slowly on its own, faster with every click/tap
let spawnMeter = 0;
const spawnBarEl = document.getElementById('spawn-bar');
const spawnFillEl = document.getElementById('spawn-fill');

function barJuice() {
  spawnBarEl.classList.remove('juice');
  void spawnBarEl.offsetWidth; // restart the animation
  spawnBarEl.classList.add('juice');
}

function bumpMeter(amount) {
  if (livingCount() >= MAX_CREATURES) { flashCount(); return; }
  spawnMeter += amount;
  barJuice();
}

function hatchFromMeter() {
  spawnMeter = 0;
  const a = Math.random() * Math.PI * 2;
  const r = ENV.arenaRadius * (0.4 + Math.random() * 0.5);
  const x = Math.cos(a) * r, z = Math.sin(a) * r;
  fx.tapRipple(x, z);
  spawnCreature(hatchGenome(), x, z);
}

spawnBarEl.addEventListener('click', () => { bumpMeter(0.25); dismissHint(); });

// boot: restore the save, or spawn a starter crowd (one of each plan)
if (!loadGame()) {
  const plans = [...PLANS].sort(() => Math.random() - 0.5);
  plans.forEach((plan, i) => {
    const spot = ringSpot(i, plans.length);
    spawnQueue.push({ t: 0.4 + i * 0.22, plan, x: spot.x, z: spot.z });
  });
}
updateCount();

ui.initUI({
  getCreatures: () => creatures,
  getDex: () => dex,
  onReset: () => {
    resetting = true;
    for (const key of ['squish.save', 'squish.dex', 'squish.stage']) {
      try { localStorage.removeItem(key); } catch { /* fine */ }
    }
    location.reload();
  },
});

// hint
const hint = document.getElementById('hint');
setTimeout(() => hint.classList.add('show'), 2200);
let hintDismissed = false;
function dismissHint() {
  if (hintDismissed) return;
  hintDismissed = true;
  hint.classList.remove('show');
}
setTimeout(dismissHint, 16000);

// ---------------------------------------------------------------------------
// input: grab / pet / hatch (with orbit fallback)
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _sphere = new THREE.Sphere();
const _hit = new THREE.Vector3();
const dragPlane = new THREE.Plane();

let pointerDown = null;   // {x, y, t, creature, grabbed}
let heldCreature = null;
let hatchCooldown = 0;

// keep the stat card on the opposite side of the dragged squishling
const _cardV = new THREE.Vector3();
let cardSide = 'right';
function updateCardSide(force = false) {
  if (!heldCreature || heldCreature.dead) return;
  _cardV.copy(heldCreature.bodyCenter).project(camera);
  // hysteresis so the card doesn't flip-flop at the middle
  let next = cardSide;
  if (_cardV.x > 0.22) next = 'left';
  else if (_cardV.x < -0.22) next = 'right';
  else if (force) next = _cardV.x > 0 ? 'left' : 'right';
  if (next !== cardSide || force) {
    cardSide = next;
    ui.setCardSide(cardSide);
  }
}

function setPointer(e) {
  pointerNDC.set(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNDC, camera);
}

function pickCreature() {
  let best = null, bestT = Infinity;
  for (const c of creatures) {
    if (c.dead || c.dieT >= 0) continue;
    _sphere.set(c.bodyCenter, c.pickRadius);
    const p = raycaster.ray.intersectSphere(_sphere, _hit);
    if (p) {
      const t = p.distanceTo(raycaster.ray.origin);
      if (t < bestT) { bestT = t; best = c; }
    }
  }
  return best;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary) return;
  setPointer(e);
  const c = pickCreature();
  pointerDown = { x: e.clientX, y: e.clientY, t: performance.now(), creature: c, grabbed: false };
  if (c) controls.enabled = false; // this drag belongs to the creature
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!e.isPrimary || !pointerDown) return;
  const pd = pointerDown;
  if (pd.creature && pd.creature.dead) {
    pointerDown = null;
    controls.enabled = true;
    ui.hideCard();
    return;
  }
  const moved = Math.hypot(e.clientX - pd.x, e.clientY - pd.y);
  if (pd.creature && !pd.grabbed && (moved > 8 || performance.now() - pd.t > 220)) {
    pd.grabbed = true;
    heldCreature = pd.creature;
    heldCreature.grab();
    updateCardSide(true);
    ui.showCard(heldCreature);
    camera.getWorldDirection(_hit);
    dragPlane.setFromNormalAndCoplanarPoint(_hit, heldCreature.bodyCenter);
    dismissHint();
  }
  if (heldCreature) {
    setPointer(e);
    if (raycaster.ray.intersectPlane(dragPlane, _hit)) {
      _hit.y = Math.max(0.35, Math.min(4.5, _hit.y));
      const r = Math.hypot(_hit.x, _hit.z);
      const maxR = ENV.arenaRadius + 2.5;
      if (r > maxR) { _hit.x *= maxR / r; _hit.z *= maxR / r; }
      heldCreature.heldTarget.copy(_hit);
    }
  }
});

function endPointer(e) {
  if (!pointerDown) return;
  const pd = pointerDown;
  pointerDown = null;
  controls.enabled = true;
  if (heldCreature) {
    heldCreature.release();
    heldCreature = null;
    ui.hideCard();
    return;
  }
  const dt = performance.now() - pd.t;
  const moved = Math.hypot(e.clientX - pd.x, e.clientY - pd.y);
  if (dt < 350 && moved < 8) {
    if (pd.creature && !pd.creature.dead) {
      pd.creature.pet();
      dismissHint();
    } else if (!pd.creature) {
      // ground taps feed the hatch meter
      setPointer(e);
      if (raycaster.ray.intersectPlane(groundPlane, _hit)) {
        const r = Math.hypot(_hit.x, _hit.z);
        if (r < ENV.arenaRadius + 2 && hatchCooldown <= 0) {
          hatchCooldown = 0.15;
          fx.tapRipple(_hit.x, _hit.z);
          bumpMeter(0.25); // 4 taps from empty to hatch
          dismissHint();
        }
      }
    }
  }
}
renderer.domElement.addEventListener('pointerup', endPointer);
renderer.domElement.addEventListener('pointercancel', endPointer);

// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// adaptive resolution: drop pixel ratio if frames run long, restore if snappy
let frameEMA = 16;
let qualityT = 0;
function adaptQuality(rawDt) {
  frameEMA = frameEMA * 0.95 + rawDt * 1000 * 0.05;
  qualityT += rawDt;
  if (qualityT < 1.5) return;
  qualityT = 0;
  const current = renderer.getPixelRatio();
  if (frameEMA > 26 && current > 0.9) {
    renderer.setPixelRatio(Math.max(0.9, current - 0.25));
  } else if (frameEMA < 15 && current < pixelRatioCap) {
    renderer.setPixelRatio(Math.min(pixelRatioCap, current + 0.25));
  }
}

// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const ctx = { camera, creatures, fx, time: 0, requestMerge, propHit: onPropHit };
let saveT = 0;
window.addEventListener('pagehide', saveGame);

// cinematic camera for evolutions: swing in on the newborn while its card
// slides in beside it; return to where the player was afterwards
let cine = null; // {t, hold, creature, fromPos, fromTarget}
const _cineV = new THREE.Vector3();
const _cineRight = new THREE.Vector3();

function startCinematic(child, hold) {
  cine = {
    t: 0, hold, creature: child,
    // if a cinematic is already running, keep the ORIGINAL return pose
    fromPos: cine ? cine.fromPos : camera.position.clone(),
    fromTarget: cine ? cine.fromTarget : controls.target.clone(),
  };
  controls.enabled = false;
}

function endCinematicEarly() {
  if (cine && cine.t < cine.hold) {
    cine.t = cine.hold;
    cine.creature.endShowcase();
  }
}

function updateCinematic(dt) {
  cine.t += dt;
  const c = cine.creature;
  const k = 1 - Math.exp(-3.2 * dt); // frame-rate independent ease
  if (cine.t < cine.hold && !c.dead) {
    const s = Math.max(c.g.scale, 0.7);
    // frame the newborn right-of-center (its card slides in on the left):
    // shift camera AND target toward screen-left so the child drifts right
    _cineV.copy(cine.fromPos).sub(c.bodyCenter);
    _cineV.y = 0;
    _cineV.normalize();
    _cineRight.crossVectors(_cineV, camera.up).normalize(); // screen-left dir
    const wantTarget = c.bodyCenter.clone()
      .addScaledVector(_cineRight, s * 0.75)
      .addScaledVector(camera.up, s * 0.15);
    const wantPos = c.bodyCenter.clone()
      .addScaledVector(_cineV, 3.4 * s + 2.0)
      .addScaledVector(camera.up, 1.1 * s + 0.6)
      .addScaledVector(_cineRight, s * 0.75);
    camera.position.lerp(wantPos, k);
    controls.target.lerp(wantTarget, k);
  } else {
    // ease back to where the player left the camera
    camera.position.lerp(cine.fromPos, k);
    controls.target.lerp(cine.fromTarget, k);
    if (cine.t > cine.hold + 1.1) {
      camera.position.copy(cine.fromPos);
      controls.target.copy(cine.fromTarget);
      cine = null;
      controls.enabled = true;
    }
  }
  camera.lookAt(controls.target);
}

window.__dbg = {
  renderer, scene, camera, creatures, mergeBlobs, controls, THREE, dex, props,
  bump: (a) => bumpMeter(a),
  step: (dt) => step(dt),
};

function tick() {
  requestAnimationFrame(tick);
  const rawDt = clock.getDelta();
  step(rawDt);
}

function step(rawDt) {
  const dt = Math.min(rawDt, 1 / 30);
  ctx.time += dt;
  hatchCooldown -= dt;

  if (cine) updateCinematic(dt);
  else controls.update();
  if (shakeT > 0) {
    shakeT -= dt;
    const f = Math.max(shakeT / shakeDur, 0) * shakeAmp;
    camera.position.x += Math.sin(ctx.time * 91) * f;
    camera.position.y += Math.cos(ctx.time * 83) * f;
  }
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  // hatch meter: trickle-fills, clicks top it up, full = new squishling
  if (livingCount() < MAX_CREATURES) {
    spawnMeter += dt / 16;
    if (spawnMeter >= 1) hatchFromMeter();
  }
  spawnFillEl.style.width = `${Math.min(spawnMeter, 1) * 100}%`;

  // autosave
  saveT += dt;
  if (saveT > 4) { saveT = 0; saveGame(); }

  // scenery regrowth
  propRespawnT -= dt;
  if (propRespawnT <= 0) {
    propRespawnT = 8 + Math.random() * 5;
    respawnProps();
  }

  // spawn queue
  for (let i = spawnQueue.length - 1; i >= 0; i--) {
    spawnQueue[i].t -= dt;
    if (spawnQueue[i].t <= 0) {
      const entry = spawnQueue.splice(i, 1)[0];
      doSpawn(entry);
    }
  }

  // creatures
  for (let i = creatures.length - 1; i >= 0; i--) {
    const c = creatures[i];
    c.update(dt, ctx);
    if (c.dead) {
      c.dispose();
      creatures.splice(i, 1);
      updateCount();
    }
  }
  if (heldCreature) updateCardSide();

  // merge goo: wobble, then pop out the child with a full celebration
  for (let i = mergeBlobs.length - 1; i >= 0; i--) {
    const blob = mergeBlobs[i];
    blob.update(dt, ctx);
    if (blob.finished) {
      blob.burst();
      mergeBlobs.splice(i, 1);
      const child = spawnCreature(
        blob.childGenome, blob.pos.x, blob.pos.z, blob.parentLineages);
      const grade = gradeOf(child.g);
      fx.celebrate(
        new THREE.Vector3(blob.pos.x, 0.5, blob.pos.z),
        [child.g.palette.base, ...(blob.parentColors || []), child.g.palette.accent],
        grade.tier);
      startShake(
        grade.tier === 'SSR' ? 0.6 : grade.tier === 'SR' ? 0.4 : 0.25,
        grade.tier === 'SSR' ? 0.1 : grade.tier === 'SR' ? 0.07 : 0.05);
      const hold = ui.celebrationLinger(grade.tier);
      startCinematic(child, hold);
      child.startShowcase(hold);
      ui.showCelebration(child, child.newTraitIds, endCinematicEarly);
      checkStage();
      blob.dispose();
    }
  }

  // shadows
  shadows.begin();
  for (const c of creatures) c.addShadows(shadows);
  for (const blob of mergeBlobs) blob.addShadows(shadows);
  shadows.end();

  // ambience + fx + stage props
  grass.material.uniforms.uTime.value = ctx.time;
  motes.material.uniforms.uTime.value = ctx.time;
  fx.update(dt);
  updatePropAnims(dt);

  adaptQuality(rawDt);
  renderer.render(scene, camera);
}
tick();
