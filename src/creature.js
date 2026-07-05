// A Creature = genome -> living rig. Everything is procedural:
//  - dist-triggered, phase-gated stepping + 2-bone IK for ANY leg count
//  - squash-stretch hop state machine for legless hoppers
//  - flap/bank/hover flight for flyers
//  - verlet-chain ragdoll tails/ears/antennae with rest-pose stiffness
//  - grab/carry/drop physics with panic flailing and landing squash
// Each frame the rig is packed into the SDF primitive uniforms of one
// raymarched blob material (see blob-material.js) — one draw call per body.
import * as THREE from 'three';
import { createBlobMaterial, MAX_PRIMS } from './blob-material.js';
import { genomeExtents } from './genome.js';
import { ENV, props as WORLD_PROPS } from './world.js';
import {
  Spring, SpringVec3, VerletChain, solveTwoBoneIK,
  clamp, clamp01, lerp, smoothstep, easeOutBack, easeInCubic, damp, dampAngle,
} from './anim-helpers.js';

const GRAVITY = 22;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

let CREATURE_ID = 0;

export class Creature {
  constructor(genome, scene, fx) {
    this.id = CREATURE_ID++;
    this.g = genome;
    this.scene = scene;
    this.fx = fx;
    const g = genome;
    this.computeDims();
    const s = this.s;
    const d = this.dim;

    // ---- kinematic state ---------------------------------------------------
    this.pos = new THREE.Vector3();     // root: ground point under the body
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;
    this.prevYaw = this.yaw;
    this.smoothAccel = new THREE.Vector3();
    this.prevVel = new THREE.Vector3();

    this.state = 'roam';                // roam | held | falling
    this.goal = null;
    this.decideT = Math.random() * 2;
    this.excited = 0;

    this.squash = new Spring(1, 160, 12);
    this.bounceY = new Spring(0, 140, 12); // extra body lift for emotes
    this.breathPhase = Math.random() * 10;
    this.bobPhase = Math.random() * 10;
    this.pitch = 0; this.roll = 0;

    this.blinkT = 0; this.blinkNext = 1 + Math.random() * 3;
    this.eyeScale = new Spring(1, 120, 12);
    this.happyT = 0;
    this.flinchT = 0;
    this.dizzyT = 0;
    this.dizzyPhase = 0;
    this.dizzyStarT = 0;
    this.bonkCooldown = 0;

    this.eyeLookLocal = new THREE.Vector3(0, 0, 1);
    this.lookTargetWorld = null;
    this.lookHoldT = 0;
    this.saccade = new THREE.Vector3();
    this.saccadeT = 0;

    this.spawnT = 0;      // 0..1
    this.dieT = -1;       // >=0 while dying
    this.dead = false;
    this.growT = 1;       // absorption growth tween
    this.growFrom = 1;
    this.absorbedCount = 0;

    this.heldTarget = new THREE.Vector3();
    this.holdWobble = new SpringVec3(90, 9);
    this.airT = 0;

    // hopper state machine
    this.hop = { state: 'sit', t: 0, cooldown: 0.5, from: new THREE.Vector3(), airTime: 0, vy: 0 };
    // flyer state
    this.flapPhase = Math.random() * 10;
    this.flyY = new Spring(d.hoverH, 30, 6);

    // ---- legs ---------------------------------------------------------------
    this.legs = [];
    if (g.legs.count > 0) this.buildLegs();
    this.gaitClock = Math.random();

    // ---- arms ---------------------------------------------------------------
    if (g.arms) {
      this.hands = [new SpringVec3(210, 16), new SpringVec3(210, 16)];
      this.armFlail = Math.random() * 10;
    }

    // ---- chains (tail / ears / antennae) ------------------------------------
    this.buildChains();

    // ---- render mesh --------------------------------------------------------
    this.material = createBlobMaterial(ENV);
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.frustumCulled = true;
    scene.add(this.mesh);
    this.buildShell();
    // pupil cap angular radius ~20°..33° of the eyeball
    const pupilCut = 0.94 - (g.eyes.pupil - 0.45) * 0.54;
    this.material.uniforms.uPupil.value.set(pupilCut, pupilCut + (1 - pupilCut) * 0.62);

    this.bodyCenter = new THREE.Vector3();
  }

  // ==========================================================================
  computeDims() {
    const g = this.g;
    const s = this.s = g.scale;
    const d = this.dim = {};
    d.r0 = g.body.r0 * s;
    d.r1 = g.body.r1 * s;
    d.bodyLen = g.body.len * s;
    d.headR = g.head.r * s;
    d.legLen = g.legs.count ? g.legs.len * s : 0;
    d.hipW = g.legs.count ? g.legs.hipW * s : 0;
    d.footR = g.legs.count ? g.legs.footR * s : 0;
    d.legThick = g.legs.count ? g.legs.thick * s : 0;
    // standing height of the hip blob center
    if (g.plan === 'hopper') d.hipH = d.r0 * 0.92;
    else if (g.plan === 'flyer') d.hipH = 0; // uses hover instead
    else d.hipH = d.legLen * 0.98 + d.footR;
    d.hoverH = g.plan === 'flyer' ? (1.15 + 0.5 * (g.seed % 100) / 100) * s : 0;
    this.pickRadius = Math.max(d.r0 * 2.4, 0.6);
  }

  buildChains() {
    const g = this.g, s = this.s;
    this.chains = [];
    if (g.tail) {
      // flop 0 = springy held tail, 1 = ragdoll noodle
      const flop = g.tail.flop ?? 0.5;
      const segLen = (g.tail.len * s) / g.tail.segs;
      const ch = new VerletChain(g.tail.segs + 1, segLen, {
        stiffness: lerp(0.36, 0.08, flop),
        damping: lerp(0.95, 0.88, flop),
        gravity: lerp(-5, -17, flop),
      });
      const curlUp = (g.seed % 2) === 0;
      for (let i = 1; i <= g.tail.segs; i++) {
        ch.setRestDir(i, new THREE.Vector3(0, curlUp ? 0.35 + i * 0.3 : -0.15, -1));
      }
      this.chains.push({ chain: ch, kind: 'tail' });
    }
    if (g.ears && (g.ears.type === 'bunny' || g.ears.type === 'antenna')) {
      // bunny ears come in pairs; antennae in 1s, 2s, or lucky 3s
      const bunny = g.ears.type === 'bunny';
      const flop = g.ears.flop ?? 0.5;
      const count = bunny ? 2 : (g.ears.count || 2);
      const sides = count === 1 ? [0] : count === 3 ? [-1, 0, 1] : [-1, 1];
      const curl = g.ears.curl || 0;
      for (const side of sides) {
        const segs = bunny ? 2 : (g.ears.segs || 2);
        const lenMul = side === 0 && count === 3 ? 1.25 : 1; // proud middle antenna
        const segLen = (g.ears.len * s * lenMul) / segs;
        const ch = new VerletChain(segs + 1, segLen, {
          stiffness: bunny ? lerp(0.68, 0.2, flop) : lerp(0.5, 0.14, flop),
          damping: lerp(0.93, 0.87, flop),
          gravity: bunny ? lerp(-7, -19, flop) : lerp(-2.5, -12, flop),
        });
        for (let i = 1; i <= segs; i++) {
          ch.setRestDir(i, new THREE.Vector3(side * g.ears.spread * 0.5, 1, -0.12 + curl));
        }
        this.chains.push({ chain: ch, kind: 'ear', side });
      }
    }
  }

