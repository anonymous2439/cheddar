// GL Sims — an idle stick-figure "screensaver": a small crowd of fully
// autonomous characters wandering, sitting, and occasionally interacting
// (hit/kiss) with each other. No player input at all right now — see
// simulation.js's decideNextAction() for where a future "manually pick
// an action" feature would hook in. vscode-only, and — except for one
// thing — still fully self-contained: the conversation script (see
// conversation.js) is fetched live from karirs-api on mount instead of
// being bundled at build time, via the same action-relay every other
// vscode game module already uses (window.CheddarHost.send/onEvent) —
// see requestConversationData/onEvent below. Everything else (the crowd
// simulation itself, rendering, camera) has no networking at all.
import * as THREE from "three";
import {
  createCharacter,
  disposeCharacter,
  updateCharacter,
  resolveCollisions,
  ARENA_HALF_X,
  ARENA_HALF_Z,
} from "./simulation.js";
import {
  createConversationState,
  updateConversation,
  disposeConversation,
  getConversationFocusPoint,
  setConversationLines,
} from "./conversation.js";
import { scaleNameLabel } from "./character.js";

// Bridges chat.js's generic game.onEvent(event, data) dispatch (see
// mountGame()/onEvent below) back to whichever conversation state is
// currently mounted — module-level rather than a mount()-local variable
// since onEvent is called with no reference to a specific mount at all,
// same reasoning chess/karirs/beats' own game.js modules already use for
// their own onEvent bridging.
let activeConversationState = null;

const CHARACTER_COLORS = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#22d3ee", "#818cf8", "#e879f9", "#f472b6"];

// Same roster as karirs' racers (games/karirs/api/app/roster.py's
// SEED_RACERS) — reused here purely as flavor/name-tag theming, a copied
// list of names, not a live link to karirs' actual race data. A
// conversation line whose speaker isn't in this list no longer gets
// skipped (see conversation.js's ghost slot system) — it's played back by
// a temporary "ghost angel" stand-in instead.
const CHARACTER_NAMES = [
  "Neil Axinto", "Aby Calago", "Ashley Bayarcal", "Brian Lisondra", "Carl Perral",
  "Chaimel Enjambre", "Elieser Tajanlangit", "Jayson Martinez", "Jerome Madelo", "Jhoewell Posas",
  "Jhon Pabroa", "John Macapaz", "John Leo Salac", "Jonah Taganahan", "Joshua Paulo",
  "Troy Alonsagay", "Grace Vellina", "Mat Ando", "Michael Tonilon", "Mike Miñoza",
  "Novel Chavez", "Percival Mansueto", "Rashed Perez", "Roland Clarion", "Xiao",
];

