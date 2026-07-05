// The seamless-body trick: each creature renders as ONE draw call — a bounding
// box whose fragment shader raymarches a signed distance field built from
// up to 32 "round cone" primitives (tapered capsules; a sphere is the
// degenerate case). Primitives are unioned with a smooth-min that also blends
// color and material id, so separate limbs/blobs read as one continuous
// squishy body with smooth color gradients — no geometry seams, ever.
//
// Toon shading, googly-eye pupils, crease AO and ink outlines are computed
// in the same pass from the SDF, and gl_FragDepth is written so creatures
// depth-sort correctly against the world and each other.
import * as THREE from 'three';

export const MAX_PRIMS = 48;

const vertexShader = /* glsl */`
out vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */`
precision highp float;

#define MAX_PRIMS ${MAX_PRIMS}
#define MAX_STEPS 72

uniform vec4 uPrimA[MAX_PRIMS];   // xyz: point A (local), w: radius A
uniform vec4 uPrimB[MAX_PRIMS];   // xyz: point B (local), w: radius B
uniform vec4 uPrimC[MAX_PRIMS];   // rgb: color, w: matId + blendK (k<1)
uniform int  uPrimCount;
uniform vec3 uCamLocal;           // camera position in creature-local space
uniform vec3 uLightLocal;         // dir TO light, creature-local space
uniform vec3 uEyeLook;            // local dir pupils aim at
uniform vec2 uPupil;              // x: pupil cos cutoff, y: sparkle cutoff
uniform mat4 uMVP;                // proj * view * model, for depth + fog
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uInkColor;
uniform vec3 uFogColor;
uniform vec2 uFogRange;           // near, far (view distance)

in vec3 vPos;
out vec4 fragColor;

float dot2(vec3 v) { return dot(v, v); }

// Round cone (tapered capsule) SDF in a numerically stable form: reduce to
// 2D (radial, axial) coordinates first. The textbook closed form cancels
// catastrophically near the axis and paints ring noise across the body.
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a;
  float l2 = dot(ba, ba);
  if (l2 < 4.0e-4) return length(p - mix(a, b, 0.5)) - max(r1, r2);
  float l = sqrt(l2);
  float rr = r1 - r2;
  vec3 pa = p - a;
  if (abs(rr) >= l) { // one cap swallows the other
    return rr >= 0.0 ? length(pa) - r1 : length(p - b) - r2;
  }
  vec3 axis = ba / l;
  float y = dot(pa, axis);
  float x = length(pa - axis * y); // radial distance — no cancellation
  float s = rr / l;                // taper sine
  float c = sqrt(1.0 - s * s);
  float k = -s * x + c * y;        // position along the tangent wall
  if (k < 0.0) return length(vec2(x, y)) - r1;
  if (k > c * l) return length(vec2(x, y - l)) - r2;
  return c * x + s * y - r1;
}

// Distance-only field (used for marching + normals). Sequential smooth-min.
float map(vec3 p) {
  float d = 1e5;
  for (int i = 0; i < MAX_PRIMS; i++) {
    if (i >= uPrimCount) break;
    float di = sdRoundCone(p, uPrimA[i].xyz, uPrimB[i].xyz, uPrimA[i].w, uPrimB[i].w);
    float k = max(fract(uPrimC[i].w) * 1.0101, 1e-3); // decode blend k
    float h = clamp(0.5 + 0.5 * (d - di) / k, 0.0, 1.0);
    d = mix(d, di, h) - k * h * (1.0 - h);
  }
  return d;
}

// Full field: also blends color rgb and material id along the union.
float mapColor(vec3 p, out vec3 col, out float mat) {
  float d = 1e5;
  col = vec3(0.0);
  mat = 0.0;
  for (int i = 0; i < MAX_PRIMS; i++) {
    if (i >= uPrimCount) break;
    float di = sdRoundCone(p, uPrimA[i].xyz, uPrimB[i].xyz, uPrimA[i].w, uPrimB[i].w);
    float w = uPrimC[i].w;
    float mi = floor(w);
    float k = max(fract(w) * 1.0101, 1e-3);
    float h = clamp(0.5 + 0.5 * (d - di) / k, 0.0, 1.0);
    d = mix(d, di, h) - k * h * (1.0 - h);
    col = mix(col, uPrimC[i].rgb, h);
    mat = mix(mat, mi, h);
  }
  return d;
}