  // The raymarch bounding box is asymmetric in z: long horizontal bodies
  // reach much further forward (head + snout) than backward. Anything
  // outside the box would render sliced flat at the wall.
  buildShell() {
    const ext = genomeExtents(this.g);
    const dangle = this.dim.legLen + 0.8 * this.s;
    const geo = new THREE.BoxGeometry(ext.side * 2, ext.height + dangle, ext.fwd + ext.back);
    geo.translate(0, (ext.height - dangle) / 2, (ext.fwd - ext.back) / 2);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.material.uniforms.uBoxMin.value.set(-ext.side, -dangle, -ext.back);
    this.material.uniforms.uBoxMax.value.set(ext.side, ext.height, ext.fwd);
  }

  // Absorption growth: keep all state, rebuild the rig at the new scale, and
  // tween renderScale so the growth bounces instead of snapping.
  setScale(newScale) {
    const old = this.g.scale;
    this.g.scale = newScale;
    this.growFrom = old / newScale;
    this.growT = 0;
    this.computeDims();
    this.legs = [];
    if (this.g.legs.count > 0) this.buildLegs();
    this.buildChains();
    for (const { chain } of this.chains) {
      chain.reset(_v.set(this.pos.x, Math.max(0.3, this.pos.y + this.dim.hipH), this.pos.z));
    }
    this.buildShell();
    if (this.legs.length && this.state === 'roam') this.settleFeet();
  }

  // ==========================================================================
  buildLegs() {
    const g = this.g, d = this.dim;
    const defs = [];
    if (g.plan === 'biped' || (g.plan === 'flyer' && g.legs.count === 2)) {
      defs.push({ side: -1, z: 0.02 }, { side: 1, z: 0.02 });
    } else if (g.plan === 'quad') {
      const zf = d.bodyLen * 0.55, zb = -d.bodyLen * 0.5;
      defs.push({ side: -1, z: zf }, { side: 1, z: zf }, { side: -1, z: zb }, { side: 1, z: zb });
    } else if (g.plan === 'hexa') {
      // 3 rows for hexapods, 4 for the rare octopod
      const rows = g.legs.count / 2;
      for (let r = 0; r < rows; r++) {
        const z = d.bodyLen * 0.55 - (r / (rows - 1)) * d.bodyLen * 1.1;
        defs.push({ side: -1, z }, { side: 1, z });
      }
    }
    // phase groups: alternating tripod/diagonal — neighbours out of phase
    const groupFor = (i, def) => {
      if (g.plan === 'quad') return (def.side === 1) === (def.z > 0) ? 0 : 1; // diagonal trot
      return (i + (def.z > 0 ? 0 : 1)) % 2;
    };
    defs.forEach((def, i) => {
      this.legs.push({
        side: def.side, z: def.z,
        group: groupFor(i, def),
        foot: new THREE.Vector3(),      // planted, world
        stepFrom: new THREE.Vector3(),
        stepT: 1, stepping: false,
        knee: new THREE.Vector3(),
        home: new THREE.Vector3(),
        wasAir: false,
      });
    });
  }

  // place feet at their home positions instantly (spawn / teleport)
  settleFeet() {
    for (const leg of this.legs) {
      this.legHome(leg, leg.home);
      leg.foot.copy(leg.home);
      leg.stepping = false; leg.stepT = 1;
    }
  }

  legHome(leg, out) {
    const d = this.dim;
    out.set(leg.side * (d.hipW + d.legLen * 0.12), 0, leg.z);
    this.localToWorldDir(out);
    out.add(this.pos);
    out.y = 0;
    return out;
  }

  localToWorldDir(v) { // rotate local dir by yaw (no translation)
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const x = v.x * c + v.z * s;
    const z = -v.x * s + v.z * c;
    v.x = x; v.z = z;
    return v;
  }
  worldToLocal(v) { // full inverse of root transform
    v.sub(this.pos);
    const c = Math.cos(-this.yaw), s = Math.sin(-this.yaw);
    const x = v.x * c + v.z * s;
    const z = -v.x * s + v.z * c;
    v.x = x; v.z = z;
    return v;
  }

  // ==========================================================================
  spawnAt(x, z) {
    this.pos.set(x, this.g.plan === 'flyer' ? this.dim.hoverH : 0, z);
    this.flyY.set(this.pos.y);
    if (this.legs.length) this.settleFeet();
    for (const { chain } of this.chains) {
      chain.reset(_v.set(x, Math.max(0.3, this.pos.y), z));
    }
    this.spawnT = 0.0001;
  }

  despawn() { if (this.dieT < 0) this.dieT = 0; }

  grab() {
    if (this.state === 'held') return;
    this.state = 'held';
    this.eyeScale.target = 1.3;
    this.squash.kick(-3);
    this.goal = null;
    this.holdWobble.set(this.pos);
  }

