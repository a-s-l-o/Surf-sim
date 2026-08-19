import { NUM_SWELL, NUM_WAVES } from "../config";

/**
 * Gerstner swell + chop with bathymetry-driven shoaling and breaking.
 *
 * Each vertex samples the baked Bells bathymetry. As a swell component runs
 * into shallow water its wavelength shortens (phase slows per the dispersion
 * relation), its amplitude grows (Green's law approximation), its crest
 * sharpens, and once it exceeds the breaking index (H ≈ 0.8·depth) it spills:
 * amplitude is soft-clamped and the crest is flagged as foam. Because the
 * reef finger is shallower than the channel beside it, the break point of an
 * incoming crest travels sideways along the wave — the peel.
 */
export const oceanVertexShader = /* glsl */ `
#define NUM_WAVES ${NUM_WAVES}
#define NUM_SWELL ${NUM_SWELL}

uniform float uTime;
uniform float uSetGain;
uniform vec2 uWaveDir[NUM_WAVES];
// x: k (2π/λ), y: base amplitude, z: Q displacement factor, w: omega
uniform vec4 uWaveData[NUM_WAVES];

attribute float terrainH;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vCrest;
varying float vDepth;

void main() {
  vec2 wp = position.xz;
  float hTer = terrainH;
  float depth = max(0.05, -hTer);

  vec3 disp = vec3(0.0);
  float nx = 0.0, nz = 0.0, ny = 0.0;
  float foam = 0.0;
  float crest = 0.0;

  for (int i = 0; i < NUM_WAVES; i++) {
    vec2 dir = uWaveDir[i];
    float k = uWaveData[i].x;
    float amp = uWaveData[i].y;
    float Q = uWaveData[i].z;
    float omega = uWaveData[i].w;
    float phase;

    if (i < NUM_SWELL) {
      amp *= uSetGain;
      float kd = k * depth;
      float tkd = clamp(tanh(kd), 0.06, 1.0);
      // Shallow water: slower phase speed -> shorter waves...
      float refr = inversesqrt(tkd);
      // ...and taller ones (approximate Green's law), until they break.
      float shoal = min(refr, 2.2);
      amp *= shoal;
      float aMax = 0.48 * depth;
      float over = amp / aMax;
      float breaking = smoothstep(0.7, 1.25, over);
      amp = min(amp, aMax * (1.0 + 0.25 * smoothstep(1.0, 2.2, over)));
      // Pitch the lip forward as it stands up on the reef.
      Q *= 1.0 + 1.0 * smoothstep(0.5, 1.05, over);
      phase = k * refr * dot(dir, wp) - omega * uTime;
      float crestness = 0.5 + 0.5 * sin(phase);
      // Whitewater where it breaks, plus a thin feathering line on crests
      // that are about to.
      float feather = smoothstep(0.55, 0.85, over) * pow(crestness, 9.0) * 0.75;
      foam = max(foam, max(breaking * pow(crestness, 3.0), feather));
      crest += amp * max(sin(phase), 0.0);
    } else {
      phase = k * dot(dir, wp) - omega * uTime;
    }

    float s = sin(phase);
    float c = cos(phase);
    float wa = k * amp;
    disp += vec3(Q * amp * dir.x * c, amp * s, Q * amp * dir.y * c);
    nx += dir.x * wa * c;
    nz += dir.y * wa * c;
    ny += Q * wa * s;
  }

  vec3 pos = vec3(wp.x, 0.0, wp.y) + disp;
  // Don't let troughs dig into the seabed; over real land, drop the sheet
  // just below sea level so the terrain hides it (never raise it to the
  // terrain height — that builds a water curtain along the coastline).
  pos.y = max(pos.y, -depth + 0.15);
  if (hTer > 0.4) pos.y = -2.0;

  vNormal = normalize(vec3(-nx, 1.0 - ny, -nz));
  vWorldPos = pos;
  vFoam = foam;
  vCrest = crest;
  vDepth = depth;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;
