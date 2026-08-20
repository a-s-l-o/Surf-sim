import * as THREE from "three";

export interface FollowCamera {
  camera: THREE.PerspectiveCamera;
  /** Jump to a pose (used to blend smoothly out of first person). */
  snapTo(position: THREE.Vector3, quaternion: THREE.Quaternion): void;
  update(
    dt: number,
    target: THREE.Vector3,
    heading: number,
    lean: number
  ): void;
  resize(width: number, height: number): void;
}

/**
 * Third-person ride camera: sits behind and above the surfer, looking down
 * the line, critically-damped so entering a ride flies smoothly from the
 * first-person pose to the chase pose.
 */
export function createFollowCamera(): FollowCamera {
  const camera = new THREE.PerspectiveCamera(62, 1, 0.4, 30000);
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const smoothLook = new THREE.Vector3();
  let initialized = false;

  return {
    camera,
    snapTo(position, quaternion) {
      camera.position.copy(position);
      camera.quaternion.copy(quaternion);
      smoothLook
        .set(0, 0, -8)
        .applyQuaternion(quaternion)
        .add(position);
      initialized = true;
    },
    update(dt, target, heading, lean) {
      const fx = -Math.sin(heading);
      const fz = -Math.cos(heading);
      desired.set(
        target.x - fx * 5.6,
        target.y + 2.4,
        target.z - fz * 5.6
      );
      lookAt.set(target.x + fx * 5, target.y + 0.9, target.z + fz * 5);
      if (!initialized) {
        camera.position.copy(desired);
        smoothLook.copy(lookAt);
        initialized = true;
      }
      const k = 1 - Math.exp(-dt * 3.4);
      camera.position.lerp(desired, k);
      smoothLook.lerp(lookAt, k);
      camera.up.set(Math.sin(-lean * 0.12), 1, 0).normalize();
      camera.lookAt(smoothLook);
    },
    resize(width, height) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
  };
}
