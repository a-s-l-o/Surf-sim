import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

export interface SkyRig {
  sky: Sky;
  sunDir: THREE.Vector3;
  sunLight: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fogColor: THREE.Color;
}

/**
 * Morning at Bells: sun still lowish out over the water to the east,
 * a light haze on the horizon. The water shader reproduces this sky
 * analytically for reflections, so keep the two in sync via sunDir.
 */
export function createSky(scene: THREE.Scene): SkyRig {
  const sky = new Sky();
  sky.scale.setScalar(45000);
  scene.add(sky);

  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = 4;
  uniforms.rayleigh.value = 1.3;
  uniforms.mieCoefficient.value = 0.004;
  uniforms.mieDirectionalG.value = 0.8;

  // Elevation 28° — mid-morning; azimuth ~100° puts the sun out over the
  // ocean to the east-southeast, raking light across the wave faces.
  const elevation = 28;
  const azimuth = 100;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  uniforms.sunPosition.value.copy(sunDir);

  const sunLight = new THREE.DirectionalLight(0xfff2dd, 2.6);
  sunLight.position.copy(sunDir).multiplyScalar(1000);
  scene.add(sunLight);

  const hemi = new THREE.HemisphereLight(0xbcd8e8, 0x54432e, 0.75);
  scene.add(hemi);

  const fogColor = new THREE.Color(0xcfe0e8);
  scene.fog = new THREE.FogExp2(fogColor, 0.00016);

  return { sky, sunDir, sunLight, hemi, fogColor };
}
