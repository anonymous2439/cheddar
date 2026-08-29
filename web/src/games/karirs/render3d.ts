// A second, optional view of the exact same race data `render.ts` draws —
// same `Playback` (positions/shouting), same `RACER_COLORS`, same
// `FINISH_LINE` scale. This module only maps that 1D scalar position onto a
// straight 3D corridor (no new simulation data needed — see the karirs 3D
// complexity assessment: the server already produces continuous per-tick
// position data, so this is purely a rendering-layer addition). The 2D
// canvas stays as the primary/authoritative view; this is a from-scratch
// alternate view, not a replacement.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { FINISH_LINE, RACER_COLORS } from "./render";
import type { Playback } from "./render";

// World units, not track-position units (0-100) — chosen purely for a
// pleasant-looking corridor, unrelated to FINISH_LINE's own scale.
const TRACK_LENGTH = 44;
const RUNOFF = 6; // past the finish line, so blocks don't run off the world's edge
const LANE_WIDTH = 1.6;
const RAIL_Z = LANE_WIDTH * 4.6; // how far out the side rails/finish posts sit, in either direction

// Gait tuning — all driven by a racer's own instantaneous speed (position's
// 0-100/sec scale, derived by finite-differencing playback each frame),
// not a fixed "always sprinting" cadence. `race.py`'s SPEED_RANGE tops out
// at 2.0 per ~300ms tick — about 6.7/sec — so that's used as "full sprint"
// for normalizing; a betting favorite's boosted speed_factor can run a
// little hotter than that, which just reads as an even quicker cadence
// (clamped enough that it never looks broken, not clamped so hard it caps
// out looking identical to an average racer).
const SPRINT_SPEED = 6.7;
// Below this speed the racer is considered stopped outright — holds a
// neutral standing pose instead of an imperceptibly-slow crawl-cycle.
const STOP_SPEED_THRESHOLD = 0.35;
const WALK_GAIT_FREQUENCY = 3.5;
const SPRINT_GAIT_FREQUENCY = 9;
const SPRINT_STRIDE = 0.55;
const SPRINT_BOUNCE = 0.12;
const HEAD_BOB = 0.055;

// "Barely moving" gets its own distinct pose rather than just reading as a
// smaller version of a normal walk — below this speed (but still above
// STOP_SPEED_THRESHOLD, i.e. not fully stopped) a racer looks winded:
// hunched over, hands on knees, head hanging, chest visibly heaving.
const EXHAUSTED_SPEED_THRESHOLD = 1.4;
const EXHAUSTED_LEAN = 0.38;
// Additive on top of the torso's own lean above (the head is a child of
// the torso — see buildRacerRig — so it inherits that lean before this
// extra tilt is applied), so this is intentionally smaller than it looks
// in isolation.
const EXHAUSTED_HEAD_DROOP = 0.22;
const EXHAUSTED_ARM_FORWARD = -1.05;
const EXHAUSTED_TREMBLE = 0.06;
const EXHAUSTED_BREATH_FREQUENCY = 2.6;
const EXHAUSTED_BREATH_AMPLITUDE = 0.05;

// The signature-move "shouting" flag gets its own pose instead of just a
// color glow: a slight forward lean (head included, via the same
// torso-parenting above) with arms swept backward — as if moving too fast
// for them to do anything but trail behind, not a wide flung-out spread.
const NINJA_LEAN = 0.16;
const NINJA_ARM_TRAIL = 1.2;
// How fast a rig eases into/out of the exhausted/ninja poses — an
// exponential approach rate (bigger = snappier, smaller = more gradual),
// not a duration, so it stays frame-rate independent.
const POSE_EASE_RATE = 4;

// How much a racer's position (0-100 scale) has to lead the currently
// "focused" racer by before the leader-follow camera swaps targets —
// without this, two racers trading the lead within a fraction of a track
// unit each tick would whip the camera back and forth every frame.
const LEADER_SWITCH_MARGIN = 1.5;
// Per-frame interpolation factor for both camera modes — every camera move
// (a mode toggle, or the leader-follow target changing) glides instead of
// snapping.
const CAMERA_DAMPING = 0.07;

// Close enough that the head fills most of a small square thumbnail
// without needing an unusually narrow FOV (which would flatten/distort the
// face at this range). Tight enough that only the very top of the
// shoulders — not the arms — peeks in at the bottom of frame.
const FACE_CAM_DISTANCE = 1.3;
const FACE_CAM_FOV = 40;
// How far below the head's own center to aim/frame — just a touch, so the
// face stays centered in the square rather than being pushed up near the
// top edge, with only a sliver of shoulder below it instead of torso/arms.
const FACE_CAM_AIM_DROP = 0.05;
// The torso's own Y position within the rig group — shared with
// buildRacerRig so the face-cam's math (which needs a group-relative
// height, not the torso-relative one rig.headBaseY stores) stays in sync
// with it rather than duplicating the number.
const TORSO_Y = 0.82;

