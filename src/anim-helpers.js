// Procedural animation building blocks: springs, verlet chains, 2-bone IK, easing.
import * as THREE from 'three';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Critically-damped-ish scalar spring. Integrates toward `target`.
// ---------------------------------------------------------------------------
export class Spring {
  constructor(value = 0, stiffness = 120, damping = 14) {
    this.value = value;
    this.vel = 0;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }
  update(dt) {
    const f = (this.target - this.value) * this.stiffness - this.vel * this.damping;
    this.vel += f * dt;
    this.value += this.vel * dt;
    return this.value;
  }
  set(v) { this.value = v; this.target = v; this.vel = 0; }
  kick(impulse) { this.vel += impulse; }
}

export class SpringVec3 {
  constructor(stiffness = 120, damping = 14) {
    this.value = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.stiffness = stiffness;
    this.damping = damping;
  }
  update(dt) {
    _v0.copy(this.target).sub(this.value).multiplyScalar(this.stiffness);
    _v0.addScaledVector(this.vel, -this.damping);
    this.vel.addScaledVector(_v0, dt);
    this.value.addScaledVector(this.vel, dt);
    return this.value;
  }
  set(v) { this.value.copy(v); this.target.copy(v); this.vel.set(0, 0, 0); }
}

// ---------------------------------------------------------------------------
// Verlet chain — springy ragdoll physics for tails, ears, antennae, danglers.
// Anchored at points[0] (set anchor every frame), rest of the chain follows
// with gravity, damping, and a soft pull toward a rest direction (gives tails
// a "shape" they relax into instead of hanging limp).
// ---------------------------------------------------------------------------
export class VerletChain {
  constructor(count, segLen, opts = {}) {
    this.count = count;
    this.segLen = segLen;
    this.points = [];
    this.prev = [];
    for (let i = 0; i < count; i++) {
      this.points.push(new THREE.Vector3(0, i * -segLen, 0));
      this.prev.push(new THREE.Vector3(0, i * -segLen, 0));
    }
    this.gravity = opts.gravity ?? -14;
    this.damping = opts.damping ?? 0.94; // velocity kept per step
    this.stiffness = opts.stiffness ?? 0.0; // 0..1 pull toward rest pose
    // restDir is in the creature's local frame; caller supplies a function
    // that maps local rest offsets to world each frame.
    this.restDirs = [];
    for (let i = 1; i < count; i++) this.restDirs.push(new THREE.Vector3(0, -1, 0));
  }
  setRestDir(i, v) { if (i >= 1) this.restDirs[i - 1].copy(v).normalize(); }
  // anchor: world pos of root. restFrame: quaternion mapping local->world for rest dirs.
  update(dt, anchor, restQuat = null) {
    const pts = this.points, prev = this.prev;
    pts[0].copy(anchor);
    const dt2 = dt * dt;
    for (let i = 1; i < this.count; i++) {
      const p = pts[i];
      _v0.copy(p).sub(prev[i]).multiplyScalar(this.damping);
      prev[i].copy(p);
      p.add(_v0);
      p.y += this.gravity * dt2;
      if (this.stiffness > 0) {
        _v1.copy(this.restDirs[i - 1]);
        if (restQuat) _v1.applyQuaternion(restQuat);
        _v2.copy(pts[i - 1]).addScaledVector(_v1, this.segLen);
        p.lerp(_v2, 1 - Math.pow(1 - this.stiffness, dt * 60));
      }
    }
    // distance constraints (2 iterations is plenty for short chains)
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 1; i < this.count; i++) {
        _v0.copy(pts[i]).sub(pts[i - 1]);
        const d = _v0.length() || 1e-6;
        _v0.multiplyScalar((d - this.segLen) / d);
        if (i === 1) {
          pts[i].sub(_v0);
        } else {
          pts[i - 1].addScaledVector(_v0, 0.5);
          pts[i].addScaledVector(_v0, -0.5);
        }
      }
      // keep out of the ground
      for (let i = 1; i < this.count; i++) {
        if (pts[i].y < 0.06) pts[i].y = 0.06;
      }
    }
  }
  // Teleport the whole chain (e.g. on spawn) so it doesn't whip across the map
  reset(anchor) {
    for (let i = 0; i < this.count; i++) {
      this.points[i].set(anchor.x, Math.max(0.06, anchor.y - i * this.segLen * 0.5), anchor.z);
      this.prev[i].copy(this.points[i]);
    }
  }
}

// ---------------------------------------------------------------------------
// Analytic 2-bone IK. Given hip, target foot pos, bone lengths and a bend
// direction hint, writes the knee position into outKnee.
// ---------------------------------------------------------------------------
export function solveTwoBoneIK(hip, target, l1, l2, bendHint, outKnee) {
  _v0.copy(target).sub(hip);
  let d = _v0.length();
  const maxLen = (l1 + l2) * 0.999;
  if (d > maxLen) { d = maxLen; }
  if (d < 1e-5) { outKnee.copy(hip); outKnee.y -= l1; return; }
  _v0.normalize();
  // distance from hip to the knee's projection on the hip->target axis
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h2 = l1 * l1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  // bend axis: perpendicular component of bendHint relative to the leg axis
  _v1.copy(bendHint).addScaledVector(_v0, -bendHint.dot(_v0));
  if (_v1.lengthSq() < 1e-8) _v1.set(0, 0, 1);
  _v1.normalize();
  outKnee.copy(hip).addScaledVector(_v0, a).addScaledVector(_v1, h);
}

// ---------------------------------------------------------------------------
// Easing / waves
// ---------------------------------------------------------------------------
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeOutBack = (t, s = 1.7) => {
  const u = t - 1;
  return 1 + u * u * ((s + 1) * u + s);
};
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
// exponential smoothing factor that is frame-rate independent
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

// Move an angle toward a target along the shortest arc
export function dampAngle(current, target, rate, dt) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * damp(rate, dt);
}