vec3 calcNormal(vec3 p) {
  // generous epsilon: blobs are smooth by construction, and a wide stencil
  // low-passes float noise that toon bands would otherwise amplify
  const vec2 e = vec2(0.012, -0.012);
  return normalize(
    e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) +
    e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

// slab test: returns (tEnter, tExit) of ray vs local AABB
vec2 boxIntersect(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv;
  vec3 t1 = (uBoxMax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

void main() {
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vPos - ro);
  vec2 tb = boxIntersect(ro, rd);
  float t = max(tb.x, 0.0);
  float tEnd = tb.y;

  float d;
  bool hit = false;
  vec3 p;
  for (int i = 0; i < MAX_STEPS; i++) {
    p = ro + rd * t;
    d = map(p);
    if (d < 0.0009 + 0.0005 * t) { hit = true; break; }
    t += d;
    if (t > tEnd) break;
  }
  if (!hit) discard;
  // Newton refinement: tighten the hit so normals & bands stay clean
  for (int i = 0; i < 3; i++) {
    t += map(ro + rd * t);
    p = ro + rd * t;
  }

  vec3 albedo;
  float matv;
  mapColor(p, albedo, matv);
  vec3 n = calcNormal(p);
  vec3 v = -rd;
  vec3 L = uLightLocal;

  float ndl = dot(n, L);
  float ndv = clamp(dot(n, v), 0.0, 1.0);

  vec3 col;
  if (matv > 1.5) {
    // ---- eye: flat white sclera + googly pupil aimed at uEyeLook ----------
    col = albedo;
    vec3 e = uEyeLook;
    float pd = dot(n, e);
    float pupil = smoothstep(uPupil.x - 0.02, uPupil.x + 0.02, pd);
    col = mix(col, uInkColor * 0.9, pupil);
    // sparkle: offset up-left of the pupil
    vec3 rgt = normalize(cross(vec3(0.0, 1.0, 0.0), e));
    vec3 hd = normalize(e + vec3(0.0, 0.38, 0.0) - rgt * 0.30);
    float sparkle = smoothstep(uPupil.y - 0.015, uPupil.y + 0.015, dot(n, hd));
    col = mix(col, vec3(1.0), sparkle * pupil);
  } else if (matv > 0.5) {
    // ---- flat accent (blush, nose): unlit pastel with a whisper of shade --
    col = albedo * (0.94 + 0.09 * clamp(ndl, 0.0, 1.0));
  } else {
    // ---- toon body ---------------------------------------------------------
    // crease AO from the SDF itself: darkens where blobs meet
    float aoRaw = clamp(map(p + n * 0.12) / 0.12, 0.0, 1.0) * 0.5
                + clamp(map(p + n * 0.26) / 0.26, 0.0, 1.0) * 0.5;
    float ao = mix(0.62, 1.0, smoothstep(0.3, 0.9, aoRaw));

    vec3 shadowCol = albedo * vec3(0.58, 0.52, 0.82); // cool plum shadow
    float band = smoothstep(-0.14, 0.06, ndl);
    float band2 = smoothstep(0.45, 0.62, ndl);
    col = mix(shadowCol, albedo, band);
    col = mix(col, albedo * 1.06 + 0.05, band2 * 0.55);
    col *= mix(vec3(0.68, 0.64, 0.87), vec3(1.0), ao);

    // soft jelly specular
    vec3 hv = normalize(L + v);
    col += vec3(0.34) * smoothstep(0.93, 0.99, dot(n, hv)) * band;
    // warm rim light on the lit side
    float rim = smoothstep(0.55, 0.28, ndv) * clamp(ndl * 0.6 + 0.4, 0.0, 1.0);
    col += vec3(1.0, 0.85, 0.6) * rim * 0.14;

    // ink outline: silhouette-grazing normals -> contour line. Suppress in
    // concave creases (low AO) so folds don't flood with black.
    float ink = smoothstep(0.3, 0.16, ndv);
    col = mix(col, uInkColor, ink * 0.88 * mix(0.35, 1.0, smoothstep(0.4, 0.8, aoRaw)));
  }

  if (matv > 0.5) {
    // eyes & flat accents still get a crisp ink rim
    float ink = smoothstep(0.3, 0.16, ndv);
    col = mix(col, uInkColor, ink * 0.88);
  }

  // depth + fog from clip space
  vec4 clip = uMVP * vec4(p, 1.0);
  float ndcZ = clip.z / clip.w;
  gl_FragDepth = clamp(ndcZ * 0.5 + 0.5, 0.0, 1.0);
  float fog = smoothstep(uFogRange.x, uFogRange.y, clip.w);
  col = mix(col, uFogColor, fog * 0.85);

  fragColor = vec4(col, 1.0);
}
`;

export function createBlobMaterial(env) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    side: THREE.BackSide, // stays visible even when the camera pokes into the box
    uniforms: {
      uPrimA: { value: new Float32Array(MAX_PRIMS * 4) },
      uPrimB: { value: new Float32Array(MAX_PRIMS * 4) },
      uPrimC: { value: new Float32Array(MAX_PRIMS * 4) },
      uPrimCount: { value: 0 },
      uCamLocal: { value: new THREE.Vector3() },
      uLightLocal: { value: new THREE.Vector3(0.5, 0.8, 0.3) },
      uEyeLook: { value: new THREE.Vector3(0, 0, 1) },
      uPupil: { value: new THREE.Vector2(0.86, 0.975) },
      uMVP: { value: new THREE.Matrix4() },
      uBoxMin: { value: new THREE.Vector3(-1, -1, -1) },
      uBoxMax: { value: new THREE.Vector3(1, 1, 1) },
      uInkColor: { value: env.ink.clone() },
      uFogColor: { value: env.fogColor.clone() },
      uFogRange: { value: env.fogRange }, // shared: stage growth widens the fog live
    },
  });
}