// Stadium crowd — purely cosmetic set dressing, no simulation data behind
// it (unlike everything else in this file). Two InstancedMeshes (bodies,
// heads) rather than one mesh per person: hundreds of individual meshes
// would be hundreds of draw calls, instancing collapses that to two,
// regardless of how dense the crowd is.
const CROWD_COLORS = ["#f59e0b", "#3b82f6", "#ef4444", "#10b981", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#eab308", "#0ea5e9"];
const CROWD_TIERS = 4;
const CROWD_TIER_DEPTH = 0.55;
const CROWD_TIER_HEIGHT = 0.42;
const CROWD_TIER_GAP = 0.35; // gap between the rail and the first tier
const CROWD_PERSON_SPACING = 0.5;
const CROWD_BODY_W = 0.3;
const CROWD_BODY_H = 0.5;
const CROWD_BODY_D = 0.25;
const CROWD_HEAD_R = 0.14;
// Idle sway vs. an excited cheer (a signature move firing, or the race
// just having resolved) — same sine-bob technique as the racers' own
// running animation, just applied to a crowd instead of a gait.
const CROWD_IDLE_BOB = 0.02;
const CROWD_EXCITED_BOB = 0.16;
const CROWD_BOB_FREQUENCY = 5;

// Distant skyline + sky dressing — purely atmospheric, sit well outside
// the stadium ring so they never compete with anything gameplay-relevant.
// Fog (already set up for the stadium) does a lot of the "distant hazy
// city" work here for free once these are placed far enough out.
const CITY_COLORS = ["#94a3b8", "#9aa5b1", "#8592a1", "#a3adb8", "#7e8b99", "#8d99a6"];
// Generous — the overview camera itself sits at Z≈15, only a little
// further out than the crowd ring, so a small gap here would put the
// skyline uncomfortably close to (or even behind) that camera instead of
// reading as a backdrop.
const CITY_RING_GAP = 20;
const CITY_BUILDING_SPACING = 3.4;

export type Karirs3DCameraMode = "overview" | "chase" | "front";

export interface Karirs3DUpdateParams {
  racerNames: string[];
  playback: Playback;
  winningName: string | null;
  isResolved: boolean;
  myBetRacerName: string | null;
  // Static link for now (no upload flow yet) — null for a racer with
  // nothing set, which just keeps the plain colored head + eye dots.
  faceImageUrls: Record<string, string | null>;
}

export interface Karirs3DScene {
  update(params: Karirs3DUpdateParams): void;
  setCameraMode(mode: Karirs3DCameraMode): void;
  // Cheap to call every frame — internally a no-op for any racer whose
  // canvas element hasn't actually changed since the last call, so the
  // caller doesn't need its own bookkeeping for when the roster/DOM
  // changes. Passing a smaller map than before disposes the dropped ones.
  setFaceCanvases(canvases: Map<string, HTMLCanvasElement>): void;
  dispose(): void;
}

interface RacerRig {
  group: THREE.Group;
  torso: THREE.Mesh;
  torsoMaterial: THREE.MeshStandardMaterial;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  marker: THREE.Mesh; // small floating ring over "my bet"'s racer
  leftEye: THREE.Mesh;
  rightEye: THREE.Mesh;
  faceDecal: THREE.Mesh; // hidden until/unless a face image actually loads
  head: THREE.Mesh;
  headBaseY: number; // head's resting height *relative to the torso* (its parent), before the running-bob offset
  // Running-gait state, all persisted frame-to-frame so the animation
  // reacts to this racer's own actual speed instead of a fixed cadence:
  // prevPos is last frame's raw position (0-100 scale), used to derive
  // instantaneous speed by finite difference; gaitPhase only advances
  // while actually moving, so slowing down doesn't just shrink the stride,
  // it also holds the pose instead of endlessly cycling in place.
  prevPos: number;
  gaitPhase: number;
  // How "into" the exhausted/ninja pose each rig currently is, 0-1 — eased
  // toward whichever state is actually active each frame (see POSE_EASE_RATE)
  // rather than snapping the instant a racer's speed crosses a threshold,
  // so e.g. exhausted-to-running reads as a recovery, not a switch flipping.
  exhaustedBlend: number;
  ninjaBlend: number;
}

function disposeMesh(mesh: THREE.Mesh) {
  mesh.geometry.dispose();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mats.forEach((m) => m.dispose());
}

// Module-level (not per-scene) since the same static link is currently
// shared by every racer in every race — no reason to refetch/redecode the
// same image once it's already loaded. Keyed by URL, so a real per-racer
// upload feature later works the same way with zero cache changes.
const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin("anonymous");
const faceTextureCache = new Map<string, THREE.Texture>();
const facePendingCallbacks = new Map<string, Array<(tex: THREE.Texture) => void>>();

function loadFaceTexture(url: string, onReady: (tex: THREE.Texture) => void) {
  const cached = faceTextureCache.get(url);
  if (cached) {
    onReady(cached);
    return;
  }
  const pending = facePendingCallbacks.get(url);
  if (pending) {
    pending.push(onReady);
    return;
  }
  facePendingCallbacks.set(url, [onReady]);
  textureLoader.load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      faceTextureCache.set(url, tex);
      const callbacks = facePendingCallbacks.get(url) ?? [];
      facePendingCallbacks.delete(url);
      callbacks.forEach((cb) => cb(tex));
    },
    undefined,
    () => {
      // Bad URL, 404, no CORS headers on whatever's hosting it, etc — just
      // leave the decal hidden; the racer keeps its plain colored head.
      facePendingCallbacks.delete(url);
    },
  );
}

