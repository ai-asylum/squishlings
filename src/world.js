// The stage: gradient sky dome, toon meadow ground with halftone speckles,
// swaying grass, squishy-matching toon rocks, drifting pollen, and a pooled
// blob-shadow system (the classic mobile trick — soft radial quads).
import * as THREE from 'three';
import { RNG } from './rng.js';

// One palette object shared by everything so the scene reads as one system.
export const ENV = {
  skyTop: new THREE.Color('#7fb5ee'),
  skyMid: new THREE.Color('#c5e3f7'),
  skyHorizon: new THREE.Color('#ffe9cf'),
  ground: new THREE.Color('#d8ecba'),
  groundFar: new THREE.Color('#ffe9cf'),
  speckle: new THREE.Color('#bcdc9c'),
  grass: new THREE.Color('#a8d68a'),
  grassTip: new THREE.Color('#d4eeb2'),
  rock: new THREE.Color('#b9aed6'),
  ink: new THREE.Color('#35284b'),
  fogColor: new THREE.Color('#ffe9cf'),
  fogNear: 14,
  fogFar: 30,
  // shared live fog range: every material references THIS vector, so stage
  // growth can widen the world's fog by mutating it
  fogRange: new THREE.Vector2(14, 30),
  lightDir: new THREE.Vector3(0.45, 0.75, 0.35).normalize(), // TO the sun
  arenaRadius: 7,
};

// ---------------------------------------------------------------------------
export function buildSky(scene) {
  const geo = new THREE.SphereGeometry(60, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: ENV.skyTop },
      uMid: { value: ENV.skyMid },
      uHorizon: { value: ENV.skyHorizon },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, -0.1, 1.0);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, h));
        col = mix(col, uTop, smoothstep(0.22, 0.85, h));
        // big soft sun glow
        vec3 sun = normalize(vec3(0.45, 0.55, 0.35));
        float g = pow(clamp(dot(vDir, sun), 0.0, 1.0), 5.0);
        col += vec3(1.0, 0.9, 0.7) * g * 0.22;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  scene.add(sky);
  return sky;
}

