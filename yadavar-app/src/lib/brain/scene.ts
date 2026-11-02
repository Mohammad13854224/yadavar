import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { css, linkRGB, lobeRGB, neuronRGB } from './colors'
import { KIND_NEW, KIND_PARKED, KIND_REVIEW, type BrainModel } from './model'
import { growNeuron } from './morphology'

/**
 * The brain on screen (three.js / WebGL). Built for phones:
 * - every neuron is one point of a single point cloud, every synapse a strip of a single mesh, every region one instance
 *   of a single sphere: a handful of draw calls whatever the number of cards;
 * - all motion (firing, signals running along the synapses, broken links, embers leaving fading cells, growing links,
 *   cells moving to a new folder) is computed on the GPU from the clock: the CPU only moves the camera;
 * - real 3D cells (dendrites, spines, myelinated axon) are grown only for the few neurons right in front of the camera;
 * - the resolution steps down by itself on a slow phone, frames are halved when nothing moves, and nothing is drawn while
 *   hidden or covered.
 */

export interface SceneEvents {
  onselect: (i: number) => void
  /** a region's label was tapped */
  onregion?: (i: number) => void
}

/** a real cell is grown for the neurons up to this far from the camera (fully shown up to DETAIL_FULL) */
const DETAIL_FULL = 6.5
const DETAIL_FAR = 10
const DETAIL_MAX = 28

const NEURON_VS = /* glsl */ `
attribute vec4 aInfo;   // health, strength, kind, seed
attribute vec3 aColor;
attribute vec3 aFrom;   // where the cell was before the last change (it moves there -> here)
attribute float aIdx;
attribute float aFx;    // when it was last strengthened (s on the scene clock)
attribute float aGrown; // 1 while its real cell is grown (close to the camera)
uniform float uTime, uPx, uSel, uIntro, uRadius, uFocus, uMorph, uGain;
varying vec3 vColor;
varying float vFire, vH, vS, vKind, vA, vSeed, vPot, vNear, vPx, vDot;
void main() {
  float h = aInfo.x, s = aInfo.y, kind = aInfo.z, seed = aInfo.w;
  vec3 p = mix(aFrom, position, smoothstep(0.0, 1.0, uMorph));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(0.05, -mv.z);
  // spontaneous firing: a healthy, long-lasting memory fires often; a fading one rarely, and some of its spikes fail
  float per = kind < 0.5 ? 10.0 : kind < 1.5 ? 6.0 : kind > 2.5 ? 1e6 : mix(9.0, 2.4, h * h * (0.3 + 0.7 * s));
  float cyc = uTime / per + seed * 17.0;
  float ph = fract(cyc);
  float fire = exp(-ph * per * 5.0);
  float luck = fract(sin(floor(cyc) * 12.9898 + seed * 78.233) * 43758.5453);
  if (kind > 1.5 && kind < 2.5 && luck > 0.25 + 0.75 * h) fire *= 0.15;
  if (kind < 0.5) fire *= 0.35;
  if (kind > 0.5 && kind < 1.5) fire *= 0.5;
  vFire = fire;
  float pt = uTime - aFx;
  vPot = pt > 0.0 && pt < 4.0 ? (1.0 - exp(-pt * 10.0)) * exp(-pt * 0.9) : 0.0;
  // born from the middle outwards when the brain opens
  float grow = smoothstep(0.0, 0.12, uIntro * 1.25 - length(p) / uRadius);
  float sel = abs(aIdx - uSel) < 0.5 ? 1.0 : 0.0;
  // the glow seen from far away
  float size = kind < 0.5 ? 0.5 : kind > 2.5 ? 0.42 : 0.7 + 0.6 * s;
  size *= (1.0 + 0.45 * fire + 1.4 * vPot) * (1.0 + 0.5 * sel);
  // the drawn cell (its dendrites reach about as far as the real one's): a longer-lasting memory, a wider tree
  float shape = (kind < 0.5 ? 0.95 : kind > 2.5 ? 1.0 : 1.3 + 0.55 * s) * (1.0 + 0.25 * sel);
  float big = max(size, shape);
  vDot = size / big;
  // close up, the real grown cell takes over: the drawing keeps only its body (as the cell fades in)
  vNear = aGrown * (1.0 - smoothstep(${DETAIL_FULL.toFixed(1)}, ${DETAIL_FAR.toFixed(1)}, dist)) * smoothstep(0.3, 0.9, dist);
  // far away a cell never shrinks below a few pixels: the overview stays a field of lights
  gl_PointSize = clamp(big * uPx / dist, kind < 0.5 ? 3.0 : 5.0, 256.0) * grow;
  vPx = gl_PointSize;
  gl_Position = projectionMatrix * mv;
  // far from what is looked at: fainter (depth)
  vA = mix(0.18, 1.0, 1.0 - smoothstep(uFocus * 1.15, uFocus * 3.2, dist)) * (0.35 + 0.65 * min(1.0, size * uPx / dist / 3.0)) * mix(uGain, 1.0, sel);
  vColor = aColor;
  vH = h;
  vS = s;
  vKind = kind;
  vSeed = seed;
}`

