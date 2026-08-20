import * as THREE from "three";

export interface Surfer {
  group: THREE.Group;
  /** popup: 0 = prone, 1 = standing. lean: -1..1 carve roll. */
  update(
    pos: THREE.Vector3,
    heading: number,
    popup: number,
    lean: number,
    slopePitch: number,
    visible: boolean
  ): void;
}

/**
 * Low-poly surfer built from primitives (the repo stays self-contained —
 * no model downloads): a board plus a rider whose torso/limbs lerp between
 * a prone paddling pose and a standing crouch.
 */
export function createSurfer(): Surfer {
  const group = new THREE.Group();

  const boardMat = new THREE.MeshStandardMaterial({
    color: 0xf3efe6,
    roughness: 0.5,
  });
  const stripeMat = new THREE.MeshStandardMaterial({
    color: 0xc23b2e,
    roughness: 0.5,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xc98d5f,
    roughness: 0.8,
  });
  const suitMat = new THREE.MeshStandardMaterial({
    color: 0x16222b,
    roughness: 0.85,
  });

  // Board: tapered slab, nose toward -z (board forward).
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.07, 1.95), boardMat);
  board.geometry.translate(0, 0, 0);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.075, 1.95), stripeMat);
  group.add(board, stripe);

  // Rider rig.
  const rider = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.45, 4, 8), suitMat);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), skinMat);
  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.5, 3, 6), suitMat);
  const armR = armL.clone();
  const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.5, 3, 6), suitMat);
  const legR = legL.clone();
  rider.add(torso, head, armL, armR, legL, legR);
  group.add(rider);

  interface Pose {
    torsoPos: THREE.Vector3;
    torsoRotX: number;
    headPos: THREE.Vector3;
    armL: { pos: THREE.Vector3; rot: THREE.Euler };
    armR: { pos: THREE.Vector3; rot: THREE.Euler };
    legL: { pos: THREE.Vector3; rot: THREE.Euler };
    legR: { pos: THREE.Vector3; rot: THREE.Euler };
  }

  // Prone: chest on the board, arms paddling forward, legs trailing aft.
  const prone: Pose = {
    torsoPos: new THREE.Vector3(0, 0.2, 0.1),
    torsoRotX: Math.PI / 2 - 0.12,
    headPos: new THREE.Vector3(0, 0.32, -0.35),
    armL: { pos: new THREE.Vector3(-0.28, 0.16, -0.3), rot: new THREE.Euler(1.4, 0, -0.5) },
    armR: { pos: new THREE.Vector3(0.28, 0.16, -0.3), rot: new THREE.Euler(1.4, 0, 0.5) },
    legL: { pos: new THREE.Vector3(-0.11, 0.14, 0.75), rot: new THREE.Euler(1.55, 0, 0) },
    legR: { pos: new THREE.Vector3(0.11, 0.14, 0.75), rot: new THREE.Euler(1.55, 0, 0) },
  };
  // Standing crouch: side-on stance, arms out for balance.
  const stand: Pose = {
    torsoPos: new THREE.Vector3(0, 0.95, 0.05),
    torsoRotX: 0.25,
    headPos: new THREE.Vector3(0, 1.35, -0.02),
    armL: { pos: new THREE.Vector3(-0.4, 0.95, -0.1), rot: new THREE.Euler(0.3, 0, -1.25) },
    armR: { pos: new THREE.Vector3(0.42, 0.9, 0.05), rot: new THREE.Euler(-0.2, 0, 1.2) },
    legL: { pos: new THREE.Vector3(-0.12, 0.4, -0.28), rot: new THREE.Euler(0.35, 0, 0.12) },
    legR: { pos: new THREE.Vector3(0.12, 0.4, 0.32), rot: new THREE.Euler(-0.3, 0, -0.12) },
  };

  const lerpV = new THREE.Vector3();
  function applyPose(k: number) {
    const e = k * k * (3 - 2 * k); // smooth
    torso.position.copy(lerpV.copy(prone.torsoPos).lerp(stand.torsoPos, e));
    torso.rotation.x = THREE.MathUtils.lerp(prone.torsoRotX, stand.torsoRotX, e);
    head.position.copy(lerpV.copy(prone.headPos).lerp(stand.headPos, e));
    for (const [mesh, a, b] of [
      [armL, prone.armL, stand.armL],
      [armR, prone.armR, stand.armR],
      [legL, prone.legL, stand.legL],
      [legR, prone.legR, stand.legR],
    ] as const) {
      mesh.position.copy(lerpV.copy(a.pos).lerp(b.pos, e));
      mesh.rotation.set(
        THREE.MathUtils.lerp(a.rot.x, b.rot.x, e),
        THREE.MathUtils.lerp(a.rot.y, b.rot.y, e),
        THREE.MathUtils.lerp(a.rot.z, b.rot.z, e)
      );
    }
  }
  applyPose(0);

  let lastPopup = -1;
  return {
    group,
    update(pos, heading, popup, lean, slopePitch, visible) {
      group.visible = visible;
      if (!visible) return;
      group.position.set(pos.x, pos.y + 0.12, pos.z);
      group.rotation.set(slopePitch, heading, -lean * 0.45, "YXZ");
      if (Math.abs(popup - lastPopup) > 0.01) {
        applyPose(popup);
        lastPopup = popup;
      }
    },
  };
}