function pickRandomNames(count) {
  const pool = [...CHARACTER_NAMES];
  const picked = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

// Camera is spherical coordinates around a *pannable* target (panTargetX/Z
// below — not always the origin): azimuth (camAngle, around the vertical
// axis) and elevation (camElevation, angle above the horizontal plane).
// Auto mode no longer orbits at all — it sits fixed at the default landscape
// angle/zoom, centered on the arena, and only ever moves to smoothly pan/
// zoom toward whoever currently has a chat bubble up (see the conversation
// focus block in frame() below), easing back to the centered default once
// the conversation ends. In manual mode, holding the left mouse button and
// dragging adjusts both angles directly (orbit), the mouse wheel zooms
// (adjusts radius), and holding Space while dragging pans the orbit target
// across the ground plane instead of orbiting — same combo as Blender's
// space+drag, since plain click-drag was already taken by orbit. Manual
// camera is never touched by the conversation auto-focus — it's fully
// user-controlled once toggled on.
const CAMERA_RADIUS = 10; // default zoom — deliberately closer in than a full-arena establishing shot
const CAMERA_HEIGHT = 7;
const CAMERA_ELEVATION = Math.atan2(CAMERA_HEIGHT, CAMERA_RADIUS);
// camAngle = 0 puts the camera straight out along +Z looking back at the
// origin along -Z, with its right vector along +X — since the arena's long
// axis is X (see simulation.js's ARENA_HALF_X/Z), this is the landscape
// framing: the wide axis spans the screen, not the shallow one.
const DEFAULT_CAM_ANGLE = 0;
const MIN_ZOOM_RADIUS = 5;
const MAX_ZOOM_RADIUS = 45; // wide enough to pull back and see the whole widened arena in manual mode
const ZOOM_SPEED = 0.02; // radius units per wheel deltaY unit
const MIN_ELEVATION = 0.1; // just above the horizon
const MAX_ELEVATION = 1.45; // just short of straight down
const DRAG_SENSITIVITY = 0.006; // radians per pixel of mouse movement
// World units per pixel of drag, per unit of zoomRadius — scaled by radius
// so a pixel of drag covers roughly the same *apparent* screen distance
// whether zoomed in or out, matching how the orbit drag already feels.
const PAN_SENSITIVITY = 0.0012;
// How far the pan target may wander from the arena before getting
// clamped — generous enough to look around beyond where characters
// actually wander, not so generous a stray drag strands the camera
// somewhere the scene is a barely-visible speck.
const PAN_TARGET_BOUND = Math.max(ARENA_HALF_X, ARENA_HALF_Z) * 2.5;
// How close (world units) the auto camera zooms in while focused on an
// active conversation's bubble(s) — closer than the default establishing
// zoom, for an actual "focus in on them talking" feel.
const AUTO_FOCUS_ZOOM_RADIUS = 7;
// Ease rate (fraction of the remaining distance closed per second) for the
// auto camera's pan/zoom drifting toward or away from a conversation focus
// point — a smooth pan rather than a snap-to-speaker jump cut.
const AUTO_FOCUS_LERP_SPEED = 3;

function buildGround(scene) {
  const groundWidth = (ARENA_HALF_X + 3) * 2;
  const groundDepth = (ARENA_HALF_Z + 3) * 2;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundWidth, groundDepth),
    new THREE.MeshStandardMaterial({ color: "#3f6b3f" }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // A faint grid on top so the ground doesn't read as an empty void —
  // purely decorative, not used for any collision/bounds logic (the
  // characters' own wandering is clamped by ARENA_HALF_X/Z in
  // simulation.js). GridHelper itself is only square, so it's built at the
  // arena's long-axis size and then squashed on Z to match the rectangle.
  const grid = new THREE.GridHelper(groundWidth, Math.round(groundWidth / 2), "#2f4f2f", "#2f4f2f");
  grid.scale.z = groundDepth / groundWidth;
  grid.position.y = 0.01;
  scene.add(grid);
}

function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#bfe3f2");
  scene.fog = new THREE.Fog("#bfe3f2", 20, 45);

  scene.add(new THREE.AmbientLight("#ffffff", 0.7));
  const sun = new THREE.DirectionalLight("#fff7e0", 0.8);
  sun.position.set(8, 14, 6);
  sun.castShadow = true;
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);

  buildGround(scene);

  return { renderer, scene, camera };
}

function randomArenaPoint(margin) {
  const halfX = ARENA_HALF_X - margin;
  const halfZ = ARENA_HALF_Z - margin;
  return {
    x: (Math.random() * 2 - 1) * halfX,
    z: (Math.random() * 2 - 1) * halfZ,
  };
}