// Each neuron is drawn as a cell on its own little square (no geometry, so every neuron can have it): a pyramidal body,
// dendrites forking once or twice and beaded with spines, and an axon with myelin segments, all from the card's numbers.
// A long-lasting memory has a wide, rich tree; a fading one loses pieces of its branches and its myelin, and a thin
// hollow ring stays around its body (the engram is still there, just unreachable); a card never studied has a few
// short thin processes. Far away (a few pixels) it is the glowing dot it always was: a shape that small only flickers.
const NEURON_FS = /* glsl */ `
uniform float uTime;
varying vec3 vColor;
varying float vFire, vH, vS, vKind, vA, vSeed, vPot, vNear, vPx, vDot;
float h1(float n) { return fract(sin(n) * 43758.5453); }
vec2 turn(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
// a tapering stroke from a to b; t = how far along
float seg(vec2 p, vec2 a, vec2 b, float w0, float w1, out float t) {
  vec2 pa = p - a, ba = b - a;
  t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float w = mix(w0, w1, t);
  return smoothstep(w, w * 0.3, length(pa - ba * t));
}
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  if (d > 1.0) discard;
  float wk = vKind > 0.5 && vKind < 2.5 ? 1.0 - vH : 0.0;
  float flick = 1.0 - wk * (0.35 + 0.35 * sin(uTime * (5.0 + vSeed * 6.0) + vSeed * 40.0));
  // early LTP shimmers
  if (vKind > 0.5 && vKind < 1.5) flick *= 0.8 + 0.2 * sin(uTime * 13.0 + vSeed * 30.0);
  // a cell never studied breathes slowly
  if (vKind < 0.5) flick = 0.65 + 0.2 * sin(uTime * 0.9 + vSeed * 20.0);

  // ---- far: the glowing dot ----
  float dd = d / vDot;
  float core = smoothstep(0.36, 0.1, dd);
  float halo = dd < 1.0 ? exp(-dd * dd * 4.5) : 0.0;
  float a0 = core * (1.0 - 0.55 * wk) * flick + halo * (0.17 + 0.5 * vFire + 0.6 * vPot) * (1.0 - 0.4 * wk) + smoothstep(0.07, 0.0, abs(dd - 0.5)) * wk * 0.6;
  vec3 col0 = mix(vColor, vec3(1.0), core * (0.35 + 0.6 * vFire) * (1.0 - wk * 0.7));
  float shapeOn = smoothstep(10.0, 22.0, vPx);
  if (shapeOn < 0.01) {
    gl_FragColor = vec4(mix(col0, vec3(1.0, 0.97, 0.85), vPot * 0.7), a0 * vA);
    return;
  }

  // ---- near: the cell ----
  bool young = vKind < 0.5;
  float px = 2.0 / vPx; // one screen pixel on this square
  float ang0 = vSeed * 6.2832;
  // the body: a rounded triangle (pyramidal)
  float th = atan(c.y, c.x) - ang0;
  float rs = (young ? 0.06 : 0.075 + 0.03 * vS) * (1.0 + 0.18 * cos(3.0 * th));
  float soma = smoothstep(rs + px, rs - px, d);
  float body = 0.0;
  float t;
  float tk;
  float n = young ? 5.0 : 4.0 + floor(h1(vSeed * 13.0) * 2.5) + floor(vS * 2.5);
  float w0 = young ? max(0.012, 0.7 * px) : max(0.028 + 0.012 * vS, px);
  float wEnd = max(young ? 0.004 : 0.007, 0.6 * px);
  float wMid = mix(w0, wEnd, 0.5);
  float lost = wk * 0.85; // share of the branch pieces a fading cell has lost
  float spine = young ? 0.0 : (0.25 + 0.5 * vS) * (1.0 - wk);
  for (int k = 0; k < 8; k++) {
    float fk = float(k);
    if (fk >= n) break;
    float ang = ang0 + fk * 6.2832 / n + (h1(fk * 1.7 + vSeed * 91.0) - 0.5) * 0.7;
    float L = (young ? 0.32 : 0.5 + 0.3 * vS) * (0.75 + 0.35 * h1(fk * 3.1 + vSeed * 17.0));
    if (k == 0 && !young) L = min(0.95, L * 1.5); // the apical dendrite
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 m = dir * L * 0.55 + vec2(-dir.y, dir.x) * L * 0.12 * (h1(fk + vSeed * 5.0) - 0.5);
    float br = seg(c, dir * rs * 0.9, m, w0, wMid, t);
    float along = t * 0.55;
    vec2 e = m + turn(dir, 0.35 + 0.3 * h1(fk + 2.0)) * L * 0.5;
    float b1 = seg(c, m, e, wMid, wEnd, tk);
    if (b1 > br) { br = b1; along = 0.55 + 0.45 * tk; }
    if (!young) {
      float b2 = seg(c, m, m + turn(dir, -0.4 - 0.3 * h1(fk + 4.0)) * L * 0.42, wMid, wEnd, tk);
      if (b2 > br) { br = b2; along = 0.55 + 0.45 * tk; }
      // deeper forks on a long-lasting memory
      if (vS > 0.45) {
        float b3 = seg(c, e, e + turn(dir, 0.9) * L * 0.25, wEnd, wEnd * 0.8, tk);
        if (b3 > br) { br = b3; along = 1.0; }
      }
    }
    // spines: beads along the branch, as many as the memory is strong and healthy
    br *= 1.0 - spine * 0.5 + spine * 0.9 * step(0.72, fract(dot(c, dir) * 55.0 + h1(fk + vSeed) * 9.0));
    // a fading cell: pieces of its branches gone (spine and synapse loss)
    if (lost > 0.0) br *= 1.0 - 0.9 * step(1.0 - lost, h1(floor(along * 7.0) + fk * 7.0 + vSeed * 3.0));
    body = max(body, br * (1.0 - 0.35 * along));
  }
  // the axon, away from the apical dendrite: myelin sheaths with gaps (nodes of Ranvier); fading: sheaths lost
  vec2 adir = vec2(cos(ang0 + 3.6416), sin(ang0 + 3.6416));
  float ax = seg(c, adir * rs, adir * (young ? 0.45 : 0.97), max(0.012, 0.8 * px), max(0.006, 0.6 * px), t);
  float nodes = young ? 0.0 : 3.0 + floor(5.0 * vS);
  float sheath = nodes > 0.0 && t > 0.12 ? step(0.18, fract(t * nodes)) : 0.0;
  if (lost > 0.0) sheath *= step(lost, h1(floor(t * nodes) + vSeed * 11.0));
  // the impulse running down it when the cell fires
  float run = exp(-pow((t - (1.0 - vFire)) * 9.0, 2.0)) * vFire;
  float axon = ax * (0.35 + 0.5 * sheath + 1.4 * run);

  float glow = exp(-d * d * 22.0) * (0.12 + 0.5 * vFire + 0.6 * vPot);
  float tree = (body + axon) * (young ? 0.55 : 0.9) * (1.0 - 0.45 * wk) * (1.0 - vNear);
  float ring = smoothstep(1.5 * px, 0.0, abs(d - rs * 1.9)) * wk * 0.6 * (1.0 - vNear);
  float a1 = soma * (1.0 - 0.5 * wk) + tree * (0.8 + 0.4 * vFire) + glow * (1.0 - 0.8 * vNear) + ring;
  vec3 col1 = mix(vColor, vec3(1.0), soma * (0.3 + 0.6 * vFire) * (1.0 - wk * 0.7));
  vec3 col = mix(col0, col1, shapeOn);
  col = mix(col, vec3(1.0, 0.97, 0.85), vPot * 0.7);
  gl_FragColor = vec4(col, mix(a0, a1 * flick, shapeOn) * vA);
}`

// embers drifting off fading cells: the synapses they lose
const MOTE_VS = /* glsl */ `
attribute vec3 aDir;
attribute vec3 aColor;
attribute vec2 aSeed; // seed, weakness
uniform float uTime, uPx, uMorph, uIntro;
varying vec3 vColor;
varying float vA;
void main() {
  float t = fract(uTime * (0.09 + aSeed.x * 0.08) + aSeed.x * 9.0);
  vec3 p = position + aDir * (0.1 + t * (0.45 + 0.5 * aSeed.y)) + vec3(0.0, t * 0.35, 0.0);
  p += 0.05 * vec3(sin(uTime * 1.3 + aSeed.x * 30.0), 0.0, cos(uTime * 1.1 + aSeed.x * 20.0)) * t;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(0.05, -mv.z);
  gl_PointSize = clamp((0.05 + 0.05 * aSeed.y) * (1.0 - t) * uPx / dist, 0.0, 40.0) * smoothstep(0.98, 1.0, uMorph) * step(0.99, uIntro);
  gl_Position = projectionMatrix * mv;
  vA = sin(3.14159 * t) * aSeed.y * (1.0 - smoothstep(14.0, 40.0, dist));
  vColor = aColor;
}`
const MOTE_FS = /* glsl */ `
varying vec3 vColor;
varying float vA;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  gl_FragColor = vec4(vColor, exp(-d * d * 4.0) * vA);
}`

