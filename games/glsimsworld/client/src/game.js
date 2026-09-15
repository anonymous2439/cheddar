// GL Sims World — a single persistent shared multiplayer space: you claim
// one of the 25 karirs racer skins, walk around, and chat live with
// whoever else is currently connected. Genuinely different from GL Sims
// itself (see games/glsims/client) despite sharing its visual rig/pose/
// bubble code (imported directly below) — there's no autonomous AI here at
// all, every character on screen (including your own) is a real connected
// person, and "conversation" is live-typed chat, not a played-back script.
//
// Movement is fully client-authoritative (this client decides its own
// position from keyboard input and just broadcasts it — see
// net/worldSocket.js) — the server only owns the racer claim itself and
// the persisted chat log.
import * as THREE from "three";
import {
  buildStickFigure,
  applyIdlePose,
  updateWalkCycle,
  setFaceExpression,
  createChatBubble,
  computeBubbleAnchorWorld,
  positionChatBubbleAt,
  scaleChatBubble,
  clampWorldPointToScreen,
  disposeChatBubble,
  scaleNameLabel,
  syncNameLabel,
  disposeRig,
} from "../../../glsims/client/src/character.js";
import { connectWorldSocket, NETWORK_TICK_MS } from "./net/worldSocket.js";

// Same 25-racer roster, same order, as games/glsimsworld/api/app/main.py's
// ROSTER — order matters here since each racer's color is picked by its
// index in this list, kept in sync by hand (same convention every other
// service in this project already uses for its own copy of this roster).
const ROSTER = [
  "Neil Axinto", "Aby Calago", "Ashley Bayarcal", "Brian Lisondra", "Carl Perral",
  "Chaimel Enjambre", "Elieser Tajanlangit", "Jayson Martinez", "Jerome Madelo", "Jhoewell Posas",
  "Jhon Pabroa", "John Macapaz", "John Leo Salac", "Jonah Taganahan", "Joshua Paulo",
  "Troy Alonsagay", "Grace Vellina", "Mat Ando", "Michael Tonilon", "Mike Miñoza",
  "Novel Chavez", "Percival Mansueto", "Rashed Perez", "Roland Clarion", "Xiao",
];
const CHARACTER_COLORS = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#22d3ee", "#818cf8", "#e879f9", "#f472b6"];
function colorForRacer(racer) {
  const idx = ROSTER.indexOf(racer);
  return CHARACTER_COLORS[(idx >= 0 ? idx : 0) % CHARACTER_COLORS.length];
}

// Same wide-rectangle arena GL Sims itself uses (already comfortably sized
// for all 25 racers) — duplicated rather than imported from
// simulation.js, since that module is otherwise entirely autonomous-AI
// specific and nothing else there applies to this client-driven game.
const ARENA_HALF_X = 18;
const ARENA_HALF_Z = 6;
const MOVE_SPEED = 1.3; // matches GL Sims' own WALK_SPEED, so the shared walk-cycle animation reads at the right cadence

const CAMERA_RADIUS = 10;
const CAMERA_HEIGHT = 7;
const CAMERA_ELEVATION = Math.atan2(CAMERA_HEIGHT, CAMERA_RADIUS);
const DEFAULT_CAM_ANGLE = 0;
const MIN_ZOOM_RADIUS = 5;
const MAX_ZOOM_RADIUS = 45;
const ZOOM_SPEED = 0.02;
const MIN_ELEVATION = 0.1;
const MAX_ELEVATION = 1.45;
const DRAG_SENSITIVITY = 0.006;
// How fast the camera's own look-at target eases toward the local player's
// live position — a light ease rather than a hard snap, so walking reads
// smoothly instead of jittering the camera on every tiny movement.
const CAMERA_FOLLOW_LERP_SPEED = 6;

const BUBBLE_VISIBLE_MS = 8000;
const PAN_TARGET_Y = 1;

function randomArenaPoint() {
  return {
    x: (Math.random() * 2 - 1) * (ARENA_HALF_X - 1.5),
    z: (Math.random() * 2 - 1) * (ARENA_HALF_Z - 1.5),
  };
}

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