// Clouds are painted directly into this backdrop rather than placed as
// real 3D meshes — this scene's cameras all sit fairly low and pitch
// downward at the track, so their frustum's *top* edge sits close to the
// horizon; anything placed at a realistic "high in the sky" world position
// tends to fall above that edge and simply never appears on screen,
// regardless of how far out it's placed. A backdrop always fills the
// whole visible sky no matter the camera's position, so it sidesteps that
// entirely (at the cost of clouds not having real depth/parallax, which
// isn't very noticeable for something this far away regardless).
function makeSkyTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, "#bfe3f7");
  grad.addColorStop(0.55, "#e3f2ec");
  grad.addColorStop(1, "#eef6f0");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  function paintCloud(cx: number, cy: number, scale: number) {
    const puffs: Array<[number, number, number]> = [
      [0, 0, 1],
      [scale * 0.7, scale * 0.08, 0.75],
      [-scale * 0.7, scale * 0.1, 0.7],
      [scale * 0.3, -scale * 0.3, 0.55],
      [-scale * 0.35, -scale * 0.22, 0.55],
    ];
    for (const [dx, dy, s] of puffs) {
      const r = scale * s;
      const gx = cx + dx;
      const gy = cy + dy;
      const puffGrad = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
      puffGrad.addColorStop(0, "rgba(255,255,255,0.95)");
      puffGrad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = puffGrad;
      ctx.beginPath();
      ctx.arc(gx, gy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Kept close to the very top of the canvas (small cy, small scale) —
  // the buildings occupy nearly the whole rest of the frame in practice,
  // leaving only a thin sliver of actual open sky above their rooftops for
  // these to appear in.
  paintCloud(70, 10, 10);
  paintCloud(200, 7, 8);
  paintCloud(330, 12, 11);
  paintCloud(450, 9, 8);
  paintCloud(140, 15, 7);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeCheckerTexture(): THREE.Texture {
  const cell = 8;
  const cols = 2;
  const rows = 16;
  const canvas = document.createElement("canvas");
  canvas.width = cell * cols;
  canvas.height = cell * rows;
  const ctx = canvas.getContext("2d")!;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#171717" : "#fafafa";
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

function makeTextSprite(text: string, options: { color: string; bold?: boolean; strokeColor?: string }): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${options.bold ? "bold " : ""}44px system-ui, sans-serif`;
  ctx.fillStyle = options.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 8;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;
  return sprite;
}

function makeNameSprite(name: string, isMine: boolean): THREE.Sprite {
  const sprite = makeTextSprite(isMine ? `★ ${name.length > 15 ? name.slice(0, 14) + "…" : name}` : name.length > 16 ? name.slice(0, 15) + "…" : name, {
    color: isMine ? "#fbbf24" : "#ffffff",
    bold: isMine,
  });
  sprite.scale.set(2.2, 0.55, 1);
  return sprite;
}

function buildRacerRig(color: string, gaitSeed: number, faceImageUrl: string | null): RacerRig {
  const group = new THREE.Group();
  // Built facing local +Z (legs/arms swing in the local YZ plane) — rotate
  // 90° so that swing plane lines up with world +X, the direction of
  // travel now that progress runs left-to-right instead of into the screen.
  group.rotation.y = Math.PI / 2;

  const torsoMaterial = new THREE.MeshStandardMaterial({ color });
  const torso = new THREE.Mesh(new RoundedBoxGeometry(0.7, 0.9, 0.46, 3, 0.09), torsoMaterial);
  const torsoTop = TORSO_Y + 0.9 / 2;
  torso.position.y = TORSO_Y;
  torso.castShadow = true;
  group.add(torso);

  // Square instead of round — flush with a face-photo decal (no sphere
  // curvature for a flat image to distort around toward the sides), and
  // bigger than the torso would suggest, for a chunky, slightly oversized
  // look. Sits directly on the torso (no neck) — the head-bob animation
  // below is enough on its own to keep it from looking welded on.
  //
  // A child of the TORSO, not the group — torso.rotation.x is how the
  // exhausted/ninja poses lean the upper body, and if the head were a
  // sibling instead of a child, it would just stay locked upright in place
  // while the torso tilted out from under it, reading as the head coming
  // detached rather than the whole upper body leaning together.
  const headMaterial = new THREE.MeshStandardMaterial({ color });
  const headSize = 0.62;
  const headBaseY = torsoTop + headSize / 2 - torso.position.y; // torso-local, not group-local
  const head = new THREE.Mesh(new RoundedBoxGeometry(headSize, headSize, headSize, 3, 0.07), headMaterial);
  head.position.y = headBaseY;
  head.castShadow = true;
  torso.add(head);

  // Eyes and the face decal are children of the head mesh itself (in the
  // head's own local space, not the group's) so they automatically bob
  // along with it every frame for free — no need to re-position them
  // separately in the animation loop below.
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: "#171717" });
  const eyeGeometry = new THREE.SphereGeometry(0.05, 8, 8);
  const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  leftEye.position.set(-0.13, 0.03, headSize / 2 + 0.01);
  const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  rightEye.position.set(0.13, 0.03, headSize / 2 + 0.01);
  head.add(leftEye, rightEye);

  // A flat decal glued onto the front face — flush and undistorted, since
  // the head is now flat there instead of curved. Hidden (leaving the
  // plain eye dots showing) until/unless the image actually finishes
  // loading, so a bad link or a CORS-less host just silently falls back to
  // the normal colored head instead of showing a broken-looking gap.
  const faceDecal = new THREE.Mesh(
    new THREE.PlaneGeometry(headSize * 0.85, headSize * 0.85),
    new THREE.MeshBasicMaterial({ transparent: true }),
  );
  faceDecal.position.set(0, 0.02, headSize / 2 + 0.005);
  faceDecal.visible = false;
  head.add(faceDecal);
  if (faceImageUrl) {
    loadFaceTexture(faceImageUrl, (tex) => {
      (faceDecal.material as THREE.MeshBasicMaterial).map = tex;
      (faceDecal.material as THREE.MeshBasicMaterial).needsUpdate = true;
      faceDecal.visible = true;
      leftEye.visible = false;
      rightEye.visible = false;
    });
  }

  const limbMaterial = new THREE.MeshStandardMaterial({ color: "#262626" });
  const shoeMaterial = new THREE.MeshStandardMaterial({ color: "#f5f5f5" });
  const handMaterial = new THREE.MeshStandardMaterial({ color });
  function limb(w: number, h: number, d: number, x: number, y: number, cap: "shoe" | "hand"): THREE.Mesh {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(w, d) * 0.25), limbMaterial);
    mesh.position.set(x, y, 0);
    // Pivot at the top of the limb (like a hip/shoulder joint), not its
    // center, so rotating it swings the limb rather than clipping through
    // the torso.
    mesh.geometry.translate(0, -h / 2, 0);
    mesh.castShadow = true;

    // A small cap at the limb's tip (a bright shoe, a skin-toned hand) —
    // parented to the limb itself so it swings along with the gait for
    // free, rather than needing its own animation.
    const capMesh =
      cap === "shoe"
        ? new THREE.Mesh(new RoundedBoxGeometry(w * 1.2, h * 0.22, d * 1.5, 2, 0.03), shoeMaterial)
        : new THREE.Mesh(new THREE.SphereGeometry(w * 0.62, 10, 8), handMaterial);
    capMesh.position.set(0, cap === "shoe" ? -h + (h * 0.22) / 2 : -h, cap === "shoe" ? d * 0.18 : 0);
    capMesh.castShadow = true;
    mesh.add(capMesh);

    return mesh;
  }
  const leftLeg = limb(0.22, 0.56, 0.22, -0.18, 0.38, "shoe");
  const rightLeg = limb(0.22, 0.56, 0.22, 0.18, 0.38, "shoe");
  const leftArm = limb(0.16, 0.46, 0.16, -0.43, 1.2, "hand");
  const rightArm = limb(0.16, 0.46, 0.16, 0.43, 1.2, "hand");
  group.add(leftLeg, rightLeg, leftArm, rightArm);

  const marker = new THREE.Mesh(
    new THREE.TorusGeometry(0.38, 0.05, 8, 24),
    new THREE.MeshBasicMaterial({ color: "#fbbf24" }),
  );
  marker.rotation.x = Math.PI / 2;
  marker.position.y = 1.95;
  marker.visible = false;
  group.add(marker);

  return {
    group,
    torso,
    torsoMaterial,
    leftLeg,
    rightLeg,
    leftArm,
    rightArm,
    marker,
    leftEye,
    rightEye,
    faceDecal,
    head,
    headBaseY,
    prevPos: NaN,
    // Seeded rather than all starting at 0 so a fresh field of racers
    // doesn't all step in unison the instant the race starts.
    gaitPhase: gaitSeed,
    exhaustedBlend: 0,
    ninjaBlend: 0,
  };
}

export function createKarirsScene3D(canvas: HTMLCanvasElement): Karirs3DScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const skyTexture = makeSkyTexture();
  scene.background = skyTexture;
  scene.fog = new THREE.Fog("#eef6f0", 26, 60);

  // Progress runs along +X (start at x=0, finish at x=TRACK_LENGTH) so the
  // race reads left-to-right on screen, matching the 2D track above it —
  // lanes fan out in Z (toward/away from camera) instead.
  const OVERVIEW_POS = new THREE.Vector3(TRACK_LENGTH / 2, 8, 15);
  const OVERVIEW_LOOKAT = new THREE.Vector3(TRACK_LENGTH / 2, 1, 0);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.copy(OVERVIEW_POS);
  camera.lookAt(OVERVIEW_LOOKAT);
  const currentCamPos = OVERVIEW_POS.clone();
  const currentLookAt = OVERVIEW_LOOKAT.clone();

  scene.add(new THREE.AmbientLight("#ffffff", 0.65));
  scene.add(new THREE.HemisphereLight("#bfe3f7", "#dff2e3", 0.45));
  const sun = new THREE.DirectionalLight("#fff7e6", 1.0);
  sun.position.set(TRACK_LENGTH / 2 + 10, 18, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -(TRACK_LENGTH / 2 + RUNOFF + 4);
  sun.shadow.camera.right = TRACK_LENGTH / 2 + RUNOFF + 4;
  sun.shadow.camera.top = RAIL_Z + 4;
  sun.shadow.camera.bottom = -(RAIL_Z + 4);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 60;
  sun.shadow.camera.updateProjectionMatrix();
  sun.target.position.set(TRACK_LENGTH / 2, 0, 0);
  scene.add(sun, sun.target);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(TRACK_LENGTH + RUNOFF * 2, LANE_WIDTH * 10),
    new THREE.MeshStandardMaterial({ color: "#dff2e3" }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.x = TRACK_LENGTH / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const checkerTexture = makeCheckerTexture();
  checkerTexture.wrapS = THREE.RepeatWrapping;
  checkerTexture.wrapT = THREE.RepeatWrapping;
  checkerTexture.repeat.set(1, 10);
  const finishLine = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, RAIL_Z * 2),
    new THREE.MeshStandardMaterial({ map: checkerTexture }),
  );
  finishLine.rotation.x = -Math.PI / 2;
  finishLine.position.set(TRACK_LENGTH, 0.012, 0);
  finishLine.receiveShadow = true;
  scene.add(finishLine);

  // A proper finish arch (two posts + a banner) reads as "the finish" from
  // any camera angle — unlike a flat ground plane, which foreshortens into
  // an ambiguous stripe once the camera isn't looking straight down it.
  const postMaterial = new THREE.MeshStandardMaterial({ color: "#f5f5f5" });
  const postGeometry = new THREE.BoxGeometry(0.3, 3.4, 0.3);
  const leftPost = new THREE.Mesh(postGeometry, postMaterial);
  leftPost.position.set(TRACK_LENGTH, 1.7, -RAIL_Z);
  leftPost.castShadow = true;
  const rightPost = new THREE.Mesh(postGeometry, postMaterial);
  rightPost.position.set(TRACK_LENGTH, 1.7, RAIL_Z);
  rightPost.castShadow = true;
  const banner = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.6, RAIL_Z * 2 + 0.3),
    new THREE.MeshStandardMaterial({ color: "#ef4444" }),
  );
  banner.position.set(TRACK_LENGTH, 3.4, 0);
  banner.castShadow = true;
  const finishLabel = makeTextSprite("FINISH", { color: "#ffffff", bold: true });
  finishLabel.scale.set(2.6, 0.65, 1);
  finishLabel.position.set(TRACK_LENGTH, 4.35, 0);
  scene.add(leftPost, rightPost, banner, finishLabel);

  const startLine = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, RAIL_Z * 2),
    new THREE.MeshStandardMaterial({ color: "#a3a3a3" }),
  );
  startLine.rotation.x = -Math.PI / 2;
  startLine.position.set(0, 0.011, 0);
  startLine.receiveShadow = true;
  scene.add(startLine);

  // Low side rails purely as a spatial/scale reference — without them the
  // track reads as an undifferentiated green plane and it's hard to judge
  // depth or how far a racer is from the edge.
  const railMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff" });
  const railGeometry = new THREE.BoxGeometry(TRACK_LENGTH + RUNOFF * 2, 0.18, 0.16);
  const nearRail = new THREE.Mesh(railGeometry, railMaterial);
  nearRail.position.set(TRACK_LENGTH / 2, 0.09, RAIL_Z);
  nearRail.castShadow = true;
  nearRail.receiveShadow = true;
  const farRail = new THREE.Mesh(railGeometry, railMaterial);
  farRail.position.set(TRACK_LENGTH / 2, 0.09, -RAIL_Z);
  farRail.castShadow = true;
  farRail.receiveShadow = true;
  scene.add(nearRail, farRail);

  // A full ring of tiered stands around the track — both long sides plus
  // both ends beyond the start line and past the finish arch — stepped
  // outward and upward like real bleachers, so back rows can see over
  // front rows. This is what actually sells "racing at the center of a
  // stadium" rather than "racing between two fences of people".
  const standMaterial = new THREE.MeshStandardMaterial({ color: "#d4d4d4" });
  const crowdStands: THREE.Mesh[] = [];
  interface CrowdSlot {
    x: number;
    y: number;
    z: number;
    phase: number;
  }
  const crowdSlots: CrowdSlot[] = [];
  // Deterministic "random" (not Math.random()) so a rebuild — e.g. a
  // browser tab restore — reproduces the same crowd instead of visibly
  // reshuffling everyone's sway timing.
  const phaseAt = (x: number, z: number) => ((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1) * Math.PI * 2;

  const crowdStartX = -RUNOFF * 0.6;
  const crowdEndX = TRACK_LENGTH + RUNOFF * 0.6;
  // How far out the side stands' own outermost tier reaches — the end
  // stands span a bit past this so the two walls overlap cleanly at the
  // four corners instead of leaving a gap.
  const sideOuterZ = RAIL_Z + CROWD_TIER_GAP + (CROWD_TIERS - 1) * CROWD_TIER_DEPTH + CROWD_TIER_DEPTH;

  const sideStandGeometry = new THREE.BoxGeometry(crowdEndX - crowdStartX, 0.25, CROWD_TIER_DEPTH * 0.92);
  for (const side of [1, -1] as const) {
    for (let tier = 0; tier < CROWD_TIERS; tier++) {
      const z = side * (RAIL_Z + CROWD_TIER_GAP + tier * CROWD_TIER_DEPTH);
      const y = 0.35 + tier * CROWD_TIER_HEIGHT;

      const stand = new THREE.Mesh(sideStandGeometry, standMaterial);
      stand.position.set((crowdStartX + crowdEndX) / 2, y - 0.15, z);
      stand.receiveShadow = true;
      scene.add(stand);
      crowdStands.push(stand);

      for (let x = crowdStartX + CROWD_PERSON_SPACING / 2; x < crowdEndX; x += CROWD_PERSON_SPACING) {
        crowdSlots.push({ x, y, z, phase: phaseAt(x, z) });
      }
    }
  }

  // End stands — same tiering, rotated 90°: the "along" axis is now Z
  // (spanning corner to corner past the side stands) and tiers step
  // outward in X instead, one wall beyond the start line and one beyond
  // the finish arch.
  const endStandGeometry = new THREE.BoxGeometry(CROWD_TIER_DEPTH * 0.92, 0.25, sideOuterZ * 2);
  for (const end of [1, -1] as const) {
    for (let tier = 0; tier < CROWD_TIERS; tier++) {
      const x = end > 0 ? crowdEndX + CROWD_TIER_GAP + tier * CROWD_TIER_DEPTH : crowdStartX - CROWD_TIER_GAP - tier * CROWD_TIER_DEPTH;
      const y = 0.35 + tier * CROWD_TIER_HEIGHT;

      const stand = new THREE.Mesh(endStandGeometry, standMaterial);
      stand.position.set(x, y - 0.15, 0);
      stand.receiveShadow = true;
      scene.add(stand);
      crowdStands.push(stand);

      for (let z = -sideOuterZ + CROWD_PERSON_SPACING / 2; z < sideOuterZ; z += CROWD_PERSON_SPACING) {
        crowdSlots.push({ x, y, z, phase: phaseAt(x, z) });
      }
    }
  }

  // One InstancedMesh pair per color (a handful of draw calls total) rather
  // than one big pair with per-instance vertex colors — sidesteps needing
  // InstancedMesh.setColorAt/instanceColor to behave a particular way, at
  // the cost of a few extra (still cheap) draw calls.
  const crowdBuckets: { slots: CrowdSlot[]; bodyMesh: THREE.InstancedMesh; headMesh: THREE.InstancedMesh }[] = CROWD_COLORS.map(
    (color) => ({
      slots: [],
      bodyMesh: new THREE.InstancedMesh(new THREE.BoxGeometry(CROWD_BODY_W, CROWD_BODY_H, CROWD_BODY_D), new THREE.MeshStandardMaterial({ color }), 0),
      headMesh: new THREE.InstancedMesh(new THREE.SphereGeometry(CROWD_HEAD_R, 8, 6), new THREE.MeshStandardMaterial({ color }), 0),
    }),
  );
  crowdSlots.forEach((slot, i) => crowdBuckets[i % CROWD_COLORS.length].slots.push(slot));

  const crowdDummy = new THREE.Object3D();
  for (const bucket of crowdBuckets) {
    // InstancedMesh's instance count is fixed at construction — rebuild
    // each bucket's meshes now that we know how many slots landed in it.
    bucket.bodyMesh = new THREE.InstancedMesh(bucket.bodyMesh.geometry, bucket.bodyMesh.material, bucket.slots.length);
    bucket.headMesh = new THREE.InstancedMesh(bucket.headMesh.geometry, bucket.headMesh.material, bucket.slots.length);
    bucket.slots.forEach((slot, i) => {
      crowdDummy.position.set(slot.x, slot.y + CROWD_BODY_H / 2, slot.z);
      crowdDummy.updateMatrix();
      bucket.bodyMesh.setMatrixAt(i, crowdDummy.matrix);
      crowdDummy.position.set(slot.x, slot.y + CROWD_BODY_H + CROWD_HEAD_R * 0.9, slot.z);
      crowdDummy.updateMatrix();
      bucket.headMesh.setMatrixAt(i, crowdDummy.matrix);
    });
    scene.add(bucket.bodyMesh, bucket.headMesh);
  }

  function updateCrowd(t: number, excited: boolean) {
    const amplitude = excited ? CROWD_EXCITED_BOB : CROWD_IDLE_BOB;
    for (const bucket of crowdBuckets) {
      bucket.slots.forEach((slot, i) => {
        const bob = Math.sin(t * CROWD_BOB_FREQUENCY + slot.phase) * amplitude;
        crowdDummy.position.set(slot.x, slot.y + CROWD_BODY_H / 2 + bob, slot.z);
        crowdDummy.updateMatrix();
        bucket.bodyMesh.setMatrixAt(i, crowdDummy.matrix);
        crowdDummy.position.set(slot.x, slot.y + CROWD_BODY_H + CROWD_HEAD_R * 0.9 + bob, slot.z);
        crowdDummy.updateMatrix();
        bucket.headMesh.setMatrixAt(i, crowdDummy.matrix);
      });
      bucket.bodyMesh.instanceMatrix.needsUpdate = true;
      bucket.headMesh.instanceMatrix.needsUpdate = true;
    }
  }

  // Deterministic 0..1 "random" (same hash trick as phaseAt above) — a
  // rebuild reproduces the same skyline/cloud layout instead of reshuffling
  // it every time a race starts.
  const hash01 = (a: number, b: number) => {
    const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };

  const cityBuildings: THREE.Mesh[] = [];
  const endOuterX = {
    // How far out the end stands' own outermost tier reaches, in either
    // direction — mirrors sideOuterZ's role for the side stands.
    near: crowdStartX - CROWD_TIER_GAP - (CROWD_TIERS - 1) * CROWD_TIER_DEPTH - CROWD_TIER_DEPTH,
    far: crowdEndX + CROWD_TIER_GAP + (CROWD_TIERS - 1) * CROWD_TIER_DEPTH + CROWD_TIER_DEPTH,
  };

  function placeBuilding(x: number, z: number, seed: number) {
    const height = 4 + hash01(seed, 1) * 16;
    const width = 1.6 + hash01(seed, 2) * 2.2;
    const color = CITY_COLORS[Math.floor(hash01(seed, 3) * CITY_COLORS.length)];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, width), new THREE.MeshStandardMaterial({ color }));
    mesh.position.set(x, height / 2, z);
    scene.add(mesh);
    cityBuildings.push(mesh);
  }

  // Two staggered rows per side (near + a taller, further-back row) reads
  // as an actual skyline instead of a single flat wall of boxes.
  for (const rowDepth of [0, 15]) {
    for (const side of [1, -1] as const) {
      const z = side * (sideOuterZ + CITY_RING_GAP + rowDepth);
      let x = crowdStartX - 10;
      let i = 0;
      while (x < crowdEndX + 10) {
        placeBuilding(x, z + (hash01(x, z) - 0.5) * 3, x * 3.1 + z * 7.7 + rowDepth);
        x += CITY_BUILDING_SPACING + hash01(x + 1.7, z) * 2.2;
        i++;
        if (i > 400) break; // guard against a stray infinite loop, never expected to trip
      }
    }
    for (const end of [1, -1] as const) {
      const x = end > 0 ? endOuterX.far + CITY_RING_GAP + rowDepth : endOuterX.near - CITY_RING_GAP - rowDepth;
      let z = -sideOuterZ - 10;
      let i = 0;
      while (z < sideOuterZ + 10) {
        placeBuilding(x + (hash01(z, x) - 0.5) * 3, z, x * 3.1 + z * 7.7 + rowDepth + 500);
        z += CITY_BUILDING_SPACING + hash01(z + 1.7, x) * 2.2;
        i++;
        if (i > 400) break;
      }
    }
  }

  // The grass/turf floor only covers the track itself — without this, the
  // buildings just sit on bare background with no ground under them at
  // all. A dark asphalt plane under the whole skyline area, positioned
  // just below the turf so the turf still wins wherever the two overlap,
  // reads as pavement instead; dashed lane markings down the middle of
  // each of the four belts (the gap between the near and far building row)
  // are what actually sell it as a *street* rather than a parking lot.
  const streetSpan = Math.max(endOuterX.far - endOuterX.near, sideOuterZ * 2) + 90;
  const street = new THREE.Mesh(
    new THREE.PlaneGeometry(streetSpan, streetSpan),
    new THREE.MeshStandardMaterial({ color: "#52565c" }),
  );
  street.rotation.x = -Math.PI / 2;
  street.position.set(TRACK_LENGTH / 2, -0.01, 0);
  street.receiveShadow = true;
  scene.add(street);
  cityBuildings.push(street);

  const dashMaterial = new THREE.MeshBasicMaterial({ color: "#e8c34d" });
  const dashGeometry = new THREE.BoxGeometry(1.1, 0.02, 0.22);
  function paintLaneDashes(alongMin: number, alongMax: number, fixedCoord: number, alongIsX: boolean) {
    for (let along = alongMin; along < alongMax; along += 2.4) {
      const dash = new THREE.Mesh(dashGeometry, dashMaterial);
      if (alongIsX) {
        dash.position.set(along, 0.015, fixedCoord);
      } else {
        dash.rotation.y = Math.PI / 2;
        dash.position.set(fixedCoord, 0.015, along);
      }
      scene.add(dash);
      cityBuildings.push(dash);
    }
  }
  const streetMidGap = CITY_RING_GAP + 7.5; // halfway between the two building rows
  for (const side of [1, -1] as const) {
    paintLaneDashes(crowdStartX - 8, crowdEndX + 8, side * (sideOuterZ + streetMidGap), true);
  }
  for (const end of [1, -1] as const) {
    const x = end > 0 ? endOuterX.far + streetMidGap : endOuterX.near - streetMidGap;
    paintLaneDashes(-sideOuterZ - 8, sideOuterZ + 8, x, false);
  }

  const rigs = new Map<string, RacerRig>();
  const sprites = new Map<string, THREE.Sprite>();
  const laneDividers = new THREE.Group();
  scene.add(laneDividers);
  let builtNames: string[] = [];
  let builtMyBet: string | null = null;
  const clock = new THREE.Clock();
  let crowdTime = 0;

  let cameraMode: Karirs3DCameraMode = "overview";
  let focusedRacerName: string | null = null;

  let lastWidth = 0;
  let lastHeight = 0;

  interface FaceRenderer {
    canvas: HTMLCanvasElement;
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    lastWidth: number;
    lastHeight: number;
  }
  const faceRenderers = new Map<string, FaceRenderer>();
  const faceCamLookAt = new THREE.Vector3();

  function setFaceCanvases(canvases: Map<string, HTMLCanvasElement>) {
    for (const [name, existing] of faceRenderers) {
      if (canvases.get(name) !== existing.canvas) {
        existing.renderer.dispose();
        faceRenderers.delete(name);
      }
    }
    for (const [name, canvas] of canvases) {
      if (faceRenderers.has(name)) continue;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const camera = new THREE.PerspectiveCamera(FACE_CAM_FOV, 1, 0.05, 20);
      faceRenderers.set(name, { canvas, renderer, camera, lastWidth: 0, lastHeight: 0 });
    }
  }

  // Rendered with the scene's usual sky/fog swapped out for a flat neutral
  // backdrop — a close-up face reading as a little profile portrait rather
  // than a zoomed-in crop of the track background.
  const faceCamBackground = new THREE.Color("#f5f5f4");

  function renderFaceCanvases() {
    if (faceRenderers.size === 0) return;
    const savedBackground = scene.background;
    const savedFog = scene.fog;
    scene.background = faceCamBackground;
    scene.fog = null;
    // The floating name labels are sized/framed for the main wide view —
    // this close up, they just clip into cut-off text across the top of
    // the square. The racer's name is already the caption under the
    // canvas in the DOM, so there's nothing lost by hiding them here.
    for (const sprite of sprites.values()) sprite.visible = false;

    for (const [name, fr] of faceRenderers) {
      const rig = rigs.get(name);
      if (!rig) continue;
      const width = fr.canvas.clientWidth;
      const height = fr.canvas.clientHeight;
      if (width === 0 || height === 0) continue;
      if (width !== fr.lastWidth || height !== fr.lastHeight) {
        fr.renderer.setSize(width, height, false);
        fr.camera.aspect = width / height;
        fr.camera.updateProjectionMatrix();
        fr.lastWidth = width;
        fr.lastHeight = height;
      }

      // Tracks the rig's stable group position (progress + lane), not the
      // live bobbing head mesh itself — if the camera followed the bob
      // too, it'd move in lockstep with the head and the bob would cancel
      // itself out, looking perfectly static. Framing a fixed point below
      // the head's resting height lets the actual bob read as motion
      // against a steady shot, and brings some shoulder into frame.
      const aimY = rig.headBaseY + TORSO_Y - FACE_CAM_AIM_DROP;
      // The head faces world +X (see buildRacerRig's 90° group rotation),
      // so "in front of the face" is further along +X, looking back at it.
      fr.camera.position.set(rig.group.position.x + FACE_CAM_DISTANCE, aimY, rig.group.position.z);
      faceCamLookAt.set(rig.group.position.x, aimY, rig.group.position.z);
      fr.camera.lookAt(faceCamLookAt);
      fr.renderer.render(scene, fr.camera);
    }

    scene.background = savedBackground;
    scene.fog = savedFog;
    for (const sprite of sprites.values()) sprite.visible = true;
  }

  function rebuildRacers(racerNames: string[], myBetRacerName: string | null, faceImageUrls: Record<string, string | null>) {
    for (const rig of rigs.values()) scene.remove(rig.group);
    for (const sprite of sprites.values()) scene.remove(sprite);
    rigs.clear();
    sprites.clear();
    while (laneDividers.children.length) {
      const child = laneDividers.children[0] as THREE.Mesh;
      laneDividers.remove(child);
      disposeMesh(child);
    }

    const laneOffset = (racerNames.length - 1) / 2;
    racerNames.forEach((name, i) => {
      const rig = buildRacerRig(RACER_COLORS[i % RACER_COLORS.length], i, faceImageUrls[name] ?? null);
      rig.group.position.z = (i - laneOffset) * LANE_WIDTH;
      scene.add(rig.group);
      rigs.set(name, rig);

      const sprite = makeNameSprite(name, name === myBetRacerName);
      sprite.position.set(0, 2.15, rig.group.position.z);
      scene.add(sprite);
      sprites.set(name, sprite);
    });

    // n+1 boundary lines — one before the first lane, one between every
    // pair, one after the last — so every lane is visually bounded, not
    // just the outer two.
    const dividerGeometry = new THREE.BoxGeometry(TRACK_LENGTH + RUNOFF * 2, 0.02, 0.035);
    const dividerMaterial = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.6 });
    for (let i = 0; i <= racerNames.length; i++) {
      const z = (i - 0.5 - laneOffset) * LANE_WIDTH;
      const line = new THREE.Mesh(dividerGeometry, dividerMaterial);
      line.position.set(TRACK_LENGTH / 2, 0.015, z);
      laneDividers.add(line);
    }

    builtNames = racerNames;
    builtMyBet = myBetRacerName;
    focusedRacerName = null;
  }

  function update({ racerNames, playback, winningName, isResolved, myBetRacerName, faceImageUrls }: Karirs3DUpdateParams) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (width !== lastWidth || height !== lastHeight) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }

    const sameRoster = racerNames.length === builtNames.length && racerNames.every((n, i) => n === builtNames[i]);
    if (!sameRoster || myBetRacerName !== builtMyBet) {
      rebuildRacers(racerNames, myBetRacerName, faceImageUrls);
    }

    // Real elapsed time since the *previous* update() call — not since the
    // scene was created — so gaitPhase accumulates in step with wall-clock
    // motion regardless of frame rate.
    const dt = Math.min(clock.getDelta(), 0.1);
    crowdTime += dt;
    // A signature move firing, or the race having just resolved, kicks the
    // whole crowd into an excited cheer instead of an idle sway.
    updateCrowd(crowdTime, playback.shouting.length > 0 || isResolved);
    const laneOffset = (racerNames.length - 1) / 2;
    for (const name of racerNames) {
      const rig = rigs.get(name);
      if (!rig) continue;
      const pos = playback.positions[name] ?? 0;
      const pct = Math.max(0, Math.min(1, pos / FINISH_LINE));
      const targetX = pct * TRACK_LENGTH;

      const isShouting = playback.shouting.includes(name);
      const isWinner = isResolved && name === winningName;

      // Instantaneous speed by finite-differencing this frame's position
      // against last frame's, in the same 0-100 scale the server sends —
      // this is what makes the gait actually react to a racer speeding up,
      // slowing down, or stopping, instead of one fixed "always sprinting"
      // cadence.
      const speed = isResolved || Number.isNaN(rig.prevPos) ? 0 : Math.max(0, (pos - rig.prevPos) / dt);
      rig.prevPos = pos;

      const isMoving = speed > STOP_SPEED_THRESHOLD;
      const speedRatio = Math.min(1, speed / SPRINT_SPEED);
      // Mutually exclusive with the ninja pose below — shouting only ever
      // fires at peak speed anyway, so a racer is never genuinely both at
      // once, but the guard keeps them that way even at the boundary.
      const isExhausted = isMoving && !isShouting && speed < EXHAUSTED_SPEED_THRESHOLD;

      // Eased toward the current target rather than snapped — this is what
      // makes e.g. exhausted-to-running read as a recovery instead of a
      // switch flipping the instant speed crosses the threshold. Every
      // pose value below is blended by these two factors instead of hard-
      // switching on isExhausted/isShouting directly.
      const easeStep = Math.min(1, dt * POSE_EASE_RATE);
      rig.exhaustedBlend += ((isExhausted ? 1 : 0) - rig.exhaustedBlend) * easeStep;
      rig.ninjaBlend += ((isShouting ? 1 : 0) - rig.ninjaBlend) * easeStep;
      const eb = rig.exhaustedBlend;
      const nb = rig.ninjaBlend;

      // Phase only advances while actually moving — a racer that stops
      // mid-race holds its current stride pose instead of endlessly
      // replaying a cycle in place with zero amplitude. Exhausted staggers
      // the cadence down; a signature move quickens it — both eased, not
      // snapped, same as everything else here.
      if (isMoving) {
        const frequency = (WALK_GAIT_FREQUENCY + (SPRINT_GAIT_FREQUENCY - WALK_GAIT_FREQUENCY) * speedRatio) * (1 - 0.5 * eb + 0.3 * nb);
        rig.gaitPhase += dt * frequency;
      }
      // A floor under the amplitude/bounce scaling (once moving at all)
      // keeps a slow walk visually distinct from standing still, rather
      // than fading into an imperceptible shuffle. Exhausted shortens the
      // stride further still (a stagger, not a stride).
      const strideScale = (isMoving ? Math.max(0.35, speedRatio) : 0) * (1 - 0.5 * eb);
      const gait = Math.sin(rig.gaitPhase) * SPRINT_STRIDE * strideScale;
      rig.leftLeg.rotation.x = gait;
      rig.rightLeg.rotation.x = -gait;

      // Each arm's rotation is a blend of three targets — the normal
      // fore-aft swing, exhausted's forward-held tremble, and ninja's
      // backward trail — weighted by how far into each pose this rig
      // currently is, so a racer easing out of exhaustion visibly swings
      // back into a normal stride instead of snapping into one.
      const ninjaTrail = NINJA_ARM_TRAIL + Math.sin(rig.gaitPhase * 1.5) * 0.06;
      const exhaustedArmL = EXHAUSTED_ARM_FORWARD + Math.sin(crowdTime * 9) * EXHAUSTED_TREMBLE;
      const exhaustedArmR = EXHAUSTED_ARM_FORWARD + Math.sin(crowdTime * 9 + 1) * EXHAUSTED_TREMBLE;
      rig.leftArm.rotation.x = -gait + (exhaustedArmL - -gait) * eb + (ninjaTrail - -gait) * nb;
      rig.rightArm.rotation.x = gait + (exhaustedArmR - gait) * eb + (ninjaTrail - gait) * nb;

      rig.group.position.y = Math.abs(Math.sin(rig.gaitPhase)) * SPRINT_BOUNCE * strideScale;
      rig.group.position.x = targetX;
      // Same phase as the body bounce above (peaks on every footfall), so
      // the head bobs in sync with it rather than against it.
      rig.head.position.y = rig.headBaseY + Math.abs(Math.sin(rig.gaitPhase)) * HEAD_BOB * strideScale;

      // Positive tilts the torso's top forward, in the direction of travel
      // — the head comes along for free since it's parented to the torso
      // (see buildRacerRig), so leaning no longer leaves it looking
      // detached from the shoulders. Both leans are deltas off the neutral
      // 0 rotation, so they can just add together, weighted by blend.
      rig.torso.rotation.x = EXHAUSTED_LEAN * eb + NINJA_LEAN * nb;
      rig.head.rotation.x = EXHAUSTED_HEAD_DROOP * eb;
      // A heaving chest while exhausted — a slow scale pulse independent
      // of the gait/bounce cycle above, faded in/out with the same blend.
      rig.torso.scale.y = 1 + Math.sin(crowdTime * EXHAUSTED_BREATH_FREQUENCY) * EXHAUSTED_BREATH_AMPLITUDE * eb;

      rig.torsoMaterial.emissive.set(isWinner ? "#f59e0b" : "#fde68a");
      rig.torsoMaterial.emissiveIntensity = isWinner ? 0.6 : nb * 0.9;

      rig.marker.visible = name === myBetRacerName;

      const sprite = sprites.get(name);
      if (sprite) sprite.position.x = targetX;
    }

    // Leader-follow bookkeeping — hysteresis so a photo-finish doesn't whip
    // the camera between two racers every frame (see LEADER_SWITCH_MARGIN).
    let bestName: string | null = null;
    let bestPos = -Infinity;
    for (const name of racerNames) {
      const p = playback.positions[name] ?? 0;
      if (p > bestPos) {
        bestPos = p;
        bestName = name;
      }
    }
    const focusedPos = focusedRacerName ? (playback.positions[focusedRacerName] ?? -Infinity) : -Infinity;
    if (bestName && (!focusedRacerName || bestPos > focusedPos + LEADER_SWITCH_MARGIN)) {
      focusedRacerName = bestName;
    }

    let desiredPos = OVERVIEW_POS;
    let desiredLookAt = OVERVIEW_LOOKAT;
    if (cameraMode !== "overview" && focusedRacerName) {
      const idx = racerNames.indexOf(focusedRacerName);
      const laneZ = (idx - laneOffset) * LANE_WIDTH;
      const leaderPct = Math.max(0, Math.min(1, (playback.positions[focusedRacerName] ?? 0) / FINISH_LINE));
      const leaderX = leaderPct * TRACK_LENGTH;
      if (cameraMode === "chase") {
        // Behind and to one side, looking forward past the leader toward
        // the finish — the direction they're actually running.
        desiredPos = new THREE.Vector3(leaderX - 5.5, 2.7, laneZ + 3.6);
        desiredLookAt = new THREE.Vector3(leaderX + 5, 1.2, laneZ);
      } else {
        // Ahead of the leader, looking back toward them (and past them,
        // toward the pack still behind) — so you watch them run straight
        // at the camera instead of away from it.
        desiredPos = new THREE.Vector3(leaderX + 4.5, 2.4, laneZ - 3.4);
        desiredLookAt = new THREE.Vector3(leaderX - 3, 1.2, laneZ);
      }
    }
    currentCamPos.lerp(desiredPos, CAMERA_DAMPING);
    currentLookAt.lerp(desiredLookAt, CAMERA_DAMPING);
    camera.position.copy(currentCamPos);
    camera.lookAt(currentLookAt);

    renderer.render(scene, camera);
    renderFaceCanvases();
  }

  function setCameraMode(mode: Karirs3DCameraMode) {
    cameraMode = mode;
  }

  function dispose() {
    for (const fr of faceRenderers.values()) fr.renderer.dispose();
    faceRenderers.clear();
    for (const rig of rigs.values()) {
      rig.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) disposeMesh(obj);
      });
    }
    for (const sprite of sprites.values()) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    for (const child of laneDividers.children) disposeMesh(child as THREE.Mesh);
    disposeMesh(floor);
    disposeMesh(finishLine);
    checkerTexture.dispose();
    disposeMesh(startLine);
    disposeMesh(leftPost);
    disposeMesh(rightPost); // shares postGeometry/postMaterial with leftPost — dispose() is safe to call twice
    disposeMesh(banner);
    finishLabel.material.map?.dispose();
    finishLabel.material.dispose();
    disposeMesh(nearRail);
    disposeMesh(farRail);
    for (const stand of crowdStands) disposeMesh(stand); // shares standGeometry/standMaterial — safe to dispose repeatedly
    for (const bucket of crowdBuckets) {
      disposeMesh(bucket.bodyMesh);
      disposeMesh(bucket.headMesh);
    }
    for (const building of cityBuildings) disposeMesh(building);
    skyTexture.dispose();
    renderer.dispose();
  }

  return { update, setCameraMode, setFaceCanvases, dispose };
}