const LINK_VS = /* glsl */ `
attribute vec3 aA;
attribute vec3 aB;
attribute vec2 aCorner; // which end of the piece, which side of the strip
attribute vec4 aL;      // strength, seed, length, grows from (s on the clock; < 0 = there already)
attribute vec2 aT;      // where the piece starts and ends along the whole link
attribute vec2 aEnds;   // the two neurons
attribute vec3 aColor;
uniform vec2 uView;
uniform float uDpr, uSel, uFocus, uMorph, uIntro, uGain;
varying vec3 vColor;
varying vec4 vL;
varying float vT, vSide, vA, vSel;
void main() {
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(aA, 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(aB, 1.0);
  if (ca.w < 0.06 || cb.w < 0.06) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 sa = ca.xy / ca.w * uView;
  vec2 sb = cb.xy / cb.w * uView;
  vec2 dir = sb - sa;
  dir = length(dir) < 1e-4 ? vec2(1.0, 0.0) : normalize(dir);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = aCorner.x < 0.5 ? ca : cb;
  vSel = (abs(aEnds.x - uSel) < 0.5 || abs(aEnds.y - uSel) < 0.5) ? 1.0 : 0.0;
  float s = aL.x;
  // never thinner than about a pixel and a half: thinner strips flicker and vanish
  float w = max(1.5 * uDpr, mix(0.7, 2.6, s) * uDpr * clamp(4.0 / c.w, 0.55, 1.5)) * (1.0 + 0.8 * vSel);
  c.xy += nrm * aCorner.y * w / uView * c.w;
  gl_Position = c;
  vT = mix(aT.x, aT.y, aCorner.x);
  vSide = aCorner.y;
  vL = aL;
  vColor = aColor;
  float fade = mix(0.2, 1.0, 1.0 - smoothstep(uFocus * 1.2, uFocus * 3.0, c.w));
  // after a change the links come back once the cells have arrived
  vA = fade * mix(uGain, 1.0, vSel) * smoothstep(0.75, 1.0, uMorph) * smoothstep(0.7, 1.0, uIntro) * (uSel >= 0.0 ? (vSel > 0.5 ? 2.2 : 0.45) : 1.0);
}`

const LINK_FS = /* glsl */ `
uniform float uTime;
varying vec3 vColor;
varying vec4 vL;
varying float vT, vSide, vA, vSel;
void main() {
  float s = vL.x, seed = vL.y, L = max(0.2, vL.z), born = vL.w;
  float edge = 1.0 - abs(vSide);
  float a = (0.07 + 0.5 * pow(s, 1.2)) * smoothstep(0.0, 0.6, edge);
  // a weak synapse is being taken away: it breaks into pieces that slowly drift
  float dash = step(0.42, fract(vT * L * 1.7 - uTime * 0.1 + seed * 5.0));
  a *= mix(0.12 + 0.88 * dash, 1.0, smoothstep(0.1, 0.32, s));
  // the action potential runs from one cell to the other; on a weak link it dies out on the way
  float per = mix(8.0, 2.6, s);
  float ph = fract(uTime / per + seed * 11.0);
  float at = ph * per * 2.6 / L;
  float pulse = 0.0;
  if (at < 1.25) {
    float dd = (vT - at) * L;
    pulse = exp(-dd * dd * 26.0) * exp(-at * (1.0 - s) * 2.6) * step(vT, at + 0.05);
    // transmitter release where it arrives
    pulse += smoothstep(0.9, 1.0, vT) * exp(-abs(at - 1.05) * 14.0) * s * 1.2;
  }
  vec3 col = vColor;
  // a new link grows out from one cell (its growth cone a bright tip) and lights up when it touches the other
  if (born > 0.0) {
    float g = clamp((uTime - born) / 1.8, 0.0, 1.0);
    if (uTime < born || vT > g) discard;
    float tip = exp(-pow((vT - g) * L * 5.0, 2.0)) * (1.0 - step(1.0, g));
    float touch = g >= 1.0 ? exp(-(uTime - born - 1.8) * 2.0) : 0.0;
    a += tip * 1.6 + touch * 0.8;
    col = mix(col, vec3(1.0, 0.96, 0.9), min(1.0, tip + touch * 0.6));
  }
  a += pulse * (0.6 + 0.4 * s);
  col = mix(col, vec3(1.0), min(1.0, pulse * 0.6));
  gl_FragColor = vec4(col, min(1.0, a) * vA);
}`

// a region: a camera-facing square on which a perfectly round membrane is drawn (bright rim, faint inside); four
// corners per region instead of a sphere mesh
const SHELL_VS = /* glsl */ `
attribute vec4 aSphere; // centre, radius
attribute vec4 aShell;  // r, g, b, depth
uniform float uMorph;
varying vec2 vUv;
varying vec3 vColor;
varying float vVis;
void main() {
  vec4 c = viewMatrix * vec4(aSphere.xyz, 1.0);
  float dist = length(c.xyz);
  float r = aSphere.w;
  float apparent = r / max(1e-3, dist);
  // a region shows as a membrane when it is seen from outside at a useful size; from inside it disappears
  vVis = smoothstep(0.035, 0.14, apparent) * (1.0 - smoothstep(0.55, 0.95, apparent)) * smoothstep(0.6, 1.0, uMorph);
  if (aShell.w < 0.5) vVis = 0.6 * (1.0 - smoothstep(0.7, 1.0, apparent));
  if (vVis < 0.003 || dist <= r) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  // the silhouette of a ball seen in perspective is a little wider than its radius
  float k = r * dist / sqrt(dist * dist - r * r);
  c.xy += position.xy * k;
  vUv = position.xy;
  vColor = aShell.rgb;
  gl_Position = projectionMatrix * c;
}`
const SHELL_FS = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vVis;
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float rim = pow(1.0 - sqrt(max(0.0, 1.0 - d * d)), 2.4);
  float a = rim * 0.24 + (1.0 - d) * 0.025;
  a *= smoothstep(1.0, 0.97, d);
  gl_FragColor = vec4(vColor, a * vVis);
}`

const DUST_VS = /* glsl */ `
attribute float aSeed;
uniform float uTime, uPx;
varying float vA;
void main() {
  vec3 p = position + 0.4 * vec3(sin(uTime * 0.05 + aSeed * 50.0), sin(uTime * 0.04 + aSeed * 70.0), cos(uTime * 0.045 + aSeed * 30.0));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(0.1, -mv.z);
  gl_PointSize = clamp(0.06 * uPx / dist, 0.8, 6.0);
  gl_Position = projectionMatrix * mv;
  vA = 0.16 * (0.5 + 0.5 * sin(uTime * 0.3 + aSeed * 90.0));
}`
const DUST_FS = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  gl_FragColor = vec4(0.55, 0.7, 1.0, (1.0 - d) * vA);
}`

const CELL_VS = /* glsl */ `
attribute float aPart;
attribute float aAx;
varying vec3 vN, vV;
varying float vPart, vAx;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  vPart = aPart;
  vAx = aAx;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`
// the cell is seen like a fluorescence image: bright at the edges of its branches, see-through in the middle
const CELL_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uTime, uPer, uSeed, uH, uFade, uNodes, uFire;
varying vec3 vN, vV;
varying float vPart, vAx;
void main() {
  float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float a = 0.14 + 0.86 * pow(rim, 1.7);
  vec3 col = uColor;
  float cyc = uTime / uPer + uSeed * 17.0;
  float ph = fract(cyc);
  float fire = exp(-ph * uPer * 5.0) * uFire;
  if (vPart > 0.5 && vPart < 1.5) { col = mix(vec3(0.8, 0.88, 1.0), uColor, 0.3); a *= 0.75; }
  if (vPart > 2.5) { a = a * 1.2 + fire * 0.9; col = mix(col, vec3(1.0), fire * 0.6); }
  if (vAx >= 0.0) {
    // the impulse leaves the body and jumps from one node of Ranvier to the next (saltatory conduction)
    float t = ph * uPer * 1.6;
    float q = uNodes > 1.0 ? floor(t * uNodes + 0.5) / uNodes : t;
    float g = exp(-pow((vAx - q) * 14.0, 2.0)) * step(t, 1.15) * uFire;
    a += g * 1.4;
    col = mix(col, vec3(1.0, 0.98, 0.9), min(1.0, g));
  }
  // a fading cell: paler and thinner light
  a *= 0.55 + 0.45 * uH;
  gl_FragColor = vec4(col, min(1.0, a) * uFade * 0.9);
}`
const DOT_VS = /* glsl */ `
attribute vec2 aDot; // size, kind
uniform float uPx;
varying float vKind;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  float dist = max(0.02, -mv.z);
  gl_PointSize = clamp((aDot.y > 0.5 ? 0.028 : 0.018) * aDot.x * uPx / dist, 0.0, 64.0);
  gl_Position = projectionMatrix * mv;
  vKind = aDot.y;
}`
const DOT_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uFade, uH;
varying float vKind;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  if (d > 1.0) discard;
  vec3 col = vKind > 0.5 ? mix(uColor, vec3(1.0), 0.5) : mix(uColor, vec3(1.0), 0.25);
  gl_FragColor = vec4(col, smoothstep(1.0, 0.3, d) * uFade * (0.5 + 0.5 * uH));
}`