// Computes where a bubble should end up this frame: the natural
// "above the head" anchor, stacked upward by half the bubble's own
// height, then clamped to stay on screen — same pipeline GL Sims'
// conversation.js uses for its own bubbles (see that file's own comment
// for why clamping the *stacked* point matters, not the pre-stack one).
function computeClampedBubbleTarget(character, sprite, viewport) {
  const baseAnchor = computeBubbleAnchorWorld(character);
  scaleChatBubble(baseAnchor, sprite, viewport.camera, viewport.heightPx);
  const stackedTarget = { x: baseAnchor.x, y: baseAnchor.y + sprite.scale.y / 2, z: baseAnchor.z };
  const clamped = clampWorldPointToScreen(
    stackedTarget,
    viewport.camera,
    sprite.userData.canvasWidth / 2,
    sprite.userData.canvasHeight / 2,
    viewport.widthPx,
    viewport.heightPx,
  );
  scaleChatBubble(clamped, sprite, viewport.camera, viewport.heightPx);
  return clamped;
}

export function mount(el, ctx) {
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
  status.textContent = `Connecting as ${ctx.racer}…`;
  header.appendChild(status);

  const cameraButton = document.createElement("button");
  cameraButton.style.fontSize = "11px";
  cameraButton.style.padding = "2px 8px";
  cameraButton.style.cursor = "pointer";
  header.appendChild(cameraButton);
  wrap.appendChild(header);

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  canvas.style.width = "100%";
  canvas.style.maxWidth = "720px";
  canvas.style.display = "block";
  canvas.style.borderRadius = "4px";
  wrap.appendChild(canvas);

  const chatRow = document.createElement("div");
  chatRow.style.display = "flex";
  chatRow.style.gap = "6px";
  chatRow.style.margin = "6px 0";
  const chatInput = document.createElement("input");
  chatInput.type = "text";
  chatInput.placeholder = "Say something… (Enter to send)";
  chatInput.style.flex = "1";
  chatInput.style.fontSize = "12px";
  chatInput.maxLength = 500;
  const chatSendBtn = document.createElement("button");
  chatSendBtn.textContent = "Send";
  chatSendBtn.style.fontSize = "11px";
  chatRow.appendChild(chatInput);
  chatRow.appendChild(chatSendBtn);
  wrap.appendChild(chatRow);

  const logLabel = document.createElement("p");
  logLabel.textContent = "Chat log";
  logLabel.style.fontSize = "11px";
  logLabel.style.color = "#a3a3a3";
  logLabel.style.margin = "4px 0 2px 0";
  wrap.appendChild(logLabel);
  const chatLogEl = document.createElement("div");
  chatLogEl.style.fontSize = "11px";
  chatLogEl.style.maxHeight = "120px";
  chatLogEl.style.overflowY = "auto";
  chatLogEl.style.border = "1px solid #3333334d";
  chatLogEl.style.borderRadius = "4px";
  chatLogEl.style.padding = "4px 6px";
  wrap.appendChild(chatLogEl);

  el.appendChild(wrap);

  function appendLog(racer, text) {
    const p = document.createElement("p");
    p.style.margin = "1px 0";
    p.style.wordBreak = "break-word";
    const strong = document.createElement("strong");
    strong.textContent = `${racer}: `;
    p.appendChild(strong);
    p.appendChild(document.createTextNode(text));
    chatLogEl.appendChild(p);
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }

  const { renderer, scene, camera } = createScene(canvas);

  const localColor = colorForRacer(ctx.racer);
  const localRig = buildStickFigure(localColor, ctx.racer);
  const localSpawn = randomArenaPoint();
  const local = {
    name: ctx.racer,
    x: localSpawn.x,
    y: 0,
    z: localSpawn.z,
    facingAngle: 0,
    rig: localRig,
    isMoving: false,
    bubble: null,
    bubbleTimeout: 0,
  };
  local.rig.group.position.set(local.x, local.y, local.z);
  scene.add(local.rig.group);

  // racer name -> peer state, for everyone *else* currently connected.
  const peers = new Map();

  function ensurePeer(racer, displayName, x, z, facing) {
    let peer = peers.get(racer);
    if (!peer) {
      const rig = buildStickFigure(colorForRacer(racer), racer);
      scene.add(rig.group);
      peer = {
        name: racer,
        displayName,
        rig,
        x,
        y: 0,
        z,
        facingAngle: facing,
        targetX: x,
        targetZ: z,
        targetFacing: facing,
        isMoving: false,
        bubble: null,
        bubbleTimeout: 0,
      };
      peer.rig.group.position.set(x, 0, z);
      peer.rig.group.rotation.y = facing;
      peers.set(racer, peer);
    }
    return peer;
  }

  function removePeer(racer) {
    const peer = peers.get(racer);
    if (!peer) return;
    if (peer.bubble) {
      scene.remove(peer.bubble);
      disposeChatBubble(peer.bubble);
    }
    scene.remove(peer.rig.group);
    disposeRig(peer.rig);
    peers.delete(racer);
  }

  function showBubbleFor(character, text, viewport) {
    if (character.bubble) {
      scene.remove(character.bubble);
      disposeChatBubble(character.bubble);
      clearTimeout(character.bubbleTimeout);
    }
    // createChatBubble's first arg is the *speaker name* shown inside the
    // bubble — always the racer name (character.name), not the display
    // name, so remote players see the same in-character label above
    // every head.
    const sprite = createChatBubble(character.name, text, viewport.widthPx);
    scene.add(sprite);
    character.bubble = sprite;
    character.bubbleTimeout = setTimeout(() => {
      if (character.bubble === sprite) {
        scene.remove(sprite);
        disposeChatBubble(sprite);
        character.bubble = null;
      }
    }, BUBBLE_VISIBLE_MS);
  }

  let camAngle = DEFAULT_CAM_ANGLE;
  let camElevation = CAMERA_ELEVATION;
  let zoomRadius = CAMERA_RADIUS;
  let followX = local.x;
  let followZ = local.z;
  let manualCamera = false;
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  function updateCameraButtonLabel() {
    cameraButton.textContent = manualCamera ? "Camera: Manual (drag to look)" : "Camera: Auto";
    canvas.style.cursor = manualCamera ? "grab" : "default";
  }
  updateCameraButtonLabel();

  function onCameraToggle() {
    manualCamera = !manualCamera;
    isDragging = false;
    if (!manualCamera) {
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

  function onMouseDown(event) {
    if (event.button !== 0 || !manualCamera) return;
    isDragging = true;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    canvas.style.cursor = "grabbing";
  }
  function onMouseMove(event) {
    if (!isDragging) return;
    const dx = event.clientX - lastMouseX;
    const dy = event.clientY - lastMouseY;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    camAngle -= dx * DRAG_SENSITIVITY;
    camElevation = Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, camElevation + dy * DRAG_SENSITIVITY));
  }
  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    canvas.style.cursor = manualCamera ? "grab" : "default";
  }
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  // Movement input — plain world-axis WASD/arrows (not camera-relative),
  // deliberately simpler than Luba's facing-relative strafe: this is
  // casual walking around a flat wide arena, not combat needing precise
  // orientation control.
  const pressed = new Set();
  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
  }
  function onKeyDown(event) {
    if (isTypingTarget(event.target)) return;
    pressed.add(event.code);
  }
  function onKeyUp(event) {
    pressed.delete(event.code);
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function sendChatNow() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    socket.sendChat(text);
    // Optimistic local echo — the server excludes the sender from its own
    // broadcast of this same message (see main.py's /ws chat handling),
    // so this is the only place the sender's own message actually shows.
    showBubbleFor(local, text, currentViewport());
    appendLog(ctx.racer, text);
  }
  chatSendBtn.addEventListener("click", sendChatNow);
  chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendChatNow();
    }
  });

  function currentViewport() {
    return { camera, widthPx: lastWidth || canvas.width, heightPx: lastHeight || canvas.height };
  }

  let lastWidth = 0;
  let lastHeight = 0;
  let lastFrameTime = performance.now();
  let lastNetworkTickAt = 0;
  let rafId = 0;
  let disposed = false;

  function onSocketMessage(msg) {
    if (msg.type === "roster") {
      for (const p of msg.players) ensurePeer(p.racer, p.display_name, p.x, p.z, p.facing);
      status.textContent = `Connected as ${ctx.racer}`;
    } else if (msg.type === "chat_history") {
      for (const m of msg.messages) appendLog(m.racer, m.text);
    } else if (msg.type === "joined") {
      // No rig created here — this racer's *actual* spawn position isn't
      // known yet (their own client picks a random spot, not (0,0,0)), so
      // creating one now would just flash at the origin for a moment
      // before their first position tick corrects it. The "position"
      // handler below creates the peer lazily instead, the first time it
      // actually knows where they are.
      if (msg.racer !== ctx.racer) appendLog("System", `${msg.display_name} joined as ${msg.racer}`);
    } else if (msg.type === "position") {
      const peer = ensurePeer(msg.racer, "", msg.x, msg.z, msg.facing);
      peer.targetX = msg.x;
      peer.targetZ = msg.z;
      peer.targetFacing = msg.facing;
      peer.isMoving = Math.hypot(msg.x - peer.x, msg.z - peer.z) > 0.01;
    } else if (msg.type === "chat") {
      const peer = peers.get(msg.racer);
      if (peer) showBubbleFor(peer, msg.text, currentViewport());
      appendLog(msg.racer, msg.text);
    } else if (msg.type === "left") {
      appendLog("System", `${msg.racer} left`);
      removePeer(msg.racer);
    } else if (msg.type === "rejected") {
      const reasons = {
        taken: "Someone just took that racer — pick another.",
        already_in_world: "You're already connected as another racer.",
        unknown_racer: "Unknown racer.",
        unauthorized: "Not logged in.",
      };
      status.textContent = reasons[msg.reason] || `Could not join (${msg.reason}).`;
      ctx.onRejected?.();
    } else if (msg.type === "_disconnected") {
      status.textContent = "Disconnected from GL Sims World.";
    } else if (msg.type === "_error") {
      status.textContent = `Error: ${msg.message}`;
    }
  }

  const socket = connectWorldSocket(ctx.racer, ctx.displayName, onSocketMessage);

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    // Local movement — camera-relative (W always moves toward whatever the
    // camera is currently looking at, A/D strafe relative to it), same
    // idea as Luba's own forward/right-from-facing convention, just
    // derived from camAngle instead of a character-controlled facing
    // since it's the *camera* the player drags here, not a separate look
    // direction. forward/right below are the exact same ground-plane
    // vectors GL Sims' own game.js already uses for its space+drag pan
    // feature (confirmed consistent there), reused here for the same
    // "matches how dragging this camera already feels" reason. In auto
    // mode camAngle is always DEFAULT_CAM_ANGLE (0), which reduces this to
    // the exact same fixed -Z-forward mapping already in place before —
    // so auto mode's behavior is unchanged, only manual mode's actually
    // rotates with the drag.
    const forwardX = -Math.sin(camAngle);
    const forwardZ = -Math.cos(camAngle);
    const rightX = Math.cos(camAngle);
    const rightZ = -Math.sin(camAngle);
    let moveForward = 0;
    let moveStrafe = 0;
    if (pressed.has("KeyW") || pressed.has("ArrowUp")) moveForward += 1;
    if (pressed.has("KeyS") || pressed.has("ArrowDown")) moveForward -= 1;
    if (pressed.has("KeyA") || pressed.has("ArrowLeft")) moveStrafe -= 1;
    if (pressed.has("KeyD") || pressed.has("ArrowRight")) moveStrafe += 1;
    let moveX = forwardX * moveForward + rightX * moveStrafe;
    let moveZ = forwardZ * moveForward + rightZ * moveStrafe;
    const moveLen = Math.hypot(moveX, moveZ);
    local.isMoving = moveLen > 0.001;
    if (local.isMoving) {
      moveX /= moveLen;
      moveZ /= moveLen;
      local.x = Math.min(ARENA_HALF_X, Math.max(-ARENA_HALF_X, local.x + moveX * MOVE_SPEED * dt));
      local.z = Math.min(ARENA_HALF_Z, Math.max(-ARENA_HALF_Z, local.z + moveZ * MOVE_SPEED * dt));
      local.facingAngle = Math.atan2(moveX, moveZ);
      updateWalkCycle(local.rig, dt);
    } else {
      applyIdlePose(local.rig, dt);
    }
    setFaceExpression(local.rig, "neutral");
    local.rig.group.position.set(local.x, local.y, local.z);
    local.rig.group.rotation.y = local.facingAngle;
    syncNameLabel(local.rig);

    // Peers ease toward their latest network update rather than snapping,
    // same reasoning Luba's own peer rendering already uses.
    for (const peer of peers.values()) {
      const ease = Math.min(1, 12 * dt);
      peer.x += (peer.targetX - peer.x) * ease;
      peer.z += (peer.targetZ - peer.z) * ease;
      peer.facingAngle = peer.targetFacing;
      if (peer.isMoving) updateWalkCycle(peer.rig, dt);
      else applyIdlePose(peer.rig, dt);
      setFaceExpression(peer.rig, "neutral");
      peer.rig.group.position.set(peer.x, peer.y, peer.z);
      peer.rig.group.rotation.y = peer.facingAngle;
      syncNameLabel(peer.rig);
    }

    // Network tick — position only; chat is sent immediately on submit,
    // not batched onto this timer.
    if (now - lastNetworkTickAt >= NETWORK_TICK_MS) {
      lastNetworkTickAt = now;
      socket.sendPosition(local.x, local.z, local.facingAngle);
    }

    const width = canvas.clientWidth || canvas.getBoundingClientRect().width;
    const height = canvas.clientHeight || canvas.getBoundingClientRect().height;
    if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }

    const followEase = Math.min(1, CAMERA_FOLLOW_LERP_SPEED * dt);
    followX += (local.x - followX) * followEase;
    followZ += (local.z - followZ) * followEase;
    camera.position.set(
      followX + Math.sin(camAngle) * Math.cos(camElevation) * zoomRadius,
      PAN_TARGET_Y + Math.sin(camElevation) * zoomRadius,
      followZ + Math.cos(camAngle) * Math.cos(camElevation) * zoomRadius,
    );
    camera.lookAt(followX, PAN_TARGET_Y, followZ);

    const viewport = currentViewport();
    scaleNameLabel(local.rig, camera, viewport.heightPx);
    if (local.bubble) positionChatBubbleAt(local.bubble, computeClampedBubbleTarget(local, local.bubble, viewport));
    for (const peer of peers.values()) {
      scaleNameLabel(peer.rig, camera, viewport.heightPx);
      if (peer.bubble) positionChatBubbleAt(peer.bubble, computeClampedBubbleTarget(peer, peer.bubble, viewport));
    }

    renderer.render(scene, camera);
    if (!disposed) rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  el._glsimsWorldCleanup = () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    socket.dispose();
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    cameraButton.removeEventListener("click", onCameraToggle);
    if (local.bubble) disposeChatBubble(local.bubble);
    clearTimeout(local.bubbleTimeout);
    disposeRig(local.rig);
    for (const racer of [...peers.keys()]) removePeer(racer);
    renderer.dispose();
  };
}

export function unmount(el) {
  if (el && el._glsimsWorldCleanup) {
    el._glsimsWorldCleanup();
    delete el._glsimsWorldCleanup;
  }
}

window.CheddarGames = window.CheddarGames || {};
window.CheddarGames["glsimsworld"] = { mount, unmount };