// ---------------------------------------------------------------------------
export function buildGround(scene) {
  const geo = new THREE.CircleGeometry(40, 48);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uGround: { value: ENV.ground },
      uFar: { value: ENV.groundFar },
      uSpeckle: { value: ENV.speckle },
      uFogRange: { value: ENV.fogRange },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying float vViewZ;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vec4 mv = viewMatrix * w;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uGround; uniform vec3 uFar; uniform vec3 uSpeckle;
      uniform vec2 uFogRange;
      varying vec3 vWorld;
      varying float vViewZ;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      void main() {
        float r = length(vWorld.xz);
        // soft radial ramp: fresh center fading to warm horizon
        vec3 col = mix(uGround, uFar, smoothstep(4.0, 26.0, r));
        // halftone speckle dots, jittered grid
        vec2 cell = floor(vWorld.xz * 1.6);
        vec2 uv = fract(vWorld.xz * 1.6) - 0.5;
        float h = hash(cell);
        vec2 jitter = vec2(hash(cell + 7.0), hash(cell + 13.0)) - 0.5;
        float d = length(uv - jitter * 0.55);
        float dot1 = smoothstep(0.14 * h + 0.03, 0.02, d) * step(0.35, h);
        col = mix(col, uSpeckle, dot1 * 0.55 * (1.0 - smoothstep(6.0, 18.0, r)));
        // subtle vignette ring around the arena
        col *= 1.0 - 0.05 * smoothstep(5.5, 8.5, r) * (1.0 - smoothstep(9.0, 14.0, r));
        float fog = smoothstep(uFogRange.x, uFogRange.y, vViewZ);
        col = mix(col, uFar, fog * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const ground = new THREE.Mesh(geo, mat);
  scene.add(ground);
  return ground;
}

// ---------------------------------------------------------------------------
// Toon shader for props (rocks) — same ramp + ink rim as the creatures so
// everything reads as one illustration.
function makePropMaterial(baseColor) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: baseColor },
      uLight: { value: ENV.lightDir },
      uInk: { value: ENV.ink },
      uFogColor: { value: ENV.fogColor },
      uFogRange: { value: ENV.fogRange },
    },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying float vViewZ;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vV = normalize(cameraPosition - w.xyz);
        vec4 mv = viewMatrix * w;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform vec3 uLight; uniform vec3 uInk;
      uniform vec3 uFogColor; uniform vec2 uFogRange;
      varying vec3 vN; varying vec3 vV; varying float vViewZ;
      void main() {
        vec3 n = normalize(vN);
        float ndl = dot(n, uLight);
        float ndv = clamp(dot(n, normalize(vV)), 0.0, 1.0);
        vec3 col = mix(uColor * vec3(0.6, 0.55, 0.8), uColor, smoothstep(-0.1, 0.05, ndl));
        col = mix(col, uColor * 1.07 + 0.04, smoothstep(0.5, 0.6, ndl) * 0.5);
        float ink = smoothstep(0.34, 0.18, ndv);
        col = mix(col, uInk, ink * 0.85);
        col = mix(col, uFogColor, smoothstep(uFogRange.x, uFogRange.y, vViewZ) * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

export function buildRocks(scene) {
  ringSpawn(scene, 'rock', 7, 5.2, 7.5, false);
}

// ---------------------------------------------------------------------------
// Stage-growth props: as squishlings grow katamari-style, bigger set dressing
// pops in — bushes, trees, a forest ring, and finally mountains on the
// horizon. Every prop (except mountains) is registered as GULPABLE: a big
// enough squishling thrown at it eats it and grows a little.
export const propAnims = [];
export const props = []; // {obj, kind, x, z, r, h, vol, alive}

export function updatePropAnims(dt) {
  for (let i = propAnims.length - 1; i >= 0; i--) {
    const a = propAnims[i];
    a.t += dt;
    if (a.mode === 'out') {
      const t = a.t / 0.3;
      if (t >= 1) {
        a.obj.parent?.remove(a.obj);
        a.obj.traverse((o) => o.geometry?.dispose());
        propAnims.splice(i, 1);
        continue;
      }
      a.obj.scale.setScalar(Math.max(0.001, a.from * (1 - t * t)));
      continue;
    }
    const t = Math.max(0, (a.t - a.delay) / 0.65);
    if (t <= 0) { a.obj.scale.setScalar(0.001); continue; }
    if (t >= 1) {
      a.obj.scale.setScalar(a.final);
      propAnims.splice(i, 1);
      continue;
    }
    const u = t - 1;
    const back = 1 + u * u * (3.2 * u + 2.2); // easeOutBack, extra bouncy
    a.obj.scale.setScalar(Math.max(0.001, a.final * back));
  }
}

function popIn(obj, delay, final = 1) {
  obj.scale.setScalar(0.001);
  propAnims.push({ obj, t: 0, delay, final });
}

const rand = (a, b) => a + Math.random() * (b - a);
const propMats = {};
function propMat(key, color) {
  if (!propMats[key]) propMats[key] = makePropMaterial(new THREE.Color(color));
  return propMats[key];
}

function blobMesh(mat, r, x, y, z, sy = 1) {
  const geo = new THREE.SphereGeometry(r, 12, 9);
  geo.scale(1, sy, 1);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

function makeRockObj() {
  const s = rand(0.25, 0.7);
  const geo = new THREE.IcosahedronGeometry(s, 1);
  const pos = geo.attributes.position;
  for (let v = 0; v < pos.count; v++) {
    pos.setXYZ(v, pos.getX(v) * rand(0.96, 1.04), pos.getY(v) * 0.62, pos.getZ(v) * rand(0.96, 1.04));
  }
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, propMat('rock', '#b9aed6'));
  rock.position.y = s * 0.28;
  const group = new THREE.Group();
  group.add(rock);
  return { obj: group, r: s * 1.3, h: s * 0.7, s };
}

function makeBushObj() {
  const s = rand(0.7, 1.3);
  const bush = new THREE.Group();
  const mat = propMat(Math.random() < 0.5 ? 'bushA' : 'bushB',
    Math.random() < 0.5 ? '#8ec977' : '#a5d68b');
  bush.add(blobMesh(mat, 0.5 * s, 0, 0.3 * s, 0, 0.8));
  bush.add(blobMesh(mat, 0.36 * s, 0.4 * s, 0.26 * s, 0.1 * s, 0.8));
  bush.add(blobMesh(mat, 0.3 * s, -0.38 * s, 0.24 * s, -0.05 * s, 0.8));
  return { obj: bush, r: s * 0.95, h: s * 0.75, s };
}

function makeTreeObj(s, trunkKey, trunkCol, leafKey, leafCol) {
  const tree = new THREE.Group();
  const trunkMat = propMat(trunkKey, trunkCol);
  const leafMat = propMat(leafKey, leafCol);
  const trunkH = rand(0.9, 1.4) * s;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.14 * s, trunkH, 7), trunkMat);
  trunk.position.y = trunkH / 2;
  tree.add(trunk);
  const canopyY = trunkH + 0.35 * s;
  tree.add(blobMesh(leafMat, 0.55 * s, 0, canopyY, 0, 0.9));
  tree.add(blobMesh(leafMat, 0.4 * s, 0.32 * s, canopyY + 0.22 * s, 0.08 * s, 0.9));
  tree.add(blobMesh(leafMat, 0.34 * s, -0.3 * s, canopyY + 0.18 * s, -0.1 * s, 0.9));
  tree.add(blobMesh(leafMat, 0.3 * s, 0, canopyY + 0.42 * s, 0, 0.9));
  return { obj: tree, r: s * 0.8, h: trunkH + s * 0.9, s };
}