export function mount(el) {
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.position = "relative";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "8px";
  header.style.margin = "0 0 6px 0";

  const status = document.createElement("p");
  status.style.fontSize = "12px";
  status.style.margin = "0";
  status.style.color = "#a3a3a3";
  status.textContent = "GL Sims — scroll to zoom.";
  header.appendChild(status);

  const cameraButton = document.createElement("button");
  cameraButton.style.fontSize = "11px";
  cameraButton.style.padding = "2px 8px";
  cameraButton.style.cursor = "pointer";
  header.appendChild(cameraButton);

  wrap.appendChild(header);

  const canvas = document.createElement("canvas");
  // Widescreen-ish (was 640x400, a squarer 1.6:1) — no separate CSS height
  // rule below, so the browser scales height to match this intrinsic
  // ratio whenever the container constrains width.
  canvas.width = 640;
  canvas.height = 280;
  canvas.style.width = "100%";
  canvas.style.maxWidth = "720px";
  canvas.style.display = "block";
  canvas.style.borderRadius = "4px";
  wrap.appendChild(canvas);

  el.appendChild(wrap);

  const { renderer, scene, camera } = createScene(canvas);

  // Every racer in the roster gets a spot on the platform now (was a random
  // 8-of-25 subset) — pickRandomNames still shuffles the order (so color
  // assignment/spawn order varies run to run), just over the full list.
  const names = pickRandomNames(CHARACTER_NAMES.length);
  const characters = [];
  for (let i = 0; i < names.length; i++) {
    const p = randomArenaPoint(1.5);
    const color = CHARACTER_COLORS[i % CHARACTER_COLORS.length];
    characters.push(createCharacter(scene, color, p.x, p.z, names[i]));
  }

  let camAngle = DEFAULT_CAM_ANGLE;
  let camElevation = CAMERA_ELEVATION;
  let zoomRadius = CAMERA_RADIUS;
  let panTargetX = 0;
  let panTargetZ = 0;
  const PAN_TARGET_Y = 1; // matches the old fixed lookAt(0, 1, 0)
  let manualCamera = false;
  let isDragging = false;
  let isPanning = false; // this drag is a pan (Space was held at mousedown), not an orbit
  let spacePressed = false;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let lastWidth = 0;
  let lastHeight = 0;
  let lastFrameTime = performance.now();
  let rafId = 0;
  const conversationState = createConversationState(scene);
  activeConversationState = conversationState;
  // Fires the same way karirs/chess/beats already fetch their own state —
  // relayed through the extension host (window.CheddarHost.send), which
  // does the actual HTTP call from Node (no CORS concerns, unlike a raw
  // fetch() from inside the webview) and replies via game.event, routed
  // to onEvent below. Silently does nothing if it fails or never arrives
  // (see onEvent's 'error' branch) — GL Sims still runs, just without any
  // chat-bubble flavor that session.
  window.CheddarHost?.send("get_conversations", {});

  function updateCameraButtonLabel() {
    cameraButton.textContent = manualCamera ? "Camera: Manual (drag to look, space+drag to pan)" : "Camera: Auto";
    canvas.style.cursor = manualCamera ? "grab" : "default";
  }
  updateCameraButtonLabel();

  function onCameraToggle() {
    manualCamera = !manualCamera;
    isDragging = false;
    isPanning = false;
    // Auto mode always starts back at the centered, default landscape
    // framing (not wherever manual mode's drag/zoom left off) — from there
    // it may immediately ease toward a conversation focus point if one is
    // active (see frame()'s auto-focus block), but never inherits manual's
    // angle/elevation/zoom.
    if (!manualCamera) {
      panTargetX = 0;
      panTargetZ = 0;
      camAngle = DEFAULT_CAM_ANGLE;
      camElevation = CAMERA_ELEVATION;
      zoomRadius = CAMERA_RADIUS;
    }
    updateCameraButtonLabel();
  }
  cameraButton.addEventListener("click", onCameraToggle);

  function onWheel(event) {
    event.preventDefault();
    zoomRadius = Math.min(MAX_ZOOM_RADIUS, Math.max(MIN_ZOOM_RADIUS, zoomRadius + event.deltaY * ZOOM_SPEED));
  }
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // Space is tracked globally (not just while the canvas has focus — a
  // bare <canvas> isn't even focusable here) but ignored while some other
  // on-page control (e.g. a lobby chat box) is what's actually focused, so
  // this doesn't eat spaces the user is typing elsewhere.
  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
  }
  function onKeyDown(event) {
    if (event.code !== "Space" || isTypingTarget(event.target)) return;
    spacePressed = true;
    event.preventDefault(); // stop the page from scrolling on space
  }
  function onKeyUp(event) {
    if (event.code === "Space") spacePressed = false;
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function onMouseDown(event) {
    if (event.button !== 0 || !manualCamera) return;
    isDragging = true;
    isPanning = spacePressed;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    canvas.style.cursor = isPanning ? "move" : "grabbing";
  }
  function onMouseMove(event) {
    if (!isDragging) return;
    const dx = event.clientX - lastMouseX;
    const dy = event.clientY - lastMouseY;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    if (isPanning) {
      // Ground-plane right/back vectors for the current azimuth (back
      // matches the frame() camera-position formula's own sin/cos terms —
      // the direction from the orbit target toward the camera) — dragging
      // feels like grabbing the ground itself: content follows the cursor.
      const rightX = Math.cos(camAngle);
      const rightZ = -Math.sin(camAngle);
      const backX = Math.sin(camAngle);
      const backZ = Math.cos(camAngle);
      const scale = PAN_SENSITIVITY * zoomRadius;
      panTargetX -= rightX * dx * scale;
      panTargetZ -= rightZ * dx * scale;
      panTargetX -= backX * dy * scale;
      panTargetZ -= backZ * dy * scale;
      panTargetX = Math.min(PAN_TARGET_BOUND, Math.max(-PAN_TARGET_BOUND, panTargetX));
      panTargetZ = Math.min(PAN_TARGET_BOUND, Math.max(-PAN_TARGET_BOUND, panTargetZ));
    } else {
      camAngle -= dx * DRAG_SENSITIVITY;
      camElevation = Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, camElevation + dy * DRAG_SENSITIVITY));
    }
  }
  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    isPanning = false;
    canvas.style.cursor = manualCamera ? "grab" : "default";
  }
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    for (let i = 0; i < characters.length; i++) {
      updateCharacter(characters[i], i, characters, now, dt);
    }
    // Runs after every character's own state-machine step (which is what
    // actually moves x/z), and before positions get pushed to the rigs
    // below — otherwise two characters' independent movement decisions
    // could walk them straight through each other with nothing to stop it.
    resolveCollisions(characters, now);
    for (const character of characters) {
      character.rig.group.position.set(character.x, character.y, character.z);
      character.rig.group.rotation.y = character.facingAngle;
    }

    // Resize (and camera.aspect, which its projection matrix depends on)
    // handled *before* the camera position/clamp math below, not after —
    // otherwise a frame where the canvas just changed size would compute
    // screen-space clamping against camera.aspect from the *previous*
    // frame's size while already using this frame's fresh pixel
    // dimensions for the margin math, a one-frame mismatch between the
    // two that (rarely, but possibly repeatedly in a webview that
    // reports fluctuating layout sizes) could let a bubble's edge
    // compute as on-screen when it was actually just about to overflow.
    const width = canvas.clientWidth || canvas.getBoundingClientRect().width;
    const height = canvas.clientHeight || canvas.getBoundingClientRect().height;
    if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }

    // Auto camera: fixed at the default centered/landscape framing, except
    // it eases (pan + zoom) toward whoever currently has a chat bubble up,
    // so an active conversation gets visually focused on — and eases back
    // to the centered default the moment no bubble is showing. Manual
    // camera is completely unaffected — this block only ever runs when
    // manualCamera is false.
    if (!manualCamera) {
      const focus = getConversationFocusPoint(conversationState);
      const targetPanX = focus ? focus.x : 0;
      const targetPanZ = focus ? focus.z : 0;
      const targetZoom = focus ? AUTO_FOCUS_ZOOM_RADIUS : CAMERA_RADIUS;
      const lerpT = Math.min(1, AUTO_FOCUS_LERP_SPEED * dt);
      panTargetX += (targetPanX - panTargetX) * lerpT;
      panTargetZ += (targetPanZ - panTargetZ) * lerpT;
      zoomRadius += (targetZoom - zoomRadius) * lerpT;
    }
    camera.position.set(
      panTargetX + Math.sin(camAngle) * Math.cos(camElevation) * zoomRadius,
      PAN_TARGET_Y + Math.sin(camElevation) * zoomRadius,
      panTargetZ + Math.cos(camAngle) * Math.cos(camElevation) * zoomRadius,
    );
    camera.lookAt(panTargetX, PAN_TARGET_Y, panTargetZ);
    // After the camera's own position *and* aspect for this frame are both
    // finalized, since the chat bubble's and name labels' on-screen-
    // constant-size scaling (see character.js's scaleChatBubble/
    // scaleNameLabel) needs this frame's actual distance and projection,
    // not a stale one.
    const viewportWidthPx = lastWidth || canvas.width;
    const viewportHeightPx = lastHeight || canvas.height;
    for (const character of characters) {
      scaleNameLabel(character.rig, camera, viewportHeightPx);
    }
    updateConversation(conversationState, characters, now, {
      camera,
      heightPx: viewportHeightPx,
      widthPx: viewportWidthPx,
    });

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  el._glsimsCleanup = () => {
    cancelAnimationFrame(rafId);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    cameraButton.removeEventListener("click", onCameraToggle);
    disposeConversation(conversationState);
    for (const character of characters) disposeCharacter(scene, character);
    renderer.dispose();
    if (activeConversationState === conversationState) activeConversationState = null;
  };
}

// Routed here from chat.js's generic 'game.event' dispatch
// (window.CheddarGames[key].onEvent(event, data)) — the reply to this
// mount's own get_conversations request above, or an error if it failed.
export function onEvent(event, data) {
  if (!activeConversationState) return;
  if (event === "conversations") {
    setConversationLines(activeConversationState, data);
  } else if (event === "error") {
    console.warn("GL Sims: failed to fetch conversation data —", data?.message);
  }
}

export function unmount(el) {
  if (el && el._glsimsCleanup) {
    el._glsimsCleanup();
    delete el._glsimsCleanup;
  }
}

window.CheddarGames = window.CheddarGames || {};
window.CheddarGames["glsims"] = { mount, unmount, onEvent };
