// Juice particles: one pooled Points system for soft round puffs (dust,
// confetti pops), one for hearts, plus pooled expanding ground rings.
import * as THREE from 'three';

function makeCircleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function makeStarTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.translate(32, 32);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = i % 2 === 0 ? 26 : 9;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  return new THREE.CanvasTexture(c);
}

function makeHeartTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.translate(32, 34);
  ctx.scale(1.15, 1.15);
  ctx.beginPath();
  ctx.moveTo(0, 8);
  ctx.bezierCurveTo(-22, -8, -12, -24, 0, -12);
  ctx.bezierCurveTo(12, -24, 22, -8, 0, 8);
  ctx.closePath();
  ctx.fillStyle = '#ff6b9d';
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = '#35284b';
  ctx.stroke();
  return new THREE.CanvasTexture(c);
}

class ParticlePool {
  constructor(scene, count, texture, blending = THREE.NormalBlending) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);     // remaining
    this.maxLife = new Float32Array(count);
    this.size = new Float32Array(count);
    this.color = new Float32Array(count * 3);
    this.alpha = new Float32Array(count);
    this.gravity = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      uniforms: { uMap: { value: texture } },
      vertexShader: /* glsl */`
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
          if (gl_FragColor.a < 0.01) discard;
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    // park everything
    for (let i = 0; i < count; i++) { this.pos[i * 3 + 1] = -50; }
  }

  spawn(p, v, life, size, color, gravity = 0, drag = 2) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size;
    this.color[i * 3] = color.r; this.color[i * 3 + 1] = color.g; this.color[i * 3 + 2] = color.b;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -50; this.alpha[i] = 0; continue; }
      const t = this.life[i] / this.maxLife[i];
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d + this.gravity[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.03 && this.gravity[i] < 0) {
        this.pos[i * 3 + 1] = 0.03;
        this.vel[i * 3 + 1] *= -0.3;
      }
      this.alpha[i] = t < 0.7 ? t / 0.7 : 1;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}

// Pooled expanding rings for ground impacts / taps.
class RingPool {
  constructor(scene, count = 8) {
    this.rings = [];
    const geo = new THREE.RingGeometry(0.85, 1.0, 40);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = -10;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.rings.push({ mesh, life: 0, maxLife: 1, maxR: 1, color: new THREE.Color() });
    }
    this.cursor = 0;
  }
  spawn(x, z, maxR = 1, color = null, life = 0.5) {
    const r = this.rings[this.cursor];
    this.cursor = (this.cursor + 1) % this.rings.length;
    r.mesh.position.set(x, 0.02, z);
    r.life = life; r.maxLife = life; r.maxR = maxR;
    r.mesh.material.color.copy(color || new THREE.Color('#ffffff'));
  }
  update(dt) {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.position.y = -10; r.mesh.material.opacity = 0; continue; }
      const t = 1 - r.life / r.maxLife;
      const e = 1 - Math.pow(1 - t, 3);
      const s = 0.15 + e * r.maxR;
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.opacity = (1 - t) * 0.5;
    }
  }
}

const _c = new THREE.Color();
const _v = new THREE.Vector3();

export class FX {
  constructor(scene) {
    this.puffs = new ParticlePool(scene, 320, makeCircleTexture());
    this.hearts = new ParticlePool(scene, 40, makeHeartTexture());
    this.stars = new ParticlePool(scene, 120, makeStarTexture(), THREE.AdditiveBlending);
    this.rings = new RingPool(scene, 12);
  }

  update(dt) {
    this.puffs.update(dt);
    this.hearts.update(dt);
    this.stars.update(dt);
    this.rings.update(dt);
  }

  // Evolution ceremony: a proper celebration. Scales up for rarer children.
  celebrate(p, colors, tier = 'N') {
    const boost = { N: 1, R: 1.25, SR: 1.6, SSR: 2.2 }[tier] || 1;
    // white flash core
    _v.set(0, 0.5, 0);
    _c.set('#ffffff');
    this.stars.spawn(p, _v, 0.28, 2.4 * boost, _c, 0, 8);
    // confetti fountain in everyone's colors
    const n = Math.round(34 * boost);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const el = Math.random() * Math.PI * 0.45;
      const sp = (2.2 + Math.random() * 3.4) * boost;
      _v.set(
        Math.cos(a) * Math.cos(el) * sp,
        Math.sin(el) * sp * 1.6 + 1.5,
        Math.sin(a) * Math.cos(el) * sp);
      this.puffs.spawn(p, _v, 0.8 + Math.random() * 0.7,
        0.08 + Math.random() * 0.09, colors[i % colors.length], -6, 1.4);
    }
    // star shower — gold-tinted for SSR
    const stars = Math.round(14 * boost);
    for (let i = 0; i < stars; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.4 + Math.random() * 2.6;
      _v.set(Math.cos(a) * sp, 2.4 + Math.random() * 3 * boost, Math.sin(a) * sp);
      _c.set(tier === 'SSR' ? '#ffd76a' : '#fff6d8');
      this.stars.spawn(p, _v, 0.9 + Math.random() * 0.6,
        0.16 + Math.random() * 0.14 * boost, _c, -5, 1.2);
    }
    // triple shockwave
    this.rings.spawn(p.x, p.z, 1.4 * boost, colors[0], 0.5);
    this.rings.spawn(p.x, p.z, 2.2 * boost, new THREE.Color('#ffffff'), 0.7);
    if (tier === 'SR' || tier === 'SSR') {
      this.rings.spawn(p.x, p.z, 3.2 * boost, _c.set('#ffd76a').clone(), 0.9);
    }
  }

  // little dust kick at a foot fall
  footDust(p, strength = 1) {
    const n = Math.round(2 * strength);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      _v.set(Math.cos(a) * 0.5, 0.6 + Math.random() * 0.6, Math.sin(a) * 0.5)
        .multiplyScalar(0.5 * strength);
      _c.setHSL(0.11, 0.35, 0.82 + Math.random() * 0.1);
      this.puffs.spawn(p, _v, 0.4 + Math.random() * 0.25,
        0.09 + Math.random() * 0.08 * strength, _c, -0.6, 2.5);
    }
  }

  // big landing splash
  landDust(p, strength = 1) {
    const n = Math.round(8 + 8 * strength);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const sp = (0.8 + Math.random() * 1.2) * strength;
      _v.set(Math.cos(a) * sp, 0.5 + Math.random() * 1.2 * strength, Math.sin(a) * sp);
      _c.setHSL(0.11, 0.3, 0.85 + Math.random() * 0.1);
      this.puffs.spawn(p, _v, 0.5 + Math.random() * 0.35,
        0.12 + Math.random() * 0.12, _c, -2.2, 3);
    }
    this.rings.spawn(p.x, p.z, 0.6 + strength * 0.5, _c.setHSL(0.1, 0.4, 0.9), 0.45);
  }

  // spawn-pop confetti in the creature's palette
  confetti(p, palette) {
    const cols = [palette.base, palette.accent, palette.belly];
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const el = Math.random() * Math.PI * 0.5;
      const sp = 1.6 + Math.random() * 2.4;
      _v.set(
        Math.cos(a) * Math.cos(el) * sp,
        Math.sin(el) * sp * 1.4,
        Math.sin(a) * Math.cos(el) * sp);
      this.puffs.spawn(p, _v, 0.7 + Math.random() * 0.5,
        0.07 + Math.random() * 0.07, cols[i % 3], -5, 1.6);
    }
    this.rings.spawn(p.x, p.z, 1.1, palette.accent, 0.55);
  }

  pop(p, palette) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      _v.set(Math.cos(a) * 2, 1 + Math.random() * 2, Math.sin(a) * 2);
      this.puffs.spawn(p, _v, 0.5, 0.1, i % 2 ? palette.base : palette.belly, -4, 2.5);
    }
  }

  heartsBurst(p) {
    for (let i = 0; i < 4; i++) {
      _v.set((Math.random() - 0.5) * 0.8, 1.2 + Math.random() * 0.8, (Math.random() - 0.5) * 0.8);
      _c.set(1, 1, 1);
      this.hearts.spawn(
        new THREE.Vector3(p.x + (Math.random() - 0.5) * 0.4, p.y + 0.2, p.z + (Math.random() - 0.5) * 0.4),
        _v, 0.9 + Math.random() * 0.4, 0.3 + Math.random() * 0.12, _c, 1.2, 1.4);
    }
  }

  tapRipple(x, z) {
    this.rings.spawn(x, z, 0.9, new THREE.Color('#ffffff'), 0.5);
  }

  // a stage prop got eaten: chunks fly in its colors
  gulpBits(p, kind) {
    const palettes = {
      rock: ['#b9aed6', '#cfc5e6'],
      bush: ['#8ec977', '#a5d68b'],
      tree: ['#7cbf6b', '#a98268', '#98d07f'],
      bigtree: ['#6bb268', '#9a7460', '#a0d488'],
    };
    const cols = palettes[kind] || palettes.bush;
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 2;
      _v.set(Math.cos(a) * sp, 1 + Math.random() * 2.2, Math.sin(a) * sp);
      _c.set(cols[i % cols.length]);
      this.puffs.spawn(p, _v, 0.5 + Math.random() * 0.4,
        0.09 + Math.random() * 0.09, _c, -6, 2);
    }
    this.rings.spawn(p.x, p.z, 1, _c.set(cols[0]).clone(), 0.45);
  }
}