// kind -> {vol (creature-scale³ units), builder}
const PROP_KINDS = {
  rock: { vol: 0.3, make: makeRockObj },
  bush: { vol: 1.5, make: makeBushObj },
  tree: {
    vol: 7,
    make: () => makeTreeObj(rand(1.4, 2.2), 'trunkA', '#a98268',
      Math.random() < 0.5 ? 'leafA' : 'leafB', Math.random() < 0.5 ? '#7cbf6b' : '#98d07f'),
  },
  bigtree: {
    vol: 15,
    make: () => makeTreeObj(rand(2.2, 3.6), 'trunkB', '#9a7460',
      Math.random() < 0.5 ? 'leafC' : 'leafD', Math.random() < 0.5 ? '#6bb268' : '#a0d488'),
  },
};

export function spawnProp(scene, kind, x, z, animate = true, delay = 0) {
  const def = PROP_KINDS[kind];
  const { obj, r, h } = def.make();
  obj.position.x = x;
  obj.position.z = z;
  obj.rotation.y = rand(0, Math.PI * 2);
  scene.add(obj);
  const entry = { obj, kind, x, z, r, h, vol: def.vol, alive: true };
  props.push(entry);
  if (animate) popIn(obj, delay);
  return entry;
}

// gulped: shrink out and forget
export function removeProp(entry) {
  entry.alive = false;
  const i = props.indexOf(entry);
  if (i >= 0) props.splice(i, 1);
  propAnims.push({ obj: entry.obj, t: 0, mode: 'out', from: entry.obj.scale.x });
}

function ringSpawn(scene, kind, count, rMin, rMax, animate) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand(-0.35, 0.35);
    const r = rand(rMin, rMax);
    spawnProp(scene, kind, Math.cos(a) * r, Math.sin(a) * r, animate, i * 0.09);
  }
}

export function buildBushes(scene, animate = true) { ringSpawn(scene, 'bush', 8, 6.5, 9.5, animate); }
export function buildTrees(scene, animate = true) { ringSpawn(scene, 'tree', 7, 9, 12.5, animate); }
export function buildForest(scene, animate = true) { ringSpawn(scene, 'bigtree', 14, 12, 17, animate); }

export function buildMountains(scene, animate = true) {
  const rng = new RNG(777004);
  const group = new THREE.Group();
  const rockMat = makePropMaterial(new THREE.Color('#9d90c9'));
  const snowMat = makePropMaterial(new THREE.Color('#fdf8f0'));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rng.float(-0.4, 0.4);
    const r = rng.float(24, 32);
    const h = rng.float(9, 16);
    const w = h * rng.float(0.55, 0.75);
    const mtn = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(w, h, 6, 1), rockMat);
    body.position.y = h / 2;
    body.rotation.y = rng.float(0, Math.PI);
    mtn.add(body);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(w * 0.34, h * 0.32, 6, 1), snowMat);
    cap.position.y = h - h * 0.155;
    cap.rotation.y = body.rotation.y;
    mtn.add(cap);
    mtn.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    group.add(mtn);
    if (animate) popIn(mtn, i * 0.12);
  }
  scene.add(group);
  return group;
}

