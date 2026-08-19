/**
 * Water surface shading: analytic sky reflection with fresnel, depth-based
 * color over the real bathymetry, subsurface glow in backlit crests, detail
 * ripple normals, breaking + shorebreak foam, sun glint, fog. Tone mapping
 * is done in-shader (approx ACES + gamma) to match the renderer's pipeline
 * for the built-in materials.
 */
export const oceanFragmentShader = /* glsl */ `
precision highp float;

uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform sampler2D uNoise;
uniform sampler2D uFoamTex;
uniform float uTime;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSssColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uExposure;
uniform float uDebug;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vCrest;
varying float vDepth;

vec3 skyColor(vec3 rd) {
  float t = pow(clamp(rd.y, 0.0, 1.0), 0.5);
  vec3 horizon = vec3(0.44, 0.6, 0.76);
  vec3 zenith = vec3(0.13, 0.34, 0.65);
  vec3 c = mix(horizon, zenith, t);
  float s = max(dot(rd, uSunDir), 0.0);
  c += vec3(1.0, 0.92, 0.72) * (pow(s, 500.0) * 4.0 + pow(s, 12.0) * 0.06);
  return c;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  if (uDebug > 0.5 && uDebug < 1.5) {
    vec3 dc = vDepth < 1.0 ? vec3(1.0, 0.1, 0.1)
      : vDepth < 3.0 ? vec3(1.0, 0.9, 0.1)
      : vDepth < 6.0 ? vec3(0.1, 0.9, 0.2)
      : vDepth < 12.0 ? vec3(0.1, 0.4, 1.0)
      : vec3(0.05, 0.05, 0.4);
    gl_FragColor = vec4(dc, 1.0);
    return;
  }
  vec3 view = vWorldPos - uCamPos;
  float dist = length(view);
  vec3 viewDir = view / dist;

  // Detail ripples: two scrolling samples of the tileable normal map.
  vec2 wuv = vWorldPos.xz;
  vec3 dn1 = texture2D(uNoise, wuv * 0.13 + vec2(uTime * 0.03, uTime * 0.019)).rgb * 2.0 - 1.0;
  vec3 dn2 = texture2D(uNoise, wuv * 0.035 - vec2(uTime * 0.011, -uTime * 0.014)).rgb * 2.0 - 1.0;
  float detailFade = exp(-dist * 0.004); // ripples fade with distance
  // Exaggerate the geometric swell slopes for shading definition.
  vec3 N = normalize(
    vec3(vNormal.x * 1.8, vNormal.y, vNormal.z * 1.8)
      + (vec3(dn1.x, 0.0, dn1.y) * 0.17 + vec3(dn2.x, 0.0, dn2.y) * 0.11) * detailFade
  );

  // Base water color over the real bathymetry.
  float depthFade = 1.0 - exp(-vDepth * 0.30);
  vec3 base = mix(uShallowColor, uDeepColor, depthFade);
  float sunDiff = max(dot(N, uSunDir), 0.0);
  vec3 lit = base * (0.55 + 0.75 * sunDiff);

  // Light through the back of a standing-up crest.
  float backlight = pow(max(dot(viewDir, uSunDir), 0.0), 3.0);
  lit += uSssColor * (backlight * clamp(vCrest * 0.55, 0.0, 1.4) * (1.0 - 0.5 * depthFade));

  // Sky reflection with fresnel.
  vec3 refl = skyColor(reflect(viewDir, N));
  float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-viewDir, N), 0.0), 5.0);
  // Keep sea color at grazing angles, and make the aerated shorebreak zone
  // diffuse rather than mirror-flat.
  fresnel = min(fresnel, mix(0.28, 0.55, clamp(vDepth / 1.6, 0.0, 1.0)));
  vec3 col = mix(lit, refl, fresnel);

  // Foam: breaking crests from the vertex stage + shorebreak whitewater.
  // The shore band pulses with passing waves (vCrest) and is broken up by
  // two scales of the drifting foam texture so it reads as patchy suds,
  // not a solid white sheet.
  vec4 foamTex = texture2D(uFoamTex, wuv * 0.045 + vec2(uTime * 0.012, -uTime * 0.016));
  float foamBig = texture2D(uFoamTex, wuv.yx * 0.013 + vec2(uTime * 0.005, uTime * 0.007)).a;
  float shore = smoothstep(0.9, 0.15, vDepth) * (0.15 + 0.85 * foamBig)
    * (0.3 + 0.7 * clamp(vCrest * 0.8, 0.0, 1.0)) * 0.75;
  float foamAmt = clamp(vFoam * 1.25 + shore, 0.0, 1.0);
  float foamMask = smoothstep(0.36, 0.62, foamAmt * (0.45 + 0.55 * foamTex.a));
  vec3 foamCol = vec3(0.97, 0.99, 1.0) * (0.68 + 0.42 * sunDiff);
  if (uDebug > 1.5 && uDebug < 2.5) { gl_FragColor = vec4(vec3(foamMask), 1.0); return; }
  if (uDebug > 2.5 && uDebug < 3.5) { gl_FragColor = vec4(pow(aces(lit * uExposure), vec3(1.0/2.2)), 1.0); return; }
  if (uDebug > 3.5 && uDebug < 4.5) { gl_FragColor = vec4(pow(aces(refl * fresnel * uExposure), vec3(1.0/2.2)), 1.0); return; }
  if (uDebug > 4.5) { gl_FragColor = vec4(vNormal * 0.5 + 0.5, 1.0); return; }
  col = mix(col, foamCol, foamMask);

  // Aerial haze toward the horizon.
  float fogF = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  col = mix(col, uFogColor, fogF);

  // Translucent in the shallows so the sand reads through the shorebreak.
  float alpha = mix(0.6, 1.0, clamp(vDepth / 2.2, 0.0, 1.0));
  alpha = max(alpha, fresnel);
  alpha = max(alpha, foamMask * 0.97);

  col = pow(aces(col * uExposure), vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, alpha);
}
`;
