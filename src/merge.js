// MergeBlob: the squish moment. When two creatures collide hard, both are
// replaced by this transient goo — their body/head/eye blobs rendered in ONE
// SDF material so the two colors genuinely melt together via the smooth-min:
// the halves slam inward, orbit each other (color swirl), the blend k ramps
// up as they goo into a single wobbling ball, it inflates... and pops into
// the merged child.
import * as THREE from 'three';
import { createBlobMaterial } from './blob-material.js';
import { ENV } from './world.js';
import { clamp01, lerp, smoothstep } from './anim-helpers.js';

const GRAVITY = 22;
const WHITE = new THREE.Color('#fffdf5');
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class MergeBlob {
  constructor(scene, fx, a, b) {
    this.scene = scene;
    this.fx = fx;
    this.t = 0;
    this.duration = 1.3;

    const wA = Math.pow(a.dim.r0, 3);
    const wB = Math.pow(b.dim.r0, 3);
    const tB = wB / (wA + wB);
    this.pos = a.bodyCenter.clone().lerp(b.bodyCenter, tB);
    this.vel = a.vel.clone().multiplyScalar(1 - tB).addScaledVector(b.vel, tB);
    this.vel.multiplyScalar(0.35); // goo soaks up most of the momentum
    this.restR = Math.cbrt(Math.pow(a.dim.r0, 3) + Math.pow(b.dim.r0, 3)) * 1.15;
    this.spin = (Math.random() < 0.5 ? 1 : -1) * (8 + Math.random() * 4);
    this.ang = 0;
    this.scaleAvg = (a.s + b.s) * 0.5;

    const minSep = (a.dim.r0 + b.dim.r0) * 0.55; // keep the two-lobe peanut readable
    this.parents = [a, b].map((c) => {
      const dir = c.bodyCenter.clone().sub(this.pos);
      dir.y *= 0.4;
      const dist = Math.max(dir.length(), minSep);
      if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
      dir.normalize();
      return {
        dir, dist,
        bodyR: c.dim.r0 * 1.2,
        headR: Math.max(c.dim.headR, 0.12),
        headUp: c.dim.r0 * 0.8,
        eyeR: Math.max(c.g.eyes.r * c.s, 0.07),
        base: c.g.palette.base.clone(),
        belly: c.g.palette.belly.clone(),
      };
    });

    this.material = createBlobMaterial(ENV);
    this.material.uniforms.uPupil.value.set(0.9, 0.965);
    const R = this.restR + Math.max(this.parents[0].dist, this.parents[1].dist) + 0.7;
    const geo = new THREE.BoxGeometry(R * 2, R * 2, R * 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.material.uniforms.uBoxMin.value.set(-R, -R, -R);
    this.material.uniforms.uBoxMax.value.set(R, R, R);
    scene.add(this.mesh);
  }

  get finished() { return this.t >= this.duration; }

  update(dt, ctx) {
    this.t += dt;
    const t = this.t;

    // goo ballistics: falls softly, settles into a squashed rest on the ground
    this.vel.y -= GRAVITY * 0.55 * dt;
    this.pos.addScaledVector(this.vel, dt);
    const restY = this.restR * 0.8;
    if (this.pos.y < restY) {
      this.pos.y = restY;
      if (this.vel.y < -2) {
        this.fx.landDust(_v.copy(this.pos).setY(0.05), 0.9);
      }
      this.vel.y = 0;
      this.vel.x *= 0.9;
      this.vel.z *= 0.9;
    }

    // choreography phases:
    //   slam    (0.05-0.25): halves rush together into a tight goo peanut
    //   swirl   (0.25-0.70): the two lobes orbit — colors visibly mixing
    //   collapse(0.70-0.95): lobes fold into one ball at the combined volume
    //   inflate (1.0-1.27):  charge up... pop! the child bursts out
    this.ang += dt * this.spin * Math.exp(-t * 1.2);
    const slam = smoothstep(0.05, 0.25, t);
    const collapse = smoothstep(0.7, 0.95, t);
    const jiggle = 1 + 0.05 * Math.sin(t * 24) * Math.exp(-t * 4);
    const wob = 1 + 0.14 * Math.sin(t * 26) * Math.exp(-t * 2.2);
    const inflate = 1 + smoothstep(1.0, 1.27, t) * 0.2;
    const k = lerp(0.14, 0.5, smoothstep(0.05, 0.45, t)) * this.scaleAvg;

    const u = this.material.uniforms;
    const A = u.uPrimA.value, B = u.uPrimB.value, C = u.uPrimC.value;
    let n = 0;
    const push = (x, y, z, r, col, matId, kk) => {
      const i = n * 4;
      A[i] = x; A[i + 1] = y; A[i + 2] = z; A[i + 3] = r;
      B[i] = x; B[i + 1] = y + 1e-3; B[i + 2] = z; B[i + 3] = r;
      C[i] = col.r; C[i + 1] = col.g; C[i + 2] = col.b;
      C[i + 3] = matId + Math.min(kk, 0.95) * 0.99;
      n++;
    };

    // dizzy googly eyes always face the viewer
    const cd = _v.copy(ctx.camera.position).sub(this.pos).normalize();
    _v2.set(-cd.z, 0, cd.x).normalize(); // camera-right on the ground plane

    const ca = Math.cos(this.ang), sa = Math.sin(this.ang);
    for (let i = 0; i < 2; i++) {
      const p = this.parents[i];
      const dx = p.dir.x * ca + p.dir.z * sa;
      const dz = -p.dir.x * sa + p.dir.z * ca;
      // lobe offset: impact distance -> readable peanut (0.8 r) -> zero
      const lobeOff = lerp(p.dist, p.bodyR * 0.8, slam) * (1 - collapse) * jiggle;
      const bx = dx * lobeOff, by = p.dir.y * lobeOff, bz = dz * lobeOff;
      const bodyR = lerp(p.bodyR, this.restR * 0.95, collapse) * wob * inflate;
      push(bx, by, bz, bodyR, p.base, 0, k);
      // belly tint toward the camera for richer swirl colors
      push(bx + cd.x * bodyR * 0.4, by + cd.y * bodyR * 0.4, bz + cd.z * bodyR * 0.4,
        bodyR * 0.6, p.belly, 0, k * 0.8);
      // googly eyes poke out of the goo surface, tracking the camera — two
      // dizzy pairs orbiting each other as the lobes swirl
      for (const side of [-1, 1]) {
        _v3.set(cd.x + _v2.x * side * 0.5, cd.y + 0.28, cd.z + _v2.z * side * 0.5).normalize();
        push(
          bx + _v3.x * bodyR * 1.04, by + _v3.y * bodyR * 1.04, bz + _v3.z * bodyR * 1.04,
          p.eyeR * (1 - collapse * 0.4), WHITE, 2, 0.025);
      }
    }

    u.uPrimCount.value = n;
    this.mesh.position.copy(this.pos);
    this.mesh.updateMatrixWorld();
    u.uCamLocal.value.copy(ctx.camera.position).sub(this.pos);
    u.uLightLocal.value.copy(ENV.lightDir);
    u.uEyeLook.value.copy(cd);
    _m.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    u.uMVP.value.multiplyMatrices(_m, this.mesh.matrixWorld);
  }

  addShadows(pool) {
    pool.add(this.pos.x, this.pos.z, this.restR * 1.35,
      Math.max(0, this.pos.y - this.restR * 0.8), 1.15);
  }

  // celebration burst in both parents' colors when the child pops out
  burst() {
    for (const p of this.parents) {
      this.fx.pop(this.pos, { base: p.base, belly: p.belly });
    }
    this.fx.rings.spawn(this.pos.x, this.pos.z, this.restR * 2.2, this.parents[0].base, 0.6);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
