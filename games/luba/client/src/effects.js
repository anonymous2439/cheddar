// One-shot particle bursts — currently just the blood spray on a landed
// sword hit. CPU-simulated (a plain array of velocities stepped each
// frame, not a shader) since everything else in this game is similarly
// simple hand-rolled dynamics (see physics.js) — the particle counts here
// are small enough that this is nowhere near a bottleneck.
import * as THREE from "three";

const PARTICLE_COUNT = 32;
const LIFETIME_MS = 700;
const SPRAY_SPEED_MIN = 1.8;
const SPRAY_SPEED_MAX = 5;
const SPRAY_GRAVITY = 14; // its own constant, not physics.js's GRAVITY — tuned for how the spray reads, not for player movement feel

// Spawns at (x,y,z) and returns a handle with update(dt) — call it every
// frame; it returns false once the burst has fully faded, at which point
// it has already removed and disposed itself, and the caller should drop
// its reference.
export function spawnBloodSpray(scene, x, y, z) {
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const velocities = new Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    // Roughly horizontal outward cone with an upward bias — reads as a
    // burst thrown off the blade's swing, not a puff drifting up.
    const angle = Math.random() * Math.PI * 2;
    const speed = SPRAY_SPEED_MIN + Math.random() * (SPRAY_SPEED_MAX - SPRAY_SPEED_MIN);
    velocities[i] = {
      x: Math.cos(angle) * speed,
      y: 1.5 + Math.random() * 2.5,
      z: Math.sin(angle) * speed,
    };
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: "#a3122b",
    size: 0.09,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);

  let elapsedMs = 0;
  return {
    update(dt) {
      elapsedMs += dt * 1000;
      const posAttr = geometry.getAttribute("position");
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const v = velocities[i];
        v.y -= SPRAY_GRAVITY * dt;
        posAttr.array[i * 3] += v.x * dt;
        posAttr.array[i * 3 + 1] += v.y * dt;
        posAttr.array[i * 3 + 2] += v.z * dt;
      }
      posAttr.needsUpdate = true;

      const t = Math.min(1, elapsedMs / LIFETIME_MS);
      material.opacity = 0.95 * (1 - t);
      if (t >= 1) {
        scene.remove(points);
        geometry.dispose();
        material.dispose();
        return false;
      }
      return true;
    },
  };
}

const DASH_PARTICLE_COUNT = 20;
const DASH_LIFETIME_MS = 350;
const DASH_SPEED_MIN = 1.5;
const DASH_SPEED_MAX = 3.5;
// A light backward drift, not blood's real gravity — this is meant to
// look like it's being left behind by the dash, not falling to the
// ground.
const DASH_DRIFT = 0.6;

// Spawns at (x,y,z), streaking opposite the dash's own direction
// (dirX,dirZ) — reads as a burst of speed left behind mid-dash. Same
// update(dt)/lifetime contract as spawnBloodSpray.
export function spawnDashEffect(scene, x, y, z, dirX, dirZ) {
  const positions = new Float32Array(DASH_PARTICLE_COUNT * 3);
  const velocities = new Array(DASH_PARTICLE_COUNT);
  const len = Math.hypot(dirX, dirZ) || 1;
  const backX = -dirX / len;
  const backZ = -dirZ / len;
  for (let i = 0; i < DASH_PARTICLE_COUNT; i++) {
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    // Mostly straight back, with a little sideways/vertical spread so it
    // reads as a small cloud, not a single line.
    const speed = DASH_SPEED_MIN + Math.random() * (DASH_SPEED_MAX - DASH_SPEED_MIN);
    const spread = (Math.random() - 0.5) * 1.2;
    velocities[i] = {
      x: backX * speed + backZ * spread,
      y: (Math.random() - 0.3) * 1.2,
      z: backZ * speed - backX * spread,
    };
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: "#bae6fd",
    size: 0.07,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);

  let elapsedMs = 0;
  return {
    update(dt) {
      elapsedMs += dt * 1000;
      const posAttr = geometry.getAttribute("position");
      for (let i = 0; i < DASH_PARTICLE_COUNT; i++) {
        const v = velocities[i];
        v.y -= DASH_DRIFT * dt;
        posAttr.array[i * 3] += v.x * dt;
        posAttr.array[i * 3 + 1] += v.y * dt;
        posAttr.array[i * 3 + 2] += v.z * dt;
      }
      posAttr.needsUpdate = true;

      const t = Math.min(1, elapsedMs / DASH_LIFETIME_MS);
      material.opacity = 0.85 * (1 - t);
      if (t >= 1) {
        scene.remove(points);
        geometry.dispose();
        material.dispose();
        return false;
      }
      return true;
    },
  };
}