// ---------------------------------------------------------------------------
// Instanced grass blades with a vertex-shader wind sway.
export function buildGrass(scene) {
  const rng = new RNG(24680);
  const COUNT = 130;
  const geo = new THREE.ConeGeometry(0.045, 0.34, 4, 1, true);
  geo.translate(0, 0.17, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBase: { value: ENV.grass },
      uTip: { value: ENV.grassTip },
      uFogColor: { value: ENV.fogColor },
      uFogRange: { value: ENV.fogRange },
    },
    vertexShader: /* glsl */`
      uniform float uTime;
      varying float vH; varying float vViewZ;
      void main() {
        vH = clamp(position.y / 0.34, 0.0, 1.0);
        vec4 w = instanceMatrix * vec4(position, 1.0);
        w = modelMatrix * w;
        // sway grows with height, phase varies by world position
        float ph = w.x * 1.7 + w.z * 2.3;
        w.x += sin(uTime * 1.8 + ph) * 0.05 * vH * vH;
        w.z += cos(uTime * 1.3 + ph * 1.3) * 0.035 * vH * vH;
        vec4 mv = viewMatrix * w;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uBase; uniform vec3 uTip;
      uniform vec3 uFogColor; uniform vec2 uFogRange;
      varying float vH; varying float vViewZ;
      void main() {
        vec3 col = mix(uBase, uTip, vH * vH);
        col = mix(col, uFogColor, smoothstep(uFogRange.x, uFogRange.y, vViewZ) * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
  const grass = new THREE.InstancedMesh(geo, mat, COUNT);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < COUNT; i++) {
    const a = rng.float(0, Math.PI * 2);
    const r = Math.sqrt(rng.float(0.04, 1)) * 8.2;
    const s = rng.float(0.7, 1.5);
    e.set(rng.float(-0.15, 0.15), rng.float(0, Math.PI * 2), rng.float(-0.15, 0.15));
    q.setFromEuler(e);
    m.compose(
      new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
      q,
      new THREE.Vector3(s, s, s));
    grass.setMatrixAt(i, m);
  }
  grass.instanceMatrix.needsUpdate = true;
  scene.add(grass);
  return grass;
}

// ---------------------------------------------------------------------------
// Blob shadows: pooled soft radial-gradient quads, faded/shrunk with height.
let shadowTexture = null;
function getShadowTexture() {
  if (shadowTexture) return shadowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(53, 40, 75, 0.42)');
  grad.addColorStop(0.65, 'rgba(53, 40, 75, 0.28)');
  grad.addColorStop(1, 'rgba(53, 40, 75, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  shadowTexture = new THREE.CanvasTexture(c);
  return shadowTexture;
}

export class ShadowPool {
  constructor(scene, count = 48) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: getShadowTexture(),
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.count = count;
    this.cursor = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    scene.add(this.mesh);
  }
  begin() { this.cursor = 0; }
  // radius: ground footprint. height: how far the caster is above the ground.
  add(x, z, radius, height = 0, squash = 1) {
    if (this.cursor >= this.count) return;
    const fade = Math.max(0, 1 - height * 0.32);
    const s = radius * 2 * (1 + height * 0.18) * squash * fade;
    if (s <= 0.001) { return; }
    this._m.compose(
      new THREE.Vector3(x, 0.012 + this.cursor * 0.0004, z),
      this._q,
      new THREE.Vector3(s, 1, s * (0.9 + 0.1 * squash)));
    this.mesh.setMatrixAt(this.cursor, this._m);
    this.cursor++;
  }
  end() {
    // park unused instances underground
    for (let i = this.cursor; i < this.count; i++) {
      this._m.makeTranslation(0, -10, 0);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Drifting pollen motes for ambience.
export function buildMotes(scene) {
  const COUNT = 70;
  const rng = new RNG(99999);
  const pos = new Float32Array(COUNT * 3);
  const seedAttr = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    pos[i * 3] = rng.float(-9, 9);
    pos[i * 3 + 1] = rng.float(0.3, 4.2);
    pos[i * 3 + 2] = rng.float(-9, 9);
    seedAttr[i] = rng.float(0, 100);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seedAttr, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime;
      varying float vTw;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.22 + aSeed) * 0.7;
        p.y += sin(uTime * 0.35 + aSeed * 2.0) * 0.4;
        p.z += cos(uTime * 0.18 + aSeed * 1.3) * 0.7;
        vTw = 0.5 + 0.5 * sin(uTime * 1.4 + aSeed * 3.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (2.5 + vTw * 2.0) * (280.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vTw;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.12, d) * (0.10 + vTw * 0.16);
        gl_FragColor = vec4(1.0, 0.98, 0.9, a);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  return pts;
}