const SEL_VS = /* glsl */ `
uniform float uPx;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(0.9 * uPx / max(0.05, -mv.z), 28.0, 220.0);
  gl_Position = projectionMatrix * mv;
}`
const SEL_FS = /* glsl */ `
uniform float uTime;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  float ang = atan(c.y, c.x);
  float ring = smoothstep(0.05, 0.0, abs(d - 0.86)) * step(0.35, fract(ang / 6.2832 * 12.0 + uTime * 0.15));
  float inner = smoothstep(0.04, 0.0, abs(d - 0.62 - 0.04 * sin(uTime * 3.0))) * 0.5;
  gl_FragColor = vec4(1.0, 1.0, 1.0, (ring + inner) * 0.8);
}`

type Fly = { t0: number; dur: number; ft: THREE.Vector3; tt: THREE.Vector3; fc: THREE.Vector3; tc: THREE.Vector3 }
type Detail = { group: THREE.Group; mats: THREE.ShaderMaterial[]; geos: THREE.BufferGeometry[]; used: number }

const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const

export class BrainScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private clock = 0
  private last = 0
  private raf = 0
  private paused = false
  private hidden = false
  private idleSince = 0
  private frame = 0
  private slow = 0
  private ratio: number
  private model: BrainModel | null = null
  private neurons: THREE.Points | null = null
  private motes: THREE.Points | null = null
  private links: THREE.Mesh | null = null
  private shells: THREE.Mesh | null = null
  private dust: THREE.Points | null = null
  private sel: THREE.Points
  private selIndex = -1
  private colors = new Float32Array(0)
  private partner = new Int32Array(0)
  private fly: Fly | null = null
  private details = new Map<number, Detail>()
  private lastDetailCheck = new THREE.Vector3(1e9, 0, 0)
  private lastDetailDir = new THREE.Vector3()
  private grown: THREE.BufferAttribute | null = null
  private uniforms = {
    uTime: { value: 0 },
    uPx: { value: 800 },
    uSel: { value: -1 },
    uIntro: { value: 0 },
    uRadius: { value: 10 },
    uFocus: { value: 20 },
    uMorph: { value: 1 },
    uView: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
    /** exposure: many cells covering the screen (a big brain seen whole) would add up to white */
    uGain: { value: 1 },
  }
  private morphStart = -1
  private shellColor = new Float32Array(0)
  private labels: { el: HTMLElement; region: number; w: number }[] = []
  private selLabel: HTMLElement
  private down: { x: number; y: number; t: number; id: number } | null = null
  private touches = 0
  private ro: ResizeObserver
  private projM = new THREE.Matrix4()
  private v = new THREE.Vector3()

  constructor(
    private canvas: HTMLCanvasElement,
    private layer: HTMLElement,
    private ev: SceneEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setClearColor(0x02050b, 1)
    this.ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.setPixelRatio(this.ratio)
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000)
    this.camera.position.set(0, 4, 30)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.09
    this.controls.zoomToCursor = true
    this.controls.screenSpacePanning = true
    this.controls.rotateSpeed = 0.7
    this.controls.minDistance = 0.25
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
    this.controls.addEventListener('start', () => {
      this.fly = null
      this.wake()
    })
    this.controls.addEventListener('change', () => this.wake())

    const selGeo = new THREE.BufferGeometry()
    selGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
    this.sel = new THREE.Points(selGeo, new THREE.ShaderMaterial({ vertexShader: SEL_VS, fragmentShader: SEL_FS, uniforms: this.uniforms, ...additive }))
    this.sel.visible = false
    this.sel.frustumCulled = false
    this.sel.renderOrder = 5
    this.scene.add(this.sel)

    this.selLabel = document.createElement('div')
    this.selLabel.className = 'brain-sel-label'
    this.selLabel.style.display = 'none'
    layer.appendChild(this.selLabel)

    canvas.addEventListener('pointerdown', this.onDown)
    canvas.addEventListener('pointerup', this.onUp)
    canvas.addEventListener('pointercancel', this.onCancel)
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    document.addEventListener('visibilitychange', this.onVis)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  // ---------- data ----------

  /**
   * Shows a (new) model. `since`: links made and neurons reviewed after this time (ms) are shown growing / being
   * strengthened. Neurons that are already on screen move from where they were to their new place.
   */
  setModel(m: BrainModel, since: number) {
    const first = !this.model
    const prev = this.model
    const prevPos = new Map<string, number>()
    if (prev) for (let i = 0; i < prev.count; i++) prevPos.set(prev.ids[i], i)
    const selId = prev && this.selIndex >= 0 ? prev.ids[this.selIndex] : null
    this.model = m
    this.clearDetails()
    this.disposeObj(this.neurons)
    this.disposeObj(this.motes)
    this.disposeObj(this.links)
    this.disposeObj(this.shells)
    this.uniforms.uRadius.value = m.radius

    const t = this.clock
    const n = m.count
    // ---- neurons ----
    const colors = new Float32Array(n * 3)
    const from = new Float32Array(n * 3)
    const fx = new Float32Array(n)
    const idx = new Float32Array(n)
    let moved = false
    for (let i = 0; i < n; i++) {
      const c = neuronRGB(m.info[i * 4], m.info[i * 4 + 1], m.info[i * 4 + 2])
      colors.set(c, i * 3)
      idx[i] = i
      const j = prevPos.get(m.ids[i])
      if (j !== undefined && prev) {
        from[i * 3] = prev.pos[j * 3]
        from[i * 3 + 1] = prev.pos[j * 3 + 1]
        from[i * 3 + 2] = prev.pos[j * 3 + 2]
        if (Math.abs(from[i * 3] - m.pos[i * 3]) + Math.abs(from[i * 3 + 1] - m.pos[i * 3 + 1]) + Math.abs(from[i * 3 + 2] - m.pos[i * 3 + 2]) > 1e-3) moved = true
      } else from.set(m.pos.subarray(i * 3, i * 3 + 3), i * 3)
      fx[i] = m.lastReview[i] > since ? t + (first ? 2.2 : 0.2) + Math.random() * 0.6 : -100
    }
    this.colors = colors
    const ng = new THREE.BufferGeometry()
    ng.setAttribute('position', new THREE.BufferAttribute(m.pos, 3))
    ng.setAttribute('aFrom', new THREE.BufferAttribute(from, 3))
    ng.setAttribute('aInfo', new THREE.BufferAttribute(m.info, 4))
    ng.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
    ng.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1))
    ng.setAttribute('aFx', new THREE.BufferAttribute(fx, 1))
    this.grown = new THREE.BufferAttribute(new Float32Array(n), 1)
    ng.setAttribute('aGrown', this.grown)
    this.neurons = new THREE.Points(ng, new THREE.ShaderMaterial({ vertexShader: NEURON_VS, fragmentShader: NEURON_FS, uniforms: this.uniforms, ...additive }))
    this.neurons.frustumCulled = false
    this.neurons.renderOrder = 3
    this.scene.add(this.neurons)
    if (moved && !first) {
      this.morphStart = t
      this.uniforms.uMorph.value = 0
    }

    // ---- embers around fading cells ----
    const mp: number[] = []
    const md: number[] = []
    const mc: number[] = []
    const ms: number[] = []
    for (let i = 0; i < n && mp.length < 60000 * 3; i++) {
      const kind = m.info[i * 4 + 2]
      const h = m.info[i * 4]
      if (kind === KIND_NEW || kind === KIND_PARKED || h > 0.8) continue
      const wk = 1 - h
      for (let k = 0; k < 4; k++) {
        const u = Math.random() * 2 - 1
        const a = Math.random() * Math.PI * 2
        const s = Math.sqrt(1 - u * u)
        mp.push(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2])
        md.push(Math.cos(a) * s, u, Math.sin(a) * s)
        mc.push(1, 0.55 + 0.3 * (1 - wk), 0.25)
        ms.push(Math.random(), wk)
      }
    }
    if (mp.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mp), 3))
      g.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array(md), 3))
      g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(mc), 3))
      g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(ms), 2))
      this.motes = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: MOTE_VS, fragmentShader: MOTE_FS, uniforms: this.uniforms, ...additive }))
      this.motes.frustumCulled = false
      this.motes.renderOrder = 4
      this.scene.add(this.motes)
    }

    // ---- synapses ----
    this.partner = new Int32Array(n).fill(-1)
    const best = new Float32Array(n)
    const L = m.linkA.length
    let pieces = 0
    const segsOf = new Uint8Array(L)
    for (let l = 0; l < L; l++) {
      const a = m.linkA[l]
      const b = m.linkB[l]
      const d = Math.hypot(m.pos[a * 3] - m.pos[b * 3], m.pos[a * 3 + 1] - m.pos[b * 3 + 1], m.pos[a * 3 + 2] - m.pos[b * 3 + 2])
      segsOf[l] = m.linkKind[l] === 1 ? (d < 3 ? 2 : 6) : 1
      pieces += segsOf[l]
      const s = m.linkS[l]
      if (s > best[a]) ((best[a] = s), (this.partner[a] = b))
      if (s > best[b]) ((best[b] = s), (this.partner[b] = a))
    }
    if (pieces) {
      const V = pieces * 4
      const A = new Float32Array(V * 3)
      const Bp = new Float32Array(V * 3)
      const corner = new Float32Array(V * 2)
      const li = new Float32Array(V * 4)
      const tt = new Float32Array(V * 2)
      const ends = new Float32Array(V * 2)
      const col = new Float32Array(V * 3)
      const index = new Uint32Array(pieces * 6)
      let v = 0
      let q = 0
      const pa = new THREE.Vector3()
      const pb = new THREE.Vector3()
      const mid = new THREE.Vector3()
      const p0 = new THREE.Vector3()
      const p1 = new THREE.Vector3()
      const bez = (u: number, out: THREE.Vector3) => {
        const w = 1 - u
        return out.set(
          w * w * pa.x + 2 * w * u * mid.x + u * u * pb.x,
          w * w * pa.y + 2 * w * u * mid.y + u * u * pb.y,
          w * w * pa.z + 2 * w * u * mid.z + u * u * pb.z,
        )
      }
      // growth starts spread out a little, the strongest first
      let growing = 0
      for (let l = 0; l < L; l++) {
        const a = m.linkA[l]
        const b = m.linkB[l]
        pa.fromArray(m.pos, a * 3)
        pb.fromArray(m.pos, b * 3)
        const d = pa.distanceTo(pb)
        // links between cards reviewed together arch like fibre bundles; folder wiring is short and straight
        mid.addVectors(pa, pb).multiplyScalar(0.5)
        if (segsOf[l] > 1) {
          const out = mid.clone()
          if (out.lengthSq() < 1e-6) out.set(0, 1, 0)
          mid.addScaledVector(out.normalize(), d * 0.22)
        }
        const temporal = m.linkKind[l] === 1
        const cl = this.colors
        const silent = m.info[a * 4 + 2] === KIND_NEW || m.info[b * 4 + 2] === KIND_NEW
        const c = linkRGB([cl[a * 3], cl[a * 3 + 1], cl[a * 3 + 2]], [cl[b * 3], cl[b * 3 + 1], cl[b * 3 + 2]], temporal, silent && !temporal)
        const seed = Math.random()
        const born = temporal && m.linkLast[l] > since ? t + (first ? 2.4 : 0.6) + Math.min(3, growing++ * 0.03) : -1
        const segs = segsOf[l]
        const strength = m.linkS[l]
        const span = Math.max(0.3, d)
        for (let k = 0; k < segs; k++) {
          const u0 = k / segs
          const u1 = (k + 1) / segs
          if (segs > 1) {
            bez(u0, p0)
            bez(u1, p1)
          } else {
            p0.copy(pa)
            p1.copy(pb)
          }
          // (plain writes, no small arrays: this runs for hundreds of thousands of corners)
          for (let e = 0; e < 4; e++) {
            const v3 = v * 3
            const v2 = v * 2
            const v4 = v * 4
            A[v3] = p0.x
            A[v3 + 1] = p0.y
            A[v3 + 2] = p0.z
            Bp[v3] = p1.x
            Bp[v3 + 1] = p1.y
            Bp[v3 + 2] = p1.z
            corner[v2] = e < 2 ? 0 : 1
            corner[v2 + 1] = e % 2 ? 1 : -1
            li[v4] = strength
            li[v4 + 1] = seed
            li[v4 + 2] = span
            li[v4 + 3] = born
            tt[v2] = u0
            tt[v2 + 1] = u1
            ends[v2] = a
            ends[v2 + 1] = b
            col[v3] = c[0]
            col[v3 + 1] = c[1]
            col[v3 + 2] = c[2]
            v++
          }
          const o = v - 4
          index[q] = o
          index[q + 1] = o + 1
          index[q + 2] = o + 2
          index[q + 3] = o + 2
          index[q + 4] = o + 1
          index[q + 5] = o + 3
          q += 6
        }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(A, 3)) // (three wants a position; the shader uses aA / aB)
      g.setAttribute('aA', new THREE.BufferAttribute(A, 3))
      g.setAttribute('aB', new THREE.BufferAttribute(Bp, 3))
      g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2))
      g.setAttribute('aL', new THREE.BufferAttribute(li, 4))
      g.setAttribute('aT', new THREE.BufferAttribute(tt, 2))
      g.setAttribute('aEnds', new THREE.BufferAttribute(ends, 2))
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
      g.setIndex(new THREE.BufferAttribute(index, 1))
      this.links = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: LINK_VS, fragmentShader: LINK_FS, uniforms: this.uniforms, ...additive, side: THREE.DoubleSide }))
      this.links.frustumCulled = false
      this.links.renderOrder = 2
      this.scene.add(this.links)
    }

    // ---- regions: only the ones worth showing from where the camera is are drawn (see cullShells) ----
    const R = m.regions.length
    const SH = Math.min(R, 600)
    const sg = new THREE.InstancedBufferGeometry()
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3))
    sg.setIndex([0, 1, 2, 2, 1, 3])
    this.shellColor = new Float32Array(R * 3)
    m.regions.forEach((r, i) => this.shellColor.set(lobeRGB(r.lobe, r.depth), i * 3))
    sg.setAttribute('aSphere', new THREE.InstancedBufferAttribute(new Float32Array(SH * 4), 4).setUsage(THREE.DynamicDrawUsage))
    sg.setAttribute('aShell', new THREE.InstancedBufferAttribute(new Float32Array(SH * 4), 4).setUsage(THREE.DynamicDrawUsage))
    sg.instanceCount = 0
    this.shells = new THREE.Mesh(sg, new THREE.ShaderMaterial({ vertexShader: SHELL_VS, fragmentShader: SHELL_FS, uniforms: this.uniforms, ...additive }))
    this.shells.frustumCulled = false
    this.shells.renderOrder = 1
    this.scene.add(this.shells)
    this.cullShells(true)

    // ---- the haze between the cells ----
    if (!this.dust) {
      const D = 1800
      const p = new Float32Array(D * 3)
      const s = new Float32Array(D)
      for (let i = 0; i < D; i++) {
        const u = Math.random() * 2 - 1
        const a = Math.random() * Math.PI * 2
        const r = Math.cbrt(Math.random()) * 1.5
        const k = Math.sqrt(1 - u * u)
        p.set([Math.cos(a) * k * r, u * r, Math.sin(a) * k * r], i * 3)
        s[i] = Math.random()
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(p, 3))
      g.setAttribute('aSeed', new THREE.BufferAttribute(s, 1))
      this.dust = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: DUST_VS, fragmentShader: DUST_FS, uniforms: this.uniforms, ...additive }))
      this.dust.frustumCulled = false
      this.scene.add(this.dust)
    }
    this.dust.scale.setScalar(m.radius)

    this.controls.maxDistance = m.radius * 5 + 10
    this.camera.far = m.radius * 14 + 100
    this.camera.updateProjectionMatrix()
    if (first) this.intro()

    // the selected neuron stays selected (wherever it went); gone: nothing is selected
    const keep = selId ? m.ids.indexOf(selId) : -1
    this.setSelected(keep, false)
    this.pickLabels(true)
    this.wake()
  }

  // ---------- camera ----------

  /** how far the camera must be for a ball of radius r to fill the screen (portrait phones: the width decides) */
  private fit(r: number) {
    const v = (this.camera.fov * Math.PI) / 360
    const h = Math.atan(Math.tan(v) * this.camera.aspect)
    return (r / Math.sin(Math.min(v, h))) * 0.92
  }

  private intro() {
    const D = this.fit(this.model!.radius)
    this.controls.target.set(0, 0, 0)
    this.camera.position.set(D * 0.35, D * 0.45, D * 1.6)
    this.flyTo(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.25, 0.3, 1).normalize().multiplyScalar(D), 2.4)
    this.uniforms.uIntro.value = 0
  }

  private flyTo(target: THREE.Vector3, cam: THREE.Vector3, dur = 1.1) {
    this.fly = { t0: this.clock, dur, ft: this.controls.target.clone(), tt: target.clone(), fc: this.camera.position.clone(), tc: cam.clone() }
    this.wake()
  }

  /** flies to a neuron and selects it */
  focusNeuron(i: number) {
    const m = this.model
    if (!m || i < 0 || i >= m.count) return
    const p = new THREE.Vector3().fromArray(m.pos, i * 3)
    const dir = this.camera.position.clone().sub(this.controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
    this.flyTo(p, p.clone().add(dir.normalize().multiplyScalar(2.1)))
    this.setSelected(i, true)
  }

  focusRegion(ri: number) {
    const r = this.model?.regions[ri]
    if (!r) return
    const c = new THREE.Vector3(r.x, r.y, r.z)
    const dir = this.camera.position.clone().sub(this.controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
    this.flyTo(c, c.clone().add(dir.normalize().multiplyScalar(Math.max(2.5, this.fit(r.r)))))
  }

  home() {
    const R = this.model?.radius ?? 10
    this.setSelected(-1, true)
    const dir = this.camera.position.clone().sub(this.controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
    this.flyTo(new THREE.Vector3(), dir.normalize().multiplyScalar(this.fit(R)))
  }

  setSelected(i: number, tell: boolean) {
    this.selIndex = i
    this.uniforms.uSel.value = i
    const m = this.model
    if (m && i >= 0) {
      ;(this.sel.geometry.getAttribute('position') as THREE.BufferAttribute).copyArray(m.pos.subarray(i * 3, i * 3 + 3)).needsUpdate = true
      this.sel.visible = true
    } else this.sel.visible = false
    if (tell) this.ev.onselect(i)
    this.wake()
  }

  setSelLabel(text: string) {
    this.selLabel.textContent = text
  }

  setPaused(p: boolean) {
    this.paused = p
    this.wake()
  }

  // ---------- tapping ----------

  private onDown = (e: PointerEvent) => {
    this.touches++
    this.down = this.touches === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null
  }
  private onCancel = () => {
    this.touches = Math.max(0, this.touches - 1)
    this.down = null
  }
  private onUp = (e: PointerEvent) => {
    this.touches = Math.max(0, this.touches - 1)
    const d = this.down
    this.down = null
    if (!d || d.id !== e.pointerId) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 9 || performance.now() - d.t > 450) return
    const i = this.pick(e.clientX, e.clientY)
    if (i >= 0) this.focusNeuron(i)
    else this.setSelected(-1, true)
  }

  /** the neuron under a point of the screen (the nearest one in front when several are there), -1 for none */
  private pick(cx: number, cy: number): number {
    const m = this.model
    if (!m) return -1
    const rect = this.canvas.getBoundingClientRect()
    const px = cx - rect.left
    const py = cy - rect.top
    this.camera.updateMatrixWorld()
    this.projM.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
    const e = this.projM.elements
    const W = rect.width
    const H = rect.height
    const focal = H / 2 / Math.tan((this.camera.fov * Math.PI) / 360)
    let best = -1
    let bestScore = Infinity
    const p = m.pos
    for (let i = 0; i < m.count; i++) {
      const x = p[i * 3]
      const y = p[i * 3 + 1]
      const z = p[i * 3 + 2]
      const w = e[3] * x + e[7] * y + e[11] * z + e[15]
      if (w < 0.05) continue
      const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) * 0.5 * W
      const sy = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 * H
      const d = Math.hypot(sx - px, sy - py)
      const reach = Math.max(20, (0.3 * focal) / w)
      if (d > reach) continue
      const score = d / reach + w * 0.02
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    }
    return best
  }

  /** the regions seen from outside at a useful size, biggest first (a few hundred at most) */
  private cullShells(force = false) {
    const m = this.model
    const mesh = this.shells
    if (!m || !mesh || (!force && this.frame % 10)) return
    const g = mesh.geometry as THREE.InstancedBufferGeometry
    const sph = g.getAttribute('aSphere') as THREE.InstancedBufferAttribute
    const shl = g.getAttribute('aShell') as THREE.InstancedBufferAttribute
    const cap = sph.count
    const cam = this.camera.position
    const list: [number, number][] = []
    for (let i = 0; i < m.regions.length; i++) {
      const r = m.regions[i]
      const a = r.r / Math.max(1e-3, Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z))
      if (r.depth === 0 ? a < 1 : a > 0.035 && a < 0.95) list.push([a, i])
    }
    if (list.length > cap) list.sort((x, y) => y[0] - x[0])
    const n = Math.min(cap, list.length)
    const A = sph.array as Float32Array
    const B = shl.array as Float32Array
    for (let k = 0; k < n; k++) {
      const i = list[k][1]
      const r = m.regions[i]
      A[k * 4] = r.x
      A[k * 4 + 1] = r.y
      A[k * 4 + 2] = r.z
      A[k * 4 + 3] = r.r
      B[k * 4] = this.shellColor[i * 3]
      B[k * 4 + 1] = this.shellColor[i * 3 + 1]
      B[k * 4 + 2] = this.shellColor[i * 3 + 2]
      B[k * 4 + 3] = r.depth
    }
    sph.needsUpdate = true
    shl.needsUpdate = true
    g.instanceCount = n
  }

  // ---------- labels ----------

  private pickLabels(force = false) {
    const m = this.model
    if (!m) return
    if (!force && this.frame % 14) return
    const W = this.canvas.clientWidth
    const H = this.canvas.clientHeight
    const focal = H / 2 / Math.tan((this.camera.fov * Math.PI) / 360)
    const cands: { i: number; sx: number; sy: number; pr: number }[] = []
    this.camera.updateMatrixWorld()
    for (let i = 0; i < m.regions.length; i++) {
      const r = m.regions[i]
      if (!r.id) continue
      this.v.set(r.x, r.y, r.z)
      const dist = this.v.distanceTo(this.camera.position)
      if (dist < r.r * 1.15) continue
      this.v.project(this.camera)
      if (this.v.z > 1) continue
      const sx = (this.v.x + 1) * 0.5 * W
      const sy = (1 - this.v.y) * 0.5 * H
      const pr = (r.r * focal) / dist
      if (pr < 26 || pr > Math.min(W, H) * 0.7) continue
      if (sx < -pr || sx > W + pr || sy < -pr || sy > H + pr) continue
      cands.push({ i, sx, sy: sy - pr, pr })
    }
    cands.sort((a, b) => b.pr - a.pr)
    const chosen: typeof cands = []
    for (const c of cands) {
      if (chosen.length >= 9) break
      if (chosen.some((o) => Math.abs(o.sx - c.sx) < 110 && Math.abs(o.sy - c.sy) < 34)) continue
      chosen.push(c)
    }
    const want = new Set(chosen.map((c) => c.i))
    this.labels = this.labels.filter((l) => {
      if (want.has(l.region)) return true
      l.el.remove()
      return false
    })
    for (const c of chosen) {
      if (this.labels.some((l) => l.region === c.i)) continue
      const r = m.regions[c.i]
      const el = document.createElement('button')
      el.className = 'brain-label'
      el.dir = 'auto'
      el.style.setProperty('--c', css(lobeRGB(r.lobe, r.depth)))
      const b = document.createElement('b')
      b.textContent = r.name
      const s = document.createElement('small')
      s.textContent = new Intl.NumberFormat('fa-IR').format(r.total)
      el.append(b, s)
      el.addEventListener('click', () => {
        this.focusRegion(c.i)
        this.ev.onregion?.(c.i)
      })
      this.layer.appendChild(el)
      this.labels.push({ el, region: c.i, w: el.offsetWidth })
    }
  }

  private placeLabels() {
    const m = this.model
    if (!m) return
    const W = this.canvas.clientWidth
    const H = this.canvas.clientHeight
    const focal = H / 2 / Math.tan((this.camera.fov * Math.PI) / 360)
    for (const l of this.labels) {
      const r = m.regions[l.region]
      this.v.set(r.x, r.y, r.z)
      const dist = this.v.distanceTo(this.camera.position)
      this.v.project(this.camera)
      // over the top of its region, kept inside the screen
      const sx = Math.max(6 + l.w / 2, Math.min(W - 6 - l.w / 2, (this.v.x + 1) * 0.5 * W))
      const sy = Math.max(100, (1 - this.v.y) * 0.5 * H - (r.r * focal) / dist)
      const hide = this.v.z > 1 || dist < r.r * 1.15
      l.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`
      l.el.style.opacity = hide ? '0' : ''
    }
    if (this.selIndex >= 0 && this.selLabel.textContent) {
      this.v.fromArray(m.pos, this.selIndex * 3)
      const dist = this.v.distanceTo(this.camera.position)
      this.v.project(this.camera)
      const sx = (this.v.x + 1) * 0.5 * W
      const sy = (1 - this.v.y) * 0.5 * H - Math.max(16, (0.16 * focal) / dist)
      this.selLabel.style.display = this.v.z > 1 ? 'none' : ''
      this.selLabel.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`
    } else this.selLabel.style.display = 'none'
  }

  // ---------- grown cells near the camera ----------

  private updateDetails() {
    const m = this.model
    if (!m) return
    const cam = this.camera.position
    for (const d of this.details.values()) {
      const dist = d.group.position.distanceTo(cam)
      // seen from right against it, a cell would fill the screen: it fades out there too
      const fade = (1 - THREE.MathUtils.smoothstep(dist, DETAIL_FULL, DETAIL_FAR)) * THREE.MathUtils.smoothstep(dist, 0.3, 0.9)
      for (const mat of d.mats) mat.uniforms.uFade.value = fade
      d.group.visible = fade > 0.01
    }
    // cells moving to a new place: grown again where they arrive
    if (this.morphStart >= 0) return
    this.camera.getWorldDirection(this.v)
    if (this.lastDetailCheck.distanceTo(cam) < 0.2 && this.lastDetailDir.dot(this.v) > 0.995 && this.frame % 30) return
    this.lastDetailCheck.copy(cam)
    this.lastDetailDir.copy(this.v)
    // the nearest cells in view (a little beyond its edges, so turning does not show them popping in)
    const near: [number, number][] = []
    const p = m.pos
    const far2 = DETAIL_FAR * DETAIL_FAR
    this.camera.updateMatrixWorld()
    const e = this.camera.matrixWorldInverse.elements
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.25
    const tanX = tanY * this.camera.aspect
    for (let i = 0; i < m.count; i++) {
      const x = p[i * 3]
      const y = p[i * 3 + 1]
      const z = p[i * 3 + 2]
      const d = (x - cam.x) ** 2 + (y - cam.y) ** 2 + (z - cam.z) ** 2
      if (d > far2) continue
      // in camera space: in front, and inside the (widened) view
      const vx = e[0] * x + e[4] * y + e[8] * z + e[12]
      const vy = e[1] * x + e[5] * y + e[9] * z + e[13]
      const vz = -(e[2] * x + e[6] * y + e[10] * z + e[14])
      if (vz < 0.2 || Math.abs(vx) > vz * tanX + 0.8 || Math.abs(vy) > vz * tanY + 0.8) continue
      near.push([d, i])
    }
    near.sort((a, b) => a[0] - b[0])
    const want = new Set(near.slice(0, DETAIL_MAX).map((x) => x[1]))
    const g = this.grown
    for (const [i, d] of this.details) {
      if (want.has(i)) continue
      this.dropDetail(d)
      this.details.delete(i)
      if (g) g.array[i] = 0
    }
    let built = 0
    for (const i of want) {
      if (this.details.has(i)) continue
      if (built++ >= 3) {
        this.lastDetailCheck.set(1e9, 0, 0) // the rest next frame (no long frame)
        break
      }
      this.details.set(i, this.grow(i))
      if (g) g.array[i] = 1
    }
    if (g) g.needsUpdate = true
  }

  private dropDetail(d: Detail) {
    this.scene.remove(d.group)
    d.geos.forEach((x) => x.dispose())
    d.mats.forEach((x) => x.dispose())
    d.group.children.forEach((c) => ((c as THREE.Points).material as THREE.Material).dispose())
  }

  private grow(i: number): Detail {
    const m = this.model!
    const h = m.info[i * 4]
    const s = m.info[i * 4 + 1]
    const kind = m.info[i * 4 + 2]
    const seed = m.info[i * 4 + 3]
    const pos = new THREE.Vector3().fromArray(m.pos, i * 3)
    const j = this.partner[i]
    let toward: [number, number, number] | null = null
    let far = 1
    if (j >= 0) {
      const q = new THREE.Vector3().fromArray(m.pos, j * 3).sub(pos)
      far = q.length()
      toward = [q.x, q.y, q.z]
    }
    const mo = growNeuron(h, s, kind, seed, toward, far)
    const color = new THREE.Color(this.colors[i * 3], this.colors[i * 3 + 1], this.colors[i * 3 + 2])
    const per = kind === KIND_NEW ? 10 : kind === 1 ? 6 : kind === KIND_PARKED ? 1e6 : 9 + (2.4 - 9) * h * h * (0.3 + 0.7 * s)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(mo.pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(mo.normal, 3))
    g.setAttribute('aPart', new THREE.BufferAttribute(mo.part, 1))
    g.setAttribute('aAx', new THREE.BufferAttribute(mo.ax, 1))
    g.setIndex(new THREE.BufferAttribute(mo.index, 1))
    const own = {
      uColor: { value: color },
      uPer: { value: per },
      uSeed: { value: seed },
      uH: { value: kind === KIND_REVIEW || kind === 1 ? h : 0.6 },
      uFade: { value: 0 },
      uNodes: { value: mo.nodes },
      uFire: { value: kind === KIND_NEW ? 0.35 : kind === 1 ? 0.5 : kind === KIND_PARKED ? 0 : 1 },
    }
    const mat = new THREE.ShaderMaterial({ vertexShader: CELL_VS, fragmentShader: CELL_FS, uniforms: { ...own, uTime: this.uniforms.uTime }, ...additive, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(g, mat)
    mesh.frustumCulled = false
    const dg = new THREE.BufferGeometry()
    const n = mo.dots.length / 5
    const dp = new Float32Array(n * 3)
    const dd = new Float32Array(n * 2)
    for (let k = 0; k < n; k++) {
      dp.set(mo.dots.subarray(k * 5, k * 5 + 3), k * 3)
      dd[k * 2] = mo.dots[k * 5 + 3]
      dd[k * 2 + 1] = mo.dots[k * 5 + 4]
    }
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3))
    dg.setAttribute('aDot', new THREE.BufferAttribute(dd, 2))
    const dm = new THREE.ShaderMaterial({
      vertexShader: DOT_VS,
      fragmentShader: DOT_FS,
      uniforms: { uColor: own.uColor, uFade: own.uFade, uH: own.uH, uPx: this.uniforms.uPx },
      ...additive,
    })
    const dots = new THREE.Points(dg, dm)
    dots.frustumCulled = false
    const group = new THREE.Group()
    group.position.copy(pos)
    group.add(mesh, dots)
    group.renderOrder = 4
    this.scene.add(group)
    // both materials share uFade (one object)
    return { group, mats: [mat], geos: [g, dg], used: this.frame }
  }

  private clearDetails() {
    for (const d of this.details.values()) this.dropDetail(d)
    this.details.clear()
    if (this.grown) {
      ;(this.grown.array as Float32Array).fill(0)
      this.grown.needsUpdate = true
    }
    this.lastDetailCheck.set(1e9, 0, 0)
  }

  // ---------- the loop ----------

  private wake = () => {
    this.idleSince = this.clock
    if (!this.raf && !this.paused && !this.hidden) {
      this.last = performance.now()
      this.raf = requestAnimationFrame(this.loop)
    }
  }

  private loop = (now: number) => {
    this.raf = 0
    if (this.paused || this.hidden) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000))
    // nothing touched for a while: every other frame is enough (the cells still fire)
    const idle = this.clock - this.idleSince > 4 && !this.fly
    if (idle && this.frame % 2 === 1 && dt < 0.03) {
      this.frame++
      return
    }
    this.last = now
    this.clock += dt
    this.frame++
    const u = this.uniforms
    u.uTime.value = this.clock
    u.uIntro.value = Math.min(1, u.uIntro.value + dt / 2.2)
    if (this.morphStart >= 0) {
      u.uMorph.value = Math.min(1, (this.clock - this.morphStart) / 1.4)
      if (u.uMorph.value >= 1) this.morphStart = -1
    }
    if (this.fly) {
      const f = this.fly
      const k = Math.min(1, (this.clock - f.t0) / f.dur)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      this.controls.target.lerpVectors(f.ft, f.tt, e)
      this.camera.position.lerpVectors(f.fc, f.tc, e)
      if (k >= 1) this.fly = null
    }
    this.controls.update(dt)
    u.uFocus.value = this.camera.position.distanceTo(this.controls.target)
    if (this.model) {
      // how much of the screen the glows of the cells in view cover, roughly
      const px = (0.9 * u.uPx.value) / Math.max(1, u.uFocus.value)
      const near = this.model.count * Math.min(1, (u.uFocus.value / Math.max(1, 1.5 * this.model.radius)) ** 3) + 30
      const area = 4 * u.uView.value.x * u.uView.value.y
      u.uGain.value = Math.max(0.28, Math.min(1, 1 / (1 + (near * px * px) / area)))
    }
    this.updateDetails()
    this.cullShells()
    this.pickLabels()
    this.placeLabels()
    this.renderer.render(this.scene, this.camera)

    // a slow phone: fewer pixels (never below 1 per CSS pixel); frames halved on purpose do not count
    if (idle) this.slow = 0
    else if (dt > 0.026) this.slow++
    else this.slow = Math.max(0, this.slow - 1)
    if (this.slow > 45 && this.ratio > 1) {
      this.ratio = Math.max(1, this.ratio - 0.25)
      this.slow = 0
      this.resize()
    }
  }

  private resize() {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (!w || !h) return
    this.renderer.setPixelRatio(this.ratio)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    const bh = h * this.ratio
    this.uniforms.uPx.value = bh / 2 / Math.tan((this.camera.fov * Math.PI) / 360)
    this.uniforms.uView.value.set(w * this.ratio * 0.5, h * this.ratio * 0.5)
    this.uniforms.uDpr.value = this.ratio
    this.pickLabels(true)
    this.wake()
  }

  private onVis = () => {
    this.hidden = document.hidden
    this.wake()
  }
  private onLost = (e: Event) => e.preventDefault()
  private onRestored = () => {
    const m = this.model
    if (m) {
      this.model = null
      this.disposeObj(this.dust)
      this.dust = null
      this.setModel(m, Date.now())
    }
  }

  private disposeObj(o: THREE.Mesh | THREE.Points | null) {
    if (!o) return
    this.scene.remove(o)
    o.geometry.dispose()
    ;(o.material as THREE.Material).dispose()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.paused = true
    this.ro.disconnect()
    document.removeEventListener('visibilitychange', this.onVis)
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointerup', this.onUp)
    this.canvas.removeEventListener('pointercancel', this.onCancel)
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    this.clearDetails()
    this.disposeObj(this.neurons)
    this.disposeObj(this.motes)
    this.disposeObj(this.links)
    this.disposeObj(this.shells)
    this.disposeObj(this.dust)
    this.disposeObj(this.sel)
    this.controls.dispose()
    this.renderer.dispose()
    for (const l of this.labels) l.el.remove()
    this.selLabel.remove()
  }
}