// Smoke skill's cloud — two meshes sharing one sphere geometry, exploiting
// ordinary WebGL backface culling for the asymmetric visibility effect
// (see games/luba/api/app/main.py's own comment):
//
// - The OUTER mesh uses the default THREE.FrontSide, which only ever
//   renders a sphere's *outward*-facing surface. From outside the sphere
//   that's exactly the surface facing the camera, so it renders as a
//   solid-ish cloud blocking anything behind it. From *inside*, every
//   visible triangle is facing away (a backface), which FrontSide culls
//   entirely — so this mesh contributes nothing there.
// - The INNER mesh uses THREE.BackSide instead — the mirror image: it
//   renders only from inside the sphere (where those same triangles are
//   backfaces relative to the camera), as a faint, low-opacity wall, so
//   the player standing inside can still tell the cloud is there and see
//   its boundary, without it meaningfully blocking their own view out.
//   renderOrder ensures the outer mesh's depth is written first, so from
//   *outside* the inner mesh's far-side backfaces correctly fail the
//   depth test and never show through — it stays invisible from outside,
//   same as before.
//
// No per-viewer logic needed: this is just what each mesh looks like from
// each side, for free.
const SMOKE_GEOMETRY_SEGMENTS = 20;
const SMOKE_OUTER_OPACITY = 0.93;
const SMOKE_INNER_OPACITY = 0.22;

export function spawnSmokeCloud(scene, x, y, z, radius, durationMs) {
  const geometry = new THREE.SphereGeometry(radius, SMOKE_GEOMETRY_SEGMENTS, SMOKE_GEOMETRY_SEGMENTS * 0.75);

  const outerMaterial = new THREE.MeshBasicMaterial({
    color: "#d1d5db",
    transparent: true,
    opacity: SMOKE_OUTER_OPACITY,
    fog: false,
  });
  const outerMesh = new THREE.Mesh(geometry, outerMaterial);
  outerMesh.position.set(x, y, z);
  outerMesh.renderOrder = 0;
  scene.add(outerMesh);

  const innerMaterial = new THREE.MeshBasicMaterial({
    color: "#d1d5db",
    transparent: true,
    opacity: SMOKE_INNER_OPACITY,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const innerMesh = new THREE.Mesh(geometry, innerMaterial);
  innerMesh.position.set(x, y, z);
  innerMesh.renderOrder = 1; // after the outer mesh, so its depth is already written — see the comment above
  scene.add(innerMesh);

  const fadeInMs = 250;
  const fadeOutMs = 600;
  let elapsedMs = 0;
  return {
    update(dt) {
      elapsedMs += dt * 1000;
      let frac;
      if (elapsedMs < fadeInMs) frac = elapsedMs / fadeInMs;
      else if (elapsedMs > durationMs - fadeOutMs) frac = Math.max(0, (durationMs - elapsedMs) / fadeOutMs);
      else frac = 1;
      outerMaterial.opacity = SMOKE_OUTER_OPACITY * frac;
      innerMaterial.opacity = SMOKE_INNER_OPACITY * frac;
      if (elapsedMs >= durationMs) {
        scene.remove(outerMesh);
        scene.remove(innerMesh);
        geometry.dispose();
        outerMaterial.dispose();
        innerMaterial.dispose();
        return false;
      }
      return true;
    },
  };
}