  release() {
    if (this.state !== 'held') return;
    this.state = 'falling';
    this.airT = 0;
    // keep the fling: releases become throws
    this.vel.copy(this.holdWobble.vel).multiplyScalar(0.85);
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > 11) { this.vel.x *= 11 / hs; this.vel.z *= 11 / hs; }
    this.vel.y = clamp(this.vel.y, -12, 9);
    this.eyeScale.target = 1.35;
  }

  // ran face-first into something too big to eat
  bonk(p) {
    _v.set(this.pos.x - p.x, 0, this.pos.z - p.z).normalize();
    const sp = Math.max(this.vel.length() * 0.4, 2);
    this.vel.x = _v.x * sp;
    this.vel.z = _v.z * sp;
    this.vel.y = Math.max(-this.vel.y * 0.2, 2.2);
    this.squash.kick(-5.5);
    this.dizzyT = 3;
    this.bonkCooldown = 0.6;
    this.goal = null;
    this.eyeScale.target = 1.2;
  }

  pet() {
    this.squash.kick(-4.5);
    this.happyT = 1.1;
    this.blinkT = Math.max(this.blinkT, 0.001); // squeeze eyes
    this.fx.heartsBurst(this.bodyCenter);
    this.excited = Math.max(this.excited, 0.6);
  }

  callTo(x, z) {
    this.goal = new THREE.Vector3(x, 0, z);
    this.excited = 1.2;
    this.decideT = 3 + Math.random() * 2;
    this.squash.kick(-2.5);
  }

  // Evolution showcase: float up, face the camera, then turntable-spin while
  // the cinematic camera and card admire the newborn.
  startShowcase(duration) {
    this.state = 'showcase';
    this.showcaseT = 0;
    this.showcaseDur = duration;
    this.goal = null;
    this.eyeScale.target = 1.15;
  }

  endShowcase() {
    if (this.state === 'showcase') this.showcaseT = this.showcaseDur;
  }

  updateShowcase(dt, ctx) {
    this.showcaseT += dt;
    const hoverY = 0.5 * this.s + 0.4;
    this.pos.y += (hoverY - this.pos.y) * damp(4, dt);
    this.vel.set(0, 0, 0);
    // snap to profile (facing screen-left) first, then spin so the face
    // sweeps around toward the viewer
    _v.copy(ctx.camera.position).sub(this.pos);
    const camYaw = Math.atan2(_v.x, _v.z);
    if (this.showcaseT < 0.45) this.yaw = dampAngle(this.yaw, camYaw - Math.PI / 2, 10, dt);
    else this.yaw += dt * 2.6;
    this.squash.target = 1.05;
    this.lookTargetWorld = ctx.camera.position;
    this.lookHoldT = 0.3;
    this.bodyLift = 0;
    if (this.g.plan === 'flyer') this.flapPhase += dt * 9;
    if (this.legs.length) {
      for (const leg of this.legs) { this.legHome(leg, leg.foot); leg.stepping = false; }
    }
    if (this.showcaseT >= this.showcaseDur) {
      // gentle drop back into the world
      this.state = 'falling';
      this.airT = 0;
      this.squash.target = 1;
      this.eyeScale.target = 1;
    }
  }

  // ==========================================================================
  update(dt, ctx) {
    if (this.dead) return; // absorbed into a merge this frame
    const g = this.g, d = this.dim;

    // spawn / despawn scale
    if (this.spawnT < 1) this.spawnT = Math.min(1, this.spawnT + dt / 0.55);
    let scaleK = easeOutBack(this.spawnT, 2.2);
    // absorption growth bounce
    if (this.growT < 1) {
      this.growT = Math.min(1, this.growT + dt / 0.45);
      scaleK *= lerp(this.growFrom, 1, easeOutBack(this.growT, 2.4));
    }
    if (this.dieT >= 0) {
      this.dieT += dt;
      const t = clamp01(this.dieT / 0.3);
      scaleK *= 1 - easeInCubic(t);
      if (t >= 1 && !this.dead) {
        this.dead = true;
        this.fx.pop(this.bodyCenter, g.palette);
      }
    }
    this.renderScale = Math.max(0.001, scaleK);

    // ---- state machines ----------------------------------------------------
    if (this.state === 'held') this.updateHeld(dt, ctx);
    else if (this.state === 'falling') this.updateFalling(dt, ctx);
    else if (this.state === 'showcase') this.updateShowcase(dt, ctx);
    else this.updateRoam(dt, ctx);

    // ---- shared timers -------------------------------------------------------
    this.breathPhase += dt * 2.1;
    this.excited = Math.max(0, this.excited - dt * 0.35);
    this.happyT = Math.max(0, this.happyT - dt);
    this.squash.update(dt);
    this.squash.value = clamp(this.squash.value, 0.45, 1.6);
    this.bounceY.update(dt);
    this.eyeScale.update(dt);
    this.flinchT = Math.max(0, this.flinchT - dt);
    this.bonkCooldown = Math.max(0, this.bonkCooldown - dt);
    if (this.state === 'roam') {
      this.eyeScale.target = this.flinchT > 0 ? 1.35 : this.happyT > 0 ? 1.12 : 1;
    }

    // dizzy after a bonk: stars orbit the head, pupils spin (in updateEyes)
    if (this.dizzyT > 0) {
      this.dizzyT -= dt;
      this.dizzyPhase += dt * 8;
      this.dizzyStarT -= dt;
      if (this.dizzyStarT <= 0) {
        this.dizzyStarT = 0.12;
        const a = this.dizzyPhase * 1.4;
        const orbitR = this.dim.headR * 1.8 + 0.12;
        const headY = this.pos.y + (this.headLocal ? this.headLocal.y * this.squash.value : this.dim.hipH + this.dim.headR)
          + this.dim.headR * 1.1;
        _v.set(this.bodyCenter.x + Math.cos(a) * orbitR, headY, this.bodyCenter.z + Math.sin(a) * orbitR);
        _v2.set(0, 0.12, 0);
        _c.set('#ffd76a');
        this.fx.stars.spawn(_v, _v2, 0.42, 0.17 * Math.max(this.s, 1), _c, 0, 2);
      }
    }

    // blink
    this.blinkNext -= dt;
    if (this.blinkNext <= 0 && this.blinkT <= 0) {
      this.blinkT = 0.0001;
      this.blinkNext = (1.5 + Math.random() * 4) / this.g.blinkRate;
    }
    if (this.blinkT > 0) {
      this.blinkT += dt;
      if (this.blinkT > 0.22) this.blinkT = 0;
    }

    // lean from smoothed acceleration
    _v.copy(this.vel).sub(this.prevVel).divideScalar(Math.max(dt, 1e-4));
    this.smoothAccel.lerp(_v, damp(6, dt));
    this.prevVel.copy(this.vel);
    _v2.copy(this.smoothAccel);
    this.worldToLocalDir(_v2);
    const targetPitch = clamp(_v2.z * 0.045, -0.3, 0.3)
      + (this.state === 'falling' ? clamp(-this.vel.y * 0.03, -0.15, 0.3) : 0);
    const yawRate = (this.yaw - this.prevYaw) / Math.max(dt, 1e-4);
    this.prevYaw = this.yaw;
    const targetRoll = clamp(-_v2.x * 0.04, -0.25, 0.25)
      + (g.plan === 'flyer' ? clamp(-yawRate * 0.22, -0.5, 0.5) : 0);
    this.pitch += (targetPitch - this.pitch) * damp(8, dt);
    this.roll += (targetRoll - this.roll) * damp(8, dt);
    if (this.dizzyT > 0) this.roll += Math.sin(this.dizzyPhase) * 0.13 * Math.min(this.dizzyT, 1);

    // ---- pose + pack ---------------------------------------------------------
    this.updateEyes(dt, ctx);
    this.packFrame(dt, ctx);
  }

  worldToLocalDir(v) {
    const c = Math.cos(-this.yaw), s = Math.sin(-this.yaw);
    const x = v.x * c + v.z * s;
    const z = -v.x * s + v.z * c;
    v.x = x; v.z = z;
    return v;
  }

  // ==========================================================================
  updateRoam(dt, ctx) {
    const g = this.g, d = this.dim;

    // dizzy: stagger in place instead of going anywhere
    if (this.dizzyT > 0) {
      this.goal = null;
      this.yaw += Math.sin(this.dizzyPhase * 0.7) * dt * 2;
    }

    // --- decisions ---
    this.decideT -= dt;
    if (this.decideT <= 0) {
      if (Math.random() < 0.55 * g.wanderlust) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * (ENV.arenaRadius - 1);
        this.goal = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      } else {
        this.goal = null;
        // idle emotes
        const roll = Math.random();
        if (roll < 0.3) {
          // look at a neighbour or the camera
          const others = ctx.creatures.filter((c) => c !== this && !c.dead);
          if (Math.random() < g.curiosity || others.length === 0) {
            this.lookTargetWorld = ctx.camera.position;
          } else {
            this.lookTargetWorld = others[(Math.random() * others.length) | 0].bodyCenter;
          }
          this.lookHoldT = 1.5 + Math.random() * 2;
        } else if (roll < 0.45) {
          this.squash.kick(-3.2); // happy boing
        }
      }
      this.decideT = (1.5 + Math.random() * 3.5) / g.wanderlust;
    }

    // --- flinch at incoming squishlings ---
    for (const o of ctx.creatures) {
      if (o === this || o.state !== 'falling' || o.dead) continue;
      _v2.copy(this.pos).sub(o.pos);
      const dd = _v2.length();
      if (dd < 4.5 && o.vel.dot(_v2) > 0) {
        this.lookTargetWorld = o.bodyCenter;
        this.lookHoldT = 0.3;
        this.flinchT = 0.2;
        if (this.g.plan !== 'hopper') this.squash.target = dd < 2 ? 0.88 : 1;
        break;
      }
    }

    // --- steering ---
    _v.set(0, 0, 0);
    const speedCap = (g.plan === 'flyer' ? 2.6 : g.plan === 'hopper' ? 0 : 1.55)
      * g.speed * (1 + this.excited * 0.7);
    if (this.goal && g.plan !== 'hopper') {
      _v2.copy(this.goal).sub(this.pos); _v2.y = 0;
      const dist = _v2.length();
      if (dist < 0.5) { this.goal = null; }
      else {
        const arrive = clamp01(dist / 1.8);
        _v.addScaledVector(_v2.normalize(), speedCap * arrive);
      }
    }
    // stay inside the arena
    const rr = Math.hypot(this.pos.x, this.pos.z);
    if (rr > ENV.arenaRadius) {
      _v.addScaledVector(_v2.set(-this.pos.x / rr, 0, -this.pos.z / rr), (rr - ENV.arenaRadius) * 2);
    }
    // separation
    for (const o of ctx.creatures) {
      if (o === this || o.dead) continue;
      _v2.copy(this.pos).sub(o.pos); _v2.y = 0;
      const dd = _v2.length();
      const minD = (this.dim.r0 + o.dim.r0) * 2.4;
      if (dd < minD && dd > 1e-4) _v.addScaledVector(_v2.normalize(), (minD - dd) * 1.6);
    }

    if (g.plan === 'hopper') this.updateHopper(dt, _v);
    else if (g.plan === 'flyer') this.updateFlyer(dt, _v, speedCap);
    else this.updateWalker(dt, _v, speedCap);
  }

  // --------------------------------------------------------------------------
  updateWalker(dt, desiredVel, speedCap) {
    const d = this.dim;
    desiredVel.y = 0;
    if (desiredVel.length() > speedCap) desiredVel.setLength(speedCap);
    this.vel.lerp(desiredVel, damp(4, dt));
    this.vel.y = 0;
    this.pos.addScaledVector(this.vel, dt);

    const speed = this.vel.length();
    if (speed > 0.15) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      this.yaw = dampAngle(this.yaw, targetYaw, 7, dt);
    }

    // gait clock: cycles faster with speed
    const strideLen = Math.max(d.legLen * 0.9, 0.25);
    const freq = clamp(speed / strideLen * 0.9, 0, 3.2);
    this.gaitClock = (this.gaitClock + dt * freq) % 1;
    this.bobPhase += dt * freq * Math.PI * 2;

    this.updateLegs(dt, speed, freq);

    // body height: standing height + gait bob - squash is applied at pack time
    const bob = Math.sin(this.bobPhase * 2) * 0.035 * clamp01(speed) * d.legLen;
    this.pos.y = 0;
    this.bodyLift = bob;
  }

  updateLegs(dt, speed, freq) {
    const d = this.dim;
    const stepDur = lerp(0.26, 0.13, clamp01(speed / 2.5));
    const trigger = (speed < 0.1 ? 0.3 : 0.16 + speed * 0.14) * Math.max(this.s, 0.6);
    const lead = 0.20 + 0.06 * speed;

    let steppingCount = 0;
    for (const leg of this.legs) if (leg.stepping) steppingCount++;

    for (const leg of this.legs) {
      this.legHome(leg, leg.home);
      // predicted landing spot
      _v3.copy(leg.home).addScaledVector(this.vel, lead);

      if (!leg.stepping) {
        const err = _v2.copy(leg.foot).sub(_v3).length();
        // gait gate: this leg's group window, or free when idle-repositioning
        const phaseOk = speed < 0.1
          ? steppingCount === 0
          : (this.gaitClock < 0.5 ? 0 : 1) === leg.group && steppingCount < this.legs.length / 2 + 0.5;
        if (err > trigger && phaseOk) {
          leg.stepping = true;
          leg.stepT = 0;
          leg.stepFrom.copy(leg.foot);
          steppingCount++;
        }
      }
      if (leg.stepping) {
        leg.stepT += dt / stepDur;
        const t = clamp01(leg.stepT);
        const e = smoothstep(0, 1, t);
        leg.foot.lerpVectors(leg.stepFrom, _v3, e);
        leg.foot.y = Math.sin(t * Math.PI) * (0.1 + 0.12 * clamp01(speed)) * Math.max(d.legLen, 0.3);
        if (t >= 1) {
          leg.stepping = false;
          leg.foot.y = 0;
          if (speed > 1.1 && Math.random() < 0.7) {
            this.fx.footDust(_v2.copy(leg.foot).setY(0.05), 0.7);
          }
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  updateHopper(dt, desiredVel) {
    const g = this.g, d = this.dim, hop = this.hop;
    const wantsToMove = desiredVel.lengthSq() > 0.15 || (this.goal !== null);

    switch (hop.state) {
      case 'sit': {
        this.vel.set(0, 0, 0);
        this.pos.y = 0;
        hop.cooldown -= dt;
        if (this.goal) {
          _v2.copy(this.goal).sub(this.pos); _v2.y = 0;
          if (_v2.length() < 0.45) this.goal = null;
          else {
            const targetYaw = Math.atan2(_v2.x, _v2.z);
            this.yaw = dampAngle(this.yaw, targetYaw, 6, dt);
          }
        }
        if (hop.cooldown <= 0 && (wantsToMove || desiredVel.lengthSq() > 0.02 || Math.random() < dt * 0.25)) {
          hop.state = 'windup';
          hop.t = 0;
          this.squash.target = 0.68;
        }
        break;
      }
      case 'windup': {
        hop.t += dt;
        if (hop.t > 0.14) {
          hop.state = 'air';
          this.squash.target = 1;
          this.squash.value = 1.22;
          this.squash.vel = 2;
          // launch toward goal / desired dir
          let hdist = 0.9, hheight = 0.55 * g.bounciness * this.s;
          if (this.goal) {
            _v2.copy(this.goal).sub(this.pos); _v2.y = 0;
            hdist = clamp(_v2.length() * 0.5, 0.5, 1.6) * (1 + this.excited * 0.4);
            _v2.normalize();
          } else if (desiredVel.lengthSq() > 0.01) {
            _v2.copy(desiredVel).normalize();
            hdist = 0.7;
          } else {
            _v2.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
            hdist = 0.35; hheight *= 0.7; // idle boing
          }
          hop.vy = Math.sqrt(2 * GRAVITY * hheight);
          const airTime = 2 * hop.vy / GRAVITY;
          this.vel.copy(_v2).multiplyScalar(hdist / airTime);
          this.vel.y = hop.vy;
        }
        break;
      }
      case 'air': {
        this.vel.y -= GRAVITY * dt;
        this.pos.addScaledVector(this.vel, dt);
        // stretch along the arc
        this.squash.target = 1.14;
        if (this.pos.y <= 0 && this.vel.y < 0) {
          this.pos.y = 0;
          const impact = -this.vel.y;
          this.vel.set(0, 0, 0);
          hop.state = 'sit';
          hop.cooldown = this.goal ? 0.06 + Math.random() * 0.1 : 0.5 + Math.random() * 1.2;
          this.squash.target = 1;
          this.squash.kick(-impact * 1.3);
          this.fx.landDust(_v2.copy(this.pos).setY(0.04), clamp(impact / 5, 0.4, 1.2));
        }
        break;
      }
    }
    this.bodyLift = 0;
  }

  // --------------------------------------------------------------------------
  updateFlyer(dt, desiredVel, speedCap) {
    const d = this.dim;
    desiredVel.y = 0;
    if (desiredVel.length() > speedCap) desiredVel.setLength(speedCap);
    this.vel.x = lerp(this.vel.x, desiredVel.x, damp(2.5, dt));
    this.vel.z = lerp(this.vel.z, desiredVel.z, damp(2.5, dt));
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > 0.2) {
      this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), 4, dt);
    }

    // hover height with a lazy sine bob + occasional swoops
    this.flyY.target = d.hoverH + Math.sin(this.breathPhase * 0.6) * 0.15 * this.s
      + (this.goal ? Math.sin(this.goal.x * 3.1 + this.goal.z * 1.7) * 0.4 : 0);
    this.pos.y = Math.max(0.35, this.flyY.update(dt));

    const climb = this.flyY.vel;
    this.flapPhase += dt * (5.5 + speed * 1.2 + clamp(climb, 0, 2) * 2.5);
    this.bodyLift = 0;
  }

  // --------------------------------------------------------------------------
  updateHeld(dt, ctx) {
    this.holdWobble.target.copy(this.heldTarget);
    this.holdWobble.update(dt);
    this.pos.copy(this.holdWobble.value);
    if (this.pos.y < 0.4) this.pos.y = 0.4;
    this.vel.copy(this.holdWobble.vel);
    // face the camera-ish, slowly
    _v.copy(ctx.camera.position).sub(this.pos);
    this.yaw = dampAngle(this.yaw, Math.atan2(_v.x, _v.z), 2, dt);
    this.lookTargetWorld = ctx.camera.position;
    this.lookHoldT = 0.2;
    this.squash.target = 1.06; // slightly stretched, like a picked-up cat
    if (this.g.plan === 'flyer') this.flapPhase += dt * 14; // panic flutter
    this.bodyLift = 0;
    // feet dangle handled in pose; keep leg plants under us for landing
    if (this.legs.length) for (const leg of this.legs) { this.legHome(leg, leg.foot); leg.stepping = false; }
  }

  updateFalling(dt, ctx) {
    this.airT += dt;
    this.vel.y -= GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    this.squash.target = 1.15;

    // gentle aim assist: a fast throw near another squishling curves in
    const spd = this.vel.length();
    if (spd > 2.5) {
      let near = null, nd = 2.6;
      for (const o of ctx.creatures) {
        if (o === this || o.dead || o.dieT >= 0) continue;
        const dd = this.bodyCenter.distanceTo(o.bodyCenter);
        if (dd < nd) { nd = dd; near = o; }
      }
      if (near) {
        _v.copy(near.bodyCenter).sub(this.bodyCenter).normalize();
        this.vel.addScaledVector(_v, dt * spd * 3.5 * clamp01(1 - nd / 2.6));
      }
    }

    // stage props: gulp the small ones, bonk off the big ones
    if (ctx.propHit && this.bonkCooldown <= 0 && this.vel.length() > 2) {
      for (const p of WORLD_PROPS) {
        if (!p.alive) continue;
        const dx = this.pos.x - p.x, dz = this.pos.z - p.z;
        const rr = p.r + this.dim.r0 * 1.2 * this.renderScale;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (this.pos.y > p.h + this.dim.r0) continue;
        ctx.propHit(this, p);
        break;
      }
      if (this.dead || this.state !== 'falling') return;
    }

    // mid-air collisions: fast hits merge, soft hits bonk
    for (const o of ctx.creatures) {
      if (o === this || o.dead || o.dieT >= 0 || o.spawnT < 0.6) continue;
      if (o.state === 'falling' && o.id > this.id) continue; // pair handled once
      const rr = this.dim.r0 * 1.6 * this.renderScale + o.dim.r0 * 1.6 * o.renderScale;
      if (this.bodyCenter.distanceToSquared(o.bodyCenter) > rr * rr) continue;
      const rel = _v.copy(this.vel).sub(o.vel).length();
      if (rel > 2.8 && ctx.requestMerge) {
        ctx.requestMerge(this, o);
        return;
      }
      // soft bonk: shove apart, squash both, poof
      _v2.copy(this.bodyCenter).sub(o.bodyCenter);
      _v2.y = 0;
      _v2.normalize();
      this.vel.addScaledVector(_v2, 1.6);
      this.vel.y = Math.max(this.vel.y, 1.2);
      if (o.state === 'held') o.holdWobble.vel.addScaledVector(_v2, -2);
      else o.vel.addScaledVector(_v2, -1.2);
      o.squash.kick(-2.5);
      this.squash.kick(-2.5);
      o.excited = 1;
      o.lookTargetWorld = this.bodyCenter;
      o.lookHoldT = 1.5;
      this.fx.footDust(_v2.copy(this.bodyCenter).lerp(o.bodyCenter, 0.5), 1.3);
      break;
    }
    if (this.g.plan === 'flyer') {
      this.flapPhase += dt * 16;
      // flyers catch themselves after a beat
      if (this.airT > 0.35 && this.pos.y > 0.4) {
        this.state = 'roam';
        this.flyY.set(this.pos.y);
        this.flyY.vel = this.vel.y * 0.4;
        this.vel.y = 0;
        this.squash.target = 1;
        this.squash.kick(-3);
        this.eyeScale.target = 1;
        return;
      }
    }
    if (this.g.arms) this.armFlail += dt * 22; // aaaaah
    if (this.pos.y <= 0) {
      this.pos.y = 0;
      const impact = -this.vel.y;
      if (impact > 7.5) {
        // one comedy bounce
        this.vel.y = impact * 0.26;
        this.vel.x *= 0.5; this.vel.z *= 0.5;
        this.squash.kick(-impact * 1.5);
        this.fx.landDust(_v2.copy(this.pos).setY(0.04), clamp(impact / 6, 0.5, 1.4));
      } else {
        this.state = 'roam';
        this.vel.set(0, 0, 0);
        this.squash.target = 1;
        this.squash.kick(-impact * 1.35);
        this.eyeScale.target = 1;
        this.fx.landDust(_v2.copy(this.pos).setY(0.04), clamp(impact / 6, 0.35, 1.4));
        if (this.legs.length) this.settleFeet();
        this.hop.state = 'sit';
        this.hop.cooldown = 0.6;
      }
    }
  }

  // ==========================================================================
  updateEyes(dt, ctx) {
    // look target: goal > explicit target > forward
    this.lookHoldT -= dt;
    let target = null;
    if (this.state === 'held' || this.state === 'falling' || this.state === 'showcase') {
      target = ctx.camera.position;
    }
    else if (this.lookHoldT > 0 && this.lookTargetWorld) target = this.lookTargetWorld;
    else if (this.goal) target = this.goal;

    if (target) {
      _v.copy(target).sub(this.bodyCenter.lengthSq() ? this.bodyCenter : this.pos);
      this.worldToLocalDir(_v);
      _v.normalize();
      _v.y = clamp(_v.y, -0.55, 0.75);
      if (_v.z < 0.15) { _v.z = 0.15; _v.normalize(); } // eyes can't look backwards
    } else {
      _v.set(0, 0.02, 1);
    }
    // dizzy: pupils roll in circles, overriding everything else
    if (this.dizzyT > 0) {
      const a = this.dizzyPhase * 1.6;
      _v.set(Math.cos(a) * 0.6, Math.sin(a) * 0.5 + 0.05, 1).normalize();
      this.eyeLookLocal.lerp(_v, damp(20, dt)).normalize();
      return;
    }

    // saccades: quick little pupil darts
    this.saccadeT -= dt;
    if (this.saccadeT <= 0) {
      this.saccade.set((Math.random() - 0.5) * 0.16, (Math.random() - 0.5) * 0.12, 0);
      this.saccadeT = 0.6 + Math.random() * 2.2;
    }
    _v.add(this.saccade).normalize();
    this.eyeLookLocal.lerp(_v, damp(14, dt)).normalize();
  }

  // ==========================================================================
  // Pack the whole rig into SDF primitive uniforms.
  packFrame(dt, ctx) {
    const g = this.g, d = this.dim, s = this.s;
    this.primCursor = 0;

    const squash = this.squash.value;
    // spread capped at 1.25 — the bounding box is padded for exactly this
    const sxz = 1 / Math.sqrt(clamp(squash, 0.64, 1.5));
    this.squashXZ = sxz;

    // --- local body frame with lean -------------------------------------------
    _e.set(this.pitch, 0, this.roll);
    _q.setFromEuler(_e);
    const upB = _v3.set(0, 1, 0).applyQuaternion(_q).clone();
    const fwdB = _v4.set(0, 0, 1).applyQuaternion(_q).clone();
    const rightB = _v.crossVectors(upB, fwdB).normalize().clone();

    const breathe = 1 + Math.sin(this.breathPhase) * 0.025;
    const baseH = (g.plan === 'flyer' ? 0 : d.hipH) + (this.bodyLift || 0) + this.bounceY.value;

    // hip + chest
    const hip = new THREE.Vector3(0, baseH, 0);
    const bodyAxis = new THREE.Vector3()
      .addScaledVector(fwdB, 1 - g.body.upright)
      .addScaledVector(upB, g.body.upright)
      .normalize();
    const chest = hip.clone().addScaledVector(bodyAxis, d.bodyLen);
    this.hipLocal = hip; this.chestLocal = chest;

    this.pushPrim(hip, d.r0 * breathe, chest, d.r1 * breathe, g.palette.base, 0, 0.24 * s);
    // belly: soft cream blob low on the front
    _v.copy(hip).lerp(chest, 0.45).addScaledVector(fwdB, d.r0 * 0.42).addScaledVector(upB, -d.r0 * 0.08);
    this.pushPrim(_v, d.r0 * 0.68 * breathe, _v, d.r0 * 0.68 * breathe, g.palette.belly, 0, 0.16 * s);

    // --- head ------------------------------------------------------------------
    const horizontal = g.plan === 'quad' || g.plan === 'hexa';
    const head = chest.clone();
    if (g.plan === 'hopper') {
      // hoppers are one teardrop: head only peeks out of the top
      head.addScaledVector(upB, d.r1 * 0.4 + d.headR * g.head.up * 0.4)
        .addScaledVector(fwdB, d.headR * g.head.fwd + d.r1 * 0.2);
    } else if (horizontal) {
      // head out in front of the chest, lifted a little
      head.addScaledVector(fwdB, d.r1 * 0.55 + d.headR * (0.35 + g.head.fwd))
        .addScaledVector(upB, d.r1 * 0.3 + d.headR * g.head.up * 0.55);
    } else {
      // upright: head clearly above the chest with a chunky blended neck
      head.addScaledVector(upB, d.r1 * 0.72 + d.headR * (0.3 + g.head.up * 0.55))
        .addScaledVector(fwdB, d.headR * g.head.fwd + d.r1 * 0.18);
    }
    // heads tilt subtly toward whatever they look at
    head.addScaledVector(rightB, this.eyeLookLocal.x * d.headR * 0.22);
    head.y += this.eyeLookLocal.y * d.headR * 0.15;
    this.headLocal = head;
    this.pushPrim(head, d.headR, head, d.headR, g.palette.base, 0, 0.22 * s);

    const headFwd = fwdB.clone().addScaledVector(rightB, this.eyeLookLocal.x * 0.3).normalize();

    // snout
    if (g.head.snout) {
      _v.copy(head).addScaledVector(headFwd, d.headR * (0.55 + g.head.snout.len * 0.5)).addScaledVector(upB, -d.headR * 0.18);
      const sr = d.headR * g.head.snout.r;
      this.pushPrim(head, d.headR * 0.7, _v, sr, g.palette.belly, 0, 0.14 * s);
      if (g.head.snout.nose) {
        _v2.copy(_v).addScaledVector(headFwd, sr * 0.72);
        this.pushPrim(_v2, sr * 0.42, _v2, sr * 0.42, g.palette.accent, 1, 0.05 * s);
      }
    }

    // --- tail / ear chains -------------------------------------------------------
    _q.setFromAxisAngle(UP, this.yaw); // local->world rest frame for chains
    for (const entry of this.chains) {
      const { chain, kind } = entry;
      let anchorL;
      if (kind === 'tail') {
        anchorL = _v.copy(hip).addScaledVector(bodyAxis, -d.r0 * 0.55);
      } else {
        anchorL = _v.copy(head)
          .addScaledVector(rightB, entry.side * d.headR * g.ears.spread)
          .addScaledVector(upB, d.headR * 0.8);
      }
      // anchor to world
      _v2.copy(anchorL); this.localToWorldDir(_v2); _v2.add(this.pos);
      chain.update(dt, _v2, _q);

      // chain points back to local prims
      const pts = chain.points;
      const isTail = kind === 'tail';
      const isAntenna = !isTail && g.ears.type === 'antenna';
      const tipStyle = isAntenna ? (g.ears.tip || 'ball') : null;
      const r0 = isTail ? g.tail.r * s : g.ears.r * s;
      const taper = isTail ? g.tail.taper
        : isAntenna ? (tipStyle === 'point' ? 0.3 : 0.8) : 0.75;
      for (let i = 0; i < pts.length - 1; i++) {
        _v2.copy(pts[i]); this.worldToLocal(_v2);
        _v3.copy(pts[i + 1]); this.worldToLocal(_v3);
        const ra = r0 * lerp(1, taper, i / (pts.length - 1));
        const rb = r0 * lerp(1, taper, (i + 1) / (pts.length - 1));
        this.pushPrim(_v2, ra, _v3, rb, g.palette.base, 0, (isTail ? 0.13 : 0.08) * s);
      }
      if (isTail && g.tail.puff) {
        _v2.copy(pts[pts.length - 1]); this.worldToLocal(_v2);
        this.pushPrim(_v2, r0 * 1.15, _v2, r0 * 1.15, g.palette.accent, 0, 0.1 * s);
      } else if (isAntenna && tipStyle !== 'point') {
        _v2.copy(pts[pts.length - 1]); this.worldToLocal(_v2);
        if (tipStyle === 'pom') {
          this.pushPrim(_v2, r0 * 2.7, _v2, r0 * 2.7, g.palette.accent, 0, 0.09 * s);
        } else if (tipStyle === 'lantern') {
          // flat material = unshaded -> reads as a glowing bulb
          this.pushPrim(_v2, r0 * 2.2, _v2, r0 * 2.2, g.palette.accent, 1, 0.05 * s);
        } else {
          this.pushPrim(_v2, r0 * 1.9, _v2, r0 * 1.9, g.palette.accent, 0, 0.06 * s);
        }
      }
    }
    // nub ears / horns (static, no chain)
    if (g.ears && (g.ears.type === 'nub')) {
      for (const side of [-1, 1]) {
        _v.copy(head).addScaledVector(rightB, side * d.headR * g.ears.spread).addScaledVector(upB, d.headR * 0.75);
        _v2.copy(_v).addScaledVector(upB, g.ears.len * s).addScaledVector(rightB, side * g.ears.len * s * 0.3);
        this.pushPrim(_v, g.ears.r * s, _v2, g.ears.r * s * 0.7, g.palette.base, 0, 0.09 * s);
      }
    }

    // --- legs ---------------------------------------------------------------------
    if (this.legs.length) this.packLegs(dt, hip, chest, upB, rightB, fwdB);

    // --- arms / wings ----------------------------------------------------------------
    if (g.arms) this.packArms(dt, chest, upB, rightB, fwdB);
    if (g.wings) this.packWings(chest, upB, rightB, fwdB);

    // --- face: eyes + blush (packed last, crisp blend) ---------------------------------
    const blink = this.blinkT > 0 ? Math.sin(clamp01(this.blinkT / 0.22) * Math.PI) : 0;
    const baseEyeR = g.eyes.r * s * this.eyeScale.value * (1 - blink * 0.35);
    const eyeCount = g.eyes.count || 2;
    // cyclops: one big centered eye · third eye: smaller, riding high
    const eyeDefs = eyeCount === 1 ? [{ side: 0, up: 0, rMul: 1.25 }]
      : eyeCount === 3 ? [{ side: -1 }, { side: 1 }, { side: 0, up: 0.34, rMul: 0.72 }]
        : [{ side: -1 }, { side: 1 }];
    for (const def of eyeDefs) {
      const eyeR = baseEyeR * (def.rMul || 1);
      _v.copy(head)
        .addScaledVector(headFwd, d.headR * 0.88)
        .addScaledVector(rightB, def.side * d.headR * g.eyes.spread * 0.66)
        .addScaledVector(upB, d.headR * (g.eyes.up + (def.up || 0)));
      // blink: eye sinks into the head and takes the skin color — reads as closed
      _c.copy(new THREE.Color('#fffdf5')).lerp(g.palette.base, blink);
      const sink = blink * eyeR * 0.5;
      _v.addScaledVector(headFwd, -sink);
      this.pushPrim(_v, eyeR, _v, eyeR, _c, blink > 0.5 ? 1 : 2, 0.028 * s);
    }
    if (g.blush) {
      for (const side of [-1, 1]) {
        _v.copy(head)
          .addScaledVector(headFwd, d.headR * 0.62)
          .addScaledVector(rightB, side * d.headR * 0.72)
          .addScaledVector(upB, -d.headR * 0.12);
        this.pushPrim(_v, d.headR * 0.2, _v, d.headR * 0.2, g.palette.blush, 1, 0.04 * s);
      }
    }

    this.finishPack(ctx);
  }

  // --------------------------------------------------------------------------
  packLegs(dt, hip, chest, upB, rightB, fwdB) {
    const g = this.g, d = this.dim;
    const held = this.state === 'held' || this.state === 'falling' || this.state === 'showcase';
    const bendFwd = g.plan === 'hexa' ? 0.15 : 1;

    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      // hip attach point: interpolate along the body by the leg's z position
      const attach = _v.copy(hip);
      if (g.plan === 'quad' || g.plan === 'hexa') {
        const t = clamp01((leg.z + d.bodyLen * 0.55) / Math.max(d.bodyLen * 1.1, 1e-3));
        attach.lerp(chest, t);
      }
      attach.addScaledVector(rightB, leg.side * d.hipW).addScaledVector(upB, -d.r0 * 0.25);

      // foot in local space
      let footL;
      if (held) {
        // dangle: below the attach, swaying with motion + a run-flail mid-air
        const flail = this.state === 'falling'
          ? Math.sin(this.airT * 18 + i * 2.1) * 0.3 * d.legLen : 0;
        footL = _v2.copy(attach)
          .addScaledVector(upB, -d.legLen * 0.82)
          .addScaledVector(fwdB, flail + clamp(-this.smoothAccel.z * 0.02, -0.2, 0.2))
          .addScaledVector(rightB, clamp(-this.smoothAccel.x * 0.015, -0.15, 0.15) * leg.side);
      } else if (g.plan === 'flyer') {
        // dangling flyer feet with a bit of drift
        footL = _v2.copy(attach)
          .addScaledVector(upB, -d.legLen * 0.8)
          .addScaledVector(fwdB, Math.sin(this.flapPhase * 0.5 + i) * 0.05);
      } else {
        footL = _v2.copy(leg.foot);
        this.worldToLocal(footL);
      }

      // 2-bone IK
      const l1 = d.legLen * 0.55, l2 = d.legLen * 0.55;
      _v3.copy(fwdB).multiplyScalar(bendFwd).addScaledVector(rightB, leg.side * (g.plan === 'hexa' ? 1.2 : 0.25));
      if (g.plan === 'hexa') _v3.addScaledVector(upB, 0.9);
      solveTwoBoneIK(attach, footL, l1, l2, _v3, leg.knee);

      const thick = d.legThick;
      this.pushPrim(attach, thick * 1.5, leg.knee, thick * 1.05, this.g.palette.base, 0, 0.13 * this.s);
      this.pushPrim(leg.knee, thick * 1.05, footL, thick * 0.9, this.g.palette.base, 0, 0.08 * this.s);
      // foot blob (accent-colored booties!)
      if (g.plan !== 'hexa') {
        _v3.copy(footL).addScaledVector(fwdB, d.footR * 0.5);
        _v3.y = footL.y;
        this.pushPrim(footL, d.footR, _v3, d.footR * 0.82, this.g.palette.accent, 0, 0.06 * this.s);
      }
    }
  }

  // --------------------------------------------------------------------------
  packArms(dt, chest, upB, rightB, fwdB) {
    const g = this.g, d = this.dim;
    const armLen = g.arms.len * this.s;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const held = this.state === 'held' || this.state === 'showcase';
    const falling = this.state === 'falling';

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const shoulder = _v.copy(chest)
        .addScaledVector(rightB, side * d.r1 * (g.plan === 'hopper' ? 0.72 : 1.0))
        .addScaledVector(upB, d.r1 * 0.3);

      // target hand position
      let swing;
      if (falling) {
        swing = Math.sin(this.armFlail + i * Math.PI) * 1.4; // panic windmill
      } else if (held) {
        swing = Math.sin(this.breathPhase * 1.3 + i * Math.PI) * 0.25;
      } else if (g.plan === 'hopper') {
        // stubby T-rex arms held up, wiggling with squash
        swing = 0;
      } else {
        swing = Math.sin(this.bobPhase + i * Math.PI) * clamp01(speed) * 0.9;
      }

      _v2.copy(shoulder);
      if (g.plan === 'hopper') {
        _v2.addScaledVector(fwdB, armLen * 0.75)
          .addScaledVector(upB, -armLen * 0.15 + Math.sin(this.breathPhase * 2 + i) * armLen * 0.08)
          .addScaledVector(rightB, side * armLen * 0.28);
      } else {
        const dangleAmt = falling ? 0.35 : 0.95;
        _v2.addScaledVector(upB, -armLen * dangleAmt)
          .addScaledVector(fwdB, Math.sin(swing) * armLen * (falling ? 0.9 : 0.45))
          .addScaledVector(upB, Math.abs(Math.cos(swing)) * (falling ? armLen * 0.5 : 0))
          .addScaledVector(rightB, side * armLen * 0.38);
      }
      // spring-lag the hands for that floppy inertia feel
      const hs = this.hands[i];
      // springs run in local space; convert frame changes cheaply by just tracking local
      hs.target.copy(_v2);
      hs.update(dt);

      const thick = g.arms.thick * this.s;
      const handR = g.arms.handR * this.s * (g.plan === 'hopper' ? 0.7 : 1);
      const handCol = g.plan === 'hopper' ? g.palette.base : g.palette.accent;
      this.pushPrim(shoulder, thick * 1.4, hs.value, thick * 0.95, g.palette.base, 0, 0.1 * this.s);
      this.pushPrim(hs.value, handR, hs.value, handR, handCol, 0, 0.055 * this.s);
    }
  }

  // --------------------------------------------------------------------------
  packWings(chest, upB, rightB, fwdB) {
    const g = this.g, d = this.dim;
    const pairs = g.wings.pairs || 1;
    const sweep = g.wings.sweep ?? 0.16;

    for (let p = 0; p < pairs; p++) {
      // second pair (dragonfly!) sits behind, smaller, and flaps offset
      const L = g.wings.len * this.s * (p === 0 ? 1 : 0.72);
      const phase = this.flapPhase - p * 1.1;
      const flap = Math.sin(phase);
      const flapLag = Math.sin(phase - 0.6); // tip lags the arm: wing whip
      const a1 = 0.12 + flap * 0.55;         // inner segment: mostly outward
      const a2 = a1 * 0.5 + flapLag * 0.85;  // outer segment: whippy
      const backOff = p * d.r1 * 0.7;

      for (const side of [-1, 1]) {
        const shoulder = _v.copy(chest)
          .addScaledVector(rightB, side * d.r1 * 0.7)
          .addScaledVector(upB, d.r1 * (0.3 - p * 0.12))
          .addScaledVector(fwdB, -backOff);
        const elbow = _v2.copy(shoulder)
          .addScaledVector(rightB, side * Math.cos(a1) * L * 0.48)
          .addScaledVector(upB, Math.sin(a1) * L * 0.48)
          .addScaledVector(fwdB, -L * sweep * 0.25);
        const tip = _v3.copy(elbow)
          .addScaledVector(rightB, side * Math.cos(a2) * L * 0.58)
          .addScaledVector(upB, Math.sin(a2) * L * 0.58)
          .addScaledVector(fwdB, -L * sweep); // swept back
        const thick = g.wings.thick * this.s * (p === 0 ? 1 : 0.8);
        this.pushPrim(shoulder, thick * 1.5, elbow, thick * 1.05, g.palette.accent, 0, 0.1 * this.s);
        this.pushPrim(elbow, thick * 1.05, tip, thick * g.wings.tipR, g.palette.accent, 0, 0.07 * this.s);
        if (g.wings.tuft ?? true) {
          this.pushPrim(tip, thick * 1.25, tip, thick * 1.25, g.palette.belly, 0, 0.05 * this.s);
        }
      }
    }
  }

  // ==========================================================================
  pushPrim(a, ra, b, rb, color, matId, k) {
    if (this.primCursor >= MAX_PRIMS) return;
    const i = this.primCursor * 4;
    const u = this.material.uniforms;
    const sc = this.renderScale;
    const sq = this.squash.value, sxz = this.squashXZ;
    const pivot = 0; // squash about the ground plane

    let ax = a.x * sxz * sc, ay = (pivot + (a.y - pivot) * sq) * sc, az = a.z * sxz * sc;
    let bx = b.x * sxz * sc, by = (pivot + (b.y - pivot) * sq) * sc, bz = b.z * sxz * sc;
    // degenerate round cones divide by zero — nudge
    if (Math.abs(ax - bx) + Math.abs(ay - by) + Math.abs(az - bz) < 1e-4) by += 1e-3;
    const chub = 1 + (1 - clamp(sq, 0.5, 1)) * 0.35; // fatter when squashed
    u.uPrimA.value[i] = ax; u.uPrimA.value[i + 1] = ay; u.uPrimA.value[i + 2] = az;
    u.uPrimA.value[i + 3] = ra * sc * chub;
    u.uPrimB.value[i] = bx; u.uPrimB.value[i + 1] = by; u.uPrimB.value[i + 2] = bz;
    u.uPrimB.value[i + 3] = rb * sc * chub;
    u.uPrimC.value[i] = color.r; u.uPrimC.value[i + 1] = color.g; u.uPrimC.value[i + 2] = color.b;
    u.uPrimC.value[i + 3] = matId + clamp(k * sc, 0.002, 0.98) * 0.99;
    this.primCursor++;
  }

  finishPack(ctx) {
    const u = this.material.uniforms;
    u.uPrimCount.value = this.primCursor;

    // root transform
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.set(0, this.yaw, 0);
    this.mesh.updateMatrixWorld();

    // camera + light into local space
    _v.copy(ctx.camera.position).sub(this.pos);
    this.worldToLocalDir(_v);
    u.uCamLocal.value.copy(_v);
    _v.copy(ENV.lightDir);
    this.worldToLocalDir(_v);
    u.uLightLocal.value.copy(_v);
    u.uEyeLook.value.copy(this.eyeLookLocal);

    _m.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    u.uMVP.value.multiplyMatrices(_m, this.mesh.matrixWorld);

    // world-space body center (for picking, hearts, shadows)
    _v.copy(this.chestLocal).lerp(this.hipLocal, 0.5);
    this.localToWorldDir(_v);
    this.bodyCenter.copy(this.pos).add(_v);
  }

  // --------------------------------------------------------------------------
  addShadows(pool) {
    if (!this.hipLocal) return; // not posed yet (spawned late in this frame)
    const d = this.dim;
    const bodyH = this.pos.y + this.hipLocal.y * this.squash.value;
    pool.add(this.bodyCenter.x, this.bodyCenter.z, d.r0 * 1.5 * this.renderScale,
      Math.max(0, bodyH - d.hipH * 0.5), 1 + (1 - this.squash.value) * 0.5);
    if (this.legs.length && this.state === 'roam' && this.g.plan !== 'flyer') {
      for (const leg of this.legs) {
        pool.add(leg.foot.x, leg.foot.z, d.footR * 1.6, leg.foot.y, 1);
      }
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
