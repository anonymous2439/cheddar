// Model Viewer — load a rigged FBX character model and look it over with a
// free-orbit camera. Ported from web/src/games/modelviewer/ModelViewerGame.tsx
// (the web app's version) — same model, same material fixups, same
// procedural runway-walk bone animation, just re-hosted as the vanilla
// mount(el)/unmount(el) shape every other vscode game module here uses
// instead of a React component.
//
// Hidden game (see api/app/core/games_catalog.py's "hidden" flag — only
// reachable via /games hidden until it's mature enough to unhide) and,
// unlike every other vscode game module, it doesn't bundle its own assets:
// the FBX + textures are a ~71MB user-supplied asset set (see web/.gitignore),
// far too large to ship inside the extension's vsix for every user on every
// /update. Instead it fetches them at runtime straight from the same static
// files the web app's own build already serves (vite's publicDir copy-
// through puts web/public/models/ into web/dist/models/, reachable at
// {apiHost}/cheddar/models/... — confirmed reachable directly). No
// networking/lobby/session state beyond that single asset fetch — a single
// local viewer, same "pure client" shape as GL Sims.
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Baked into the page by extension.ts from the user's own vscode settings
// (window.CheddarModelViewerAssetBaseUrl — same pattern as Luba's
// window.CheddarLubaWsBaseUrl) — falls back to the production host directly
// so this still works if loaded standalone without that config tag.
const DEFAULT_ASSET_BASE_URL = "http://109.123.234.69/cheddar/models";
function assetBaseUrl() {
  return window.CheddarModelViewerAssetBaseUrl || DEFAULT_ASSET_BASE_URL;
}

// Roughly human height in meters — ripped game-model FBX files commonly come
// in at an arbitrary source scale (often centimeters, sometimes something
// stranger), so the model is rescaled to this after loading rather than
// trusting whatever scale it exports at.
const TARGET_HEIGHT_M = 1.75;

// This particular FBX's texture *references* are just generic placeholders
// (every material's map is literally named "base_color_texture", with no
// real filename or embedded image data survives the export) — confirmed by
// loading it standalone and inspecting each material: every `map` was a
// Texture object with no `.image` at all. An empty texture bound to a
// material's map slot makes WebGL treat the whole draw as incomplete, which
// is why the model rendered as fully invisible rather than just untextured.
//
// So textures are matched up by hand here instead of trusting FBXLoader's
// (broken, for this file) automatic resolution — this table was built by
// loading the model standalone and reading off its actual material names.
// Four materials (eyelash, gaoguang/specular-highlight, "03", "siwa") have
// no corresponding file in the extracted texture set at all — left out here
// on purpose rather than guessed, so they just render as an untextured flat
// color instead of something confidently wrong.
const MATERIAL_TEXTURE_OVERRIDES = {
  eye_bantou: "T_player_042_Blackbird_eyes_d.png",
  MI_player_043_alphard_face: "T_player_042_Blackbird_face_d.png",
  MI_player_043_alphard_eyes: "T_player_042_Blackbird_eyes_d.png",
  MI_player_042_Blackbird_05: "T_player_042_Blackbird_05_d.png",
  MI_player_042_Blackbird_yumao_06: "T_player_042_Blackbird_yumao_d.png",
  MI_player_042_Blackbird_hair_01: "T_player_042_Blackbird_hair1_d.png",
  MI_player_042_Blackbird_hair_02: "T_player_042_Blackbird_hair2_d.png",
  MI_player_042_Blackbird_01: "T_player_042_Blackbird_01_d.png",
  MI_player_042_Blackbird_02: "T_player_042_Blackbird_02_d.png",
};

// Confirmed by a separate diagnostic pass (rendering every material as a
// distinct flat unlit color to see which geometry it actually covers): every
// single material in this FBX parses to the exact same generic fallback
// (color #cccccc). White is a reasonable default for the four still-
// untextured materials — except "alphard_eyelash", which sits directly
// across the eye as the eyelash/eyeliner line shape; a white eyelash reads
// as a stray light smear right over the eye, so that one gets an explicit
// dark tone instead.
const MATERIAL_COLOR_OVERRIDES = {
  MI_player_043_alphard_eyelash: 0x1a1310,
};

// A procedural "catwalk" walk cycle — this rig is a standard 3ds Max Biped
// skeleton (Bip001-Pelvis/Spine/Spine1/Spine2/L-R-Thigh/Calf/UpperArm etc.),
// driven by rotating named bones each frame rather than playing one of the
// FBX's own baked animation clips — those all turned out to be generic
// "DefaultSlot" showcase clips (idle/pose loops for a character-profile
// screen), none of them a walk.
const WALK_BONE_NAMES = [
  "Bip001-Pelvis",
  "Bip001-Spine",
  "Bip001-Spine1",
  "Bip001-Spine2",
  "Bip001-L-Thigh",
  "Bip001-R-Thigh",
  "Bip001-L-Calf",
  "Bip001-R-Calf",
  "Bip001-L-UpperArm",
  "Bip001-R-UpperArm",
];
const WALK_FREQUENCY = 1.7; // rad/sec — a slow, deliberate runway cadence, not a brisk casual walk
const WALK_BLEND_RATE = 4; // how fast the pose eases in/out of the walk when toggled, not the walk's own speed
const HIP_SWAY = 0.28; // pelvis lateral tilt — the single biggest contributor to the "runway" read
// Split across all three spine segments so their *sum* cancels HIP_SWAY
// almost entirely by the top of the spine (one segment alone isn't enough —
// Spine1/Spine2/neck/head/hat all inherit rotation from everything below
// them in the chain).
const SPINE_COUNTER_SWAY = -HIP_SWAY * 0.45;
const SPINE1_COUNTER_SWAY = -HIP_SWAY * 0.3;
const SPINE2_COUNTER_SWAY = -HIP_SWAY * 0.2;
const STRIDE_AMOUNT = 0.5;
const KNEE_BEND = 0.7;
const ARM_SWING = 0.22; // deliberately subtler than a normal walk — runway models keep their arms fairly still
const BOB_AMOUNT = 0.02;

// Animation Maker — pose the loaded rig with sliders, capture keyframes,
// and preview the resulting loop live on the same model. Ported from
// glophimon's own Pose Designer (same keyframe data shape — an ordered
// list of { values: {[key]: number}, transitionMs } — and the same
// linear-blend/wrap-around playback, see playAnimationKeyframes below) —
// but keyed by this rig's own real FBX bone names instead of a handful of
// hand-built rig.leftArm/rig.head-style Object3D properties, since this is
// a ~900-bone ripped biped skeleton (confirmed by walking the actual
// loaded model in a standalone scan), not a small hand-authored one.
// Curated down to the ~22 main Biped joints below — the rest are secondary
// hair/cloth/muscle helper bones (named "Bn_"/"feather"/"qun"/"-Twist" etc.
// in the real skeleton) not meaningful to pose by hand.
//
// Every bone's *bind*-pose rotation on this rig is non-zero (confirmed by
// inspecting the loaded skeleton directly — e.g. Bip001-Pelvis sits at
// roughly (-90°, 0°, -90°) at rest, Bip001-L-Clavicle at roughly (0°, 71°,
// 180°)), so every slider here is an *offset* from that bind rotation,
// applied the same way the existing procedural walk cycle already does it
// (see WALK_BONE_NAMES/applyWalkDelta above) — a slider at 0 always means
// "however this bone naturally sits," never "zero rotation."
//
// Range/sign conventions below are reasonable estimates carried over from
// glophimon's own analogous joints (arms swing roughly ±π, legs/elbows/
// knees roughly ±1.6-2.6, head/spine more subtly) rather than confirmed
// frame-by-frame against this specific rig's own local axes — nothing here
// is destructive, so if a particular slider's direction or range feels
// wrong once you're actually posing the model, just widen/flip it here.
const ANIMATION_MAKER_PARTS = [
  { key: "rootHeight", label: "Root Height (crouch/bounce)", group: "Root", bone: "__root__", axis: "posY", min: -0.4, max: 0.5, step: 0.01 },
  { key: "rootTurn", label: "Root Turn", group: "Root", bone: "__root__", axis: "rotY", min: -3.14, max: 3.14, step: 0.02 },

  { key: "pelvisTilt", label: "Pelvis Tilt Fwd/Back", group: "Torso", bone: "Bip001-Pelvis", axis: "x", min: -0.8, max: 0.8, step: 0.02 },
  { key: "pelvisTwist", label: "Pelvis Twist", group: "Torso", bone: "Bip001-Pelvis", axis: "y", min: -0.8, max: 0.8, step: 0.02 },
  { key: "pelvisSway", label: "Pelvis Sway Side", group: "Torso", bone: "Bip001-Pelvis", axis: "z", min: -0.6, max: 0.6, step: 0.02 },
  { key: "spineBend", label: "Spine Bend", group: "Torso", bone: "Bip001-Spine", axis: "x", min: -0.5, max: 0.5, step: 0.02 },
  { key: "spineLean", label: "Spine Lean", group: "Torso", bone: "Bip001-Spine", axis: "z", min: -0.5, max: 0.5, step: 0.02 },
  { key: "spine1Bend", label: "Upper Spine Bend", group: "Torso", bone: "Bip001-Spine1", axis: "x", min: -0.5, max: 0.5, step: 0.02 },
  { key: "spine1Lean", label: "Upper Spine Lean", group: "Torso", bone: "Bip001-Spine1", axis: "z", min: -0.5, max: 0.5, step: 0.02 },
  { key: "spine2Bend", label: "Chest Bend", group: "Torso", bone: "Bip001-Spine2", axis: "x", min: -0.5, max: 0.5, step: 0.02 },
  { key: "spine2Lean", label: "Chest Lean", group: "Torso", bone: "Bip001-Spine2", axis: "z", min: -0.5, max: 0.5, step: 0.02 },

  { key: "neckNod", label: "Neck Nod", group: "Head", bone: "Bip001-Neck", axis: "x", min: -0.6, max: 0.6, step: 0.02 },
  { key: "neckTurn", label: "Neck Turn", group: "Head", bone: "Bip001-Neck", axis: "y", min: -0.8, max: 0.8, step: 0.02 },
  { key: "neckTilt", label: "Neck Tilt", group: "Head", bone: "Bip001-Neck", axis: "z", min: -0.5, max: 0.5, step: 0.02 },
  { key: "headNod", label: "Head Nod", group: "Head", bone: "Bip001-Head", axis: "x", min: -0.7, max: 0.7, step: 0.02 },
  { key: "headTurn", label: "Head Turn", group: "Head", bone: "Bip001-Head", axis: "y", min: -1.0, max: 1.0, step: 0.02 },
  { key: "headTilt", label: "Head Tilt", group: "Head", bone: "Bip001-Head", axis: "z", min: -0.6, max: 0.6, step: 0.02 },

  { key: "lClavicleRaise", label: "L Shoulder Raise", group: "Left Arm", bone: "Bip001-L-Clavicle", axis: "y", min: -0.5, max: 0.5, step: 0.02 },
  { key: "lClavicleRoll", label: "L Shoulder Roll", group: "Left Arm", bone: "Bip001-L-Clavicle", axis: "z", min: -0.4, max: 0.4, step: 0.02 },
  { key: "lArmSwing", label: "L Arm Swing", group: "Left Arm", bone: "Bip001-L-UpperArm", axis: "x", min: -3.14, max: 3.14, step: 0.03 },
  { key: "lArmSpread", label: "L Arm Spread", group: "Left Arm", bone: "Bip001-L-UpperArm", axis: "z", min: -1.6, max: 1.6, step: 0.03 },
  { key: "lArmRotate", label: "L Arm Rotate", group: "Left Arm", bone: "Bip001-L-UpperArm", axis: "y", min: -1.6, max: 1.6, step: 0.03 },
  // Same twist-axis bug as L Knee Bend (see its own comment) confirmed by
  // the same forward-kinematics measurement: local X on this bone only
  // ever displaced the hand by ~16 units for a 0.8 rad test rotation
  // (a twist), while local Z displaced it by ~292 units (a real hinge) —
  // switched from x to z, range left symmetric for the same reason.
  { key: "lElbowBend", label: "L Elbow Bend", group: "Left Arm", bone: "Bip001-L-Forearm", axis: "z", min: -1.6, max: 1.6, step: 0.03 },
  { key: "lWristBend", label: "L Wrist Bend", group: "Left Arm", bone: "Bip001-L-Hand", axis: "x", min: -0.8, max: 0.8, step: 0.02 },
  { key: "lWristTilt", label: "L Wrist Tilt", group: "Left Arm", bone: "Bip001-L-Hand", axis: "z", min: -0.6, max: 0.6, step: 0.02 },

  { key: "rClavicleRaise", label: "R Shoulder Raise", group: "Right Arm", bone: "Bip001-R-Clavicle", axis: "y", min: -0.5, max: 0.5, step: 0.02 },
  { key: "rClavicleRoll", label: "R Shoulder Roll", group: "Right Arm", bone: "Bip001-R-Clavicle", axis: "z", min: -0.4, max: 0.4, step: 0.02 },
  { key: "rArmSwing", label: "R Arm Swing", group: "Right Arm", bone: "Bip001-R-UpperArm", axis: "x", min: -3.14, max: 3.14, step: 0.03 },
  { key: "rArmSpread", label: "R Arm Spread", group: "Right Arm", bone: "Bip001-R-UpperArm", axis: "z", min: -1.6, max: 1.6, step: 0.03 },
  { key: "rArmRotate", label: "R Arm Rotate", group: "Right Arm", bone: "Bip001-R-UpperArm", axis: "y", min: -1.6, max: 1.6, step: 0.03 },
  { key: "rElbowBend", label: "R Elbow Bend", group: "Right Arm", bone: "Bip001-R-Forearm", axis: "z", min: -1.6, max: 1.6, step: 0.03 }, // see L Elbow Bend's own comment — same fix, mirrored
  { key: "rWristBend", label: "R Wrist Bend", group: "Right Arm", bone: "Bip001-R-Hand", axis: "x", min: -0.8, max: 0.8, step: 0.02 },
  { key: "rWristTilt", label: "R Wrist Tilt", group: "Right Arm", bone: "Bip001-R-Hand", axis: "z", min: -0.6, max: 0.6, step: 0.02 },

  { key: "lThighSwing", label: "L Thigh Swing", group: "Left Leg", bone: "Bip001-L-Thigh", axis: "x", min: -1.6, max: 1.6, step: 0.03 },
  { key: "lThighSpread", label: "L Thigh Spread", group: "Left Leg", bone: "Bip001-L-Thigh", axis: "z", min: -1.2, max: 1.2, step: 0.03 },
  { key: "lThighRotate", label: "L Thigh Rotate", group: "Left Leg", bone: "Bip001-L-Thigh", axis: "y", min: -0.8, max: 0.8, step: 0.03 },
  // Axis changed from "x" to "z" (not just the sign, per the first pass's
  // fix, which turned out not to be the real bug) — measured directly via
  // forward kinematics (rotate the bone, read back the foot bone's own
  // world-position displacement) rather than guessed: rotating this bone's
  // local X by 0.8 rad only ever displaced the foot by ~77 units and
  // changed the shin's own direction by ~6°, i.e. local X is nearly a pure
  // twist around the shin's own long axis on this rig — exactly the
  // "rotation instead of a bend" the live testing reported. Local Z, by
  // contrast, displaced the foot by ~575 units for the same 0.8 rad input
  // and changed the shin direction by ~46° — matching the input angle
  // almost exactly, the signature of a clean hinge — and did so with
  // effectively zero sideways (world X) drift, matching how a real knee
  // only ever flexes in one plane. Range left symmetric (rather than
  // guessing a sign again) since which of +/- reads as "backward" depends
  // on this character's own facing convention, which wasn't independently
  // confirmed — try both directions live.
  { key: "lKneeBend", label: "L Knee Bend", group: "Left Leg", bone: "Bip001-L-Calf", axis: "z", min: -1.6, max: 1.6, step: 0.03 },
  { key: "lAnkleBend", label: "L Ankle Bend", group: "Left Leg", bone: "Bip001-L-Foot", axis: "x", min: -0.8, max: 0.8, step: 0.02 },
  { key: "lAnkleTilt", label: "L Ankle Tilt", group: "Left Leg", bone: "Bip001-L-Foot", axis: "z", min: -0.5, max: 0.5, step: 0.02 },
  { key: "lToeCurl", label: "L Toe Curl", group: "Left Leg", bone: "Bip001-L-Toe0", axis: "x", min: -0.6, max: 0.6, step: 0.02 },

  { key: "rThighSwing", label: "R Thigh Swing", group: "Right Leg", bone: "Bip001-R-Thigh", axis: "x", min: -1.6, max: 1.6, step: 0.03 },
  { key: "rThighSpread", label: "R Thigh Spread", group: "Right Leg", bone: "Bip001-R-Thigh", axis: "z", min: -1.2, max: 1.2, step: 0.03 },
  { key: "rThighRotate", label: "R Thigh Rotate", group: "Right Leg", bone: "Bip001-R-Thigh", axis: "y", min: -0.8, max: 0.8, step: 0.03 },
  { key: "rKneeBend", label: "R Knee Bend", group: "Right Leg", bone: "Bip001-R-Calf", axis: "z", min: -1.6, max: 1.6, step: 0.03 }, // see L Knee Bend's own comment — same fix, mirrored
  { key: "rAnkleBend", label: "R Ankle Bend", group: "Right Leg", bone: "Bip001-R-Foot", axis: "x", min: -0.8, max: 0.8, step: 0.02 },
  { key: "rAnkleTilt", label: "R Ankle Tilt", group: "Right Leg", bone: "Bip001-R-Foot", axis: "z", min: -0.5, max: 0.5, step: 0.02 },
  { key: "rToeCurl", label: "R Toe Curl", group: "Right Leg", bone: "Bip001-R-Toe0", axis: "x", min: -0.6, max: 0.6, step: 0.02 },
];

const ANIMATION_MAKER_GROUP_ORDER = ["Root", "Torso", "Head", "Left Arm", "Right Arm", "Left Leg", "Right Leg"];

function animationMakerDefaultValues() {
  const values = {};
  for (const spec of ANIMATION_MAKER_PARTS) values[spec.key] = 0;
  return values;
}

// Applies one full set of Animation Maker values onto the live model —
// shared by the slider-driven live preview and keyframe playback below, so
// the two can never render a pose differently from how it was authored.
// bonesByName/bindRotations cover every bone on the loaded rig (see
// mount()'s own onLoad handler); the two "__root__" pseudo-axes move the
// whole model instead of a bone.
function applyAnimationMakerValues(bonesByName, bindRotations, modelRoot, baseY, values) {
  for (const spec of ANIMATION_MAKER_PARTS) {
    const v = values[spec.key] ?? 0;
    if (spec.bone === "__root__") {
      if (spec.axis === "posY") modelRoot.position.y = baseY + v;
      else if (spec.axis === "rotY") modelRoot.rotation.y = v;
      continue;
    }
    const bone = bonesByName[spec.bone];
    const bind = bindRotations[spec.bone];
    if (!bone || !bind) continue;
    bone.rotation[spec.axis] = bind[spec.axis] + v;
  }
}

// Blends between consecutive keyframes and applies the result — elapsedMs
// is caller-tracked, mirrors glophimon's own playPoseKeyframes exactly,
// including the wrap-around (the very first segment blends FROM the last
// keyframe TO the first, so a looping animation never snaps). Returns
// false (and touches nothing) for an empty/missing keyframe list, so
// callers can fall through to whatever pose would otherwise apply.
function playAnimationKeyframes(bonesByName, bindRotations, modelRoot, baseY, keyframes, elapsedMs) {
  if (!keyframes || keyframes.length === 0) return false;
  const totalMs = keyframes.reduce((sum, kf) => sum + Math.max(1, kf.transitionMs), 0);
  const t = elapsedMs % totalMs;
  let prevValues = keyframes[keyframes.length - 1].values; // wraps: last -> first
  let acc = 0;
  let segmentIdx = keyframes.length - 1;
  for (let i = 0; i < keyframes.length; i++) {
    const dur = Math.max(1, keyframes[i].transitionMs);
    if (t < acc + dur) {
      segmentIdx = i;
      break;
    }
    acc += dur;
    prevValues = keyframes[i].values;
  }
  const dur = Math.max(1, keyframes[segmentIdx].transitionMs);
  const localT = Math.min(1, (t - acc) / dur);
  const toValues = keyframes[segmentIdx].values;
  const blended = {};
  for (const spec of ANIMATION_MAKER_PARTS) {
    const a = prevValues[spec.key] ?? 0;
    const b = toValues[spec.key] ?? 0;
    blended[spec.key] = a + (b - a) * localT;
  }
  applyAnimationMakerValues(bonesByName, bindRotations, modelRoot, baseY, blended);
  return true;
}

// No backend for this game module at all (see this file's own top-of-file
// comment — hidden, single-local-viewer, no networking beyond the asset
// fetch), so unlike glophimon's server-saved pose slots, saved animations
// here just live in this browser's own localStorage, keyed by name —
// Export/Import (see buildAnimationMakerPanel below) is the only way to
// move one to another machine/browser.
const ANIMATION_MAKER_STORAGE_KEY = "cheddarModelViewerAnimations";

function loadSavedAnimations() {
  try {
    const raw = localStorage.getItem(ANIMATION_MAKER_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSavedAnimations(list) {
  try {
    localStorage.setItem(ANIMATION_MAKER_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Best-effort only — a full/blocked localStorage (private window, quota)
    // just means this session's saves won't persist; Export still works.
  }
}

export function mount(el) {
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.position = "relative";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.gap = "8px";
  header.style.margin = "0 0 6px 0";

  const title = document.createElement("strong");
  title.style.fontSize = "13px";
  title.textContent = "🕊️ Model Viewer";
  header.appendChild(title);

  const walkButton = document.createElement("button");
  walkButton.style.fontSize = "11px";
  walkButton.style.padding = "2px 8px";
  walkButton.style.cursor = "pointer";
  header.appendChild(walkButton);

  const animMakerButton = document.createElement("button");
  animMakerButton.textContent = "🎬 Animation Maker";
  animMakerButton.style.fontSize = "11px";
  animMakerButton.style.padding = "2px 8px";
  animMakerButton.style.cursor = "pointer";
  animMakerButton.disabled = true; // enabled by onModelReady() once the FBX + its bones actually exist
  header.appendChild(animMakerButton);
  wrap.appendChild(header);

  const status = document.createElement("p");
  status.style.fontSize = "12px";
  status.style.margin = "0 0 6px 0";
  status.style.color = "#a3a3a3";
  status.textContent = "Loading model…";
  wrap.appendChild(status);

  // Animation Maker is a docked side panel (not a full-screen modal like
  // glophimon's Pose Designer) that poses the SAME live model shown here —
  // there's only ever one model loaded and no other game state to isolate
  // it from, so a second cloned preview scene/rig would be pure overhead.
  // See animMakerPanelEl below for the panel itself; contentRow just lets
  // canvas and panel sit side by side (wrapping to stacked on narrow
  // viewports via flex-wrap, same technique glophimon's own modals use).
  const contentRow = document.createElement("div");
  contentRow.style.display = "flex";
  contentRow.style.flexWrap = "wrap";
  contentRow.style.gap = "8px";
  contentRow.style.alignItems = "flex-start";
  wrap.appendChild(contentRow);

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  canvas.style.width = "100%";
  canvas.style.maxWidth = "720px";
  canvas.style.flex = "1 1 320px";
  canvas.style.minWidth = "0";
  canvas.style.display = "block";
  canvas.style.borderRadius = "4px";
  contentRow.appendChild(canvas);

  el.appendChild(wrap);

  let isWalking = false;
  function updateWalkButtonLabel() {
    walkButton.textContent = isWalking ? "⏹ Stop Walk" : "🚶 Walk";
  }
  function onWalkToggle() {
    isWalking = !isWalking;
    updateWalkButtonLabel();
  }
  updateWalkButtonLabel();
  walkButton.addEventListener("click", onWalkToggle);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#1b1b21");
  scene.fog = new THREE.Fog("#1b1b21", 10, 32);

  // This character's textures are flat, painted-on anime art — eyes, brows,
  // blush, and highlight shapes are already baked into the diffuse image,
  // meant to be viewed under flat/toon shading, not realistic directional
  // lighting. Weighted much more toward flat ambient, with a single gentle
  // warm-neutral light just for a touch of dimensionality, no shadow
  // casting, and no cool-colored light at all (a cool key light is what
  // originally pushed pale skin toward gray).
  scene.add(new THREE.AmbientLight("#ffffff", 1.6));
  const keyLight = new THREE.DirectionalLight("#fff8ef", 0.35);
  keyLight.position.set(3, 6, 4);
  scene.add(keyLight);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: "#28282f" }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  scene.add(new THREE.GridHelper(20, 20, "#3a3a45", "#3a3a45"));

  // Populated once the FBX finishes loading below.
  const walkBones = {};
  const walkBindRotations = {};
  // Every bone on the rig (not just WALK_BONE_NAMES' curated 10) keyed by
  // name, for Animation Maker's own broader ANIMATION_MAKER_PARTS list —
  // kept separate from walkBones/walkBindRotations above rather than
  // merged into it, so the existing walk cycle is untouched by this.
  const allBonesByName = {};
  const allBindRotations = {};
  let modelRoot = null;
  let baseY = 0;
  let walkPhase = 0;
  let walkBlend = 0;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 1.5, 3.4);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.8;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.95;

  let disposed = false;
  const modelUrl = `${assetBaseUrl()}/blackbird/blackbird.fbx`;
  const texturePath = `${assetBaseUrl()}/blackbird/textures/`;
  const loader = new FBXLoader();
  const textureLoader = new THREE.TextureLoader();
  loader.setResourcePath(texturePath);
  loader.load(
    modelUrl,
    (fbx) => {
      if (disposed) return;

      const rawSize = new THREE.Box3().setFromObject(fbx).getSize(new THREE.Vector3());
      if (rawSize.y > 0) {
        fbx.scale.setScalar(TARGET_HEIGHT_M / rawSize.y);
      }
      // Re-measure after scaling, then recenter horizontally and drop the
      // model so its lowest point sits exactly on the ground plane — the
      // FBX's own pivot/origin isn't necessarily at the feet.
      const box = new THREE.Box3().setFromObject(fbx);
      const center = box.getCenter(new THREE.Vector3());
      fbx.position.x -= center.x;
      fbx.position.z -= center.z;
      fbx.position.y -= box.min.y;

      const unmatchedMaterials = [];
      fbx.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.castShadow = true;
        obj.receiveShadow = true;

        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of materials) {
          // Drop any texture slot the FBX left as an empty placeholder —
          // this is what actually fixes the invisible-model bug,
          // independent of whether the lookup below finds a real
          // replacement.
          for (const slot of ["map", "normalMap", "specularMap", "bumpMap", "emissiveMap", "alphaMap"]) {
            const tex = mat[slot];
            if (tex && !tex.image) mat[slot] = null;
          }
          if (!mat.map) {
            const file = MATERIAL_TEXTURE_OVERRIDES[mat.name];
            if (file) {
              const tex = textureLoader.load(texturePath + file);
              tex.colorSpace = THREE.SRGBColorSpace;
              mat.map = tex;
            } else {
              unmatchedMaterials.push(mat.name);
            }
          }
          // This mesh ships per-vertex color data with vertexColors already
          // enabled on every material, which multiplies that data straight
          // into the diffuse output — almost certainly game-engine-specific
          // shader input (an AO or rim-light mask), never meant to be read
          // as a literal "tint the texture by this color".
          mat.vertexColors = false;
          // A textured material gets de-tinted to white so the texture's
          // own colors show through undiluted (the FBX parses every
          // material's color to the same generic gray fallback, which would
          // otherwise multiply against the texture and dull it toward
          // gray). An untextured one gets its explicit override if it has
          // one, or white otherwise.
          mat.color.set(mat.map ? 0xffffff : (MATERIAL_COLOR_OVERRIDES[mat.name] ?? 0xffffff));
          // Flatten the specular response — Phong's real-time specular
          // highlight sitting on top of eyes/brows/blush that are already
          // painted *with their own* highlight shapes doubles up into an
          // extra glossy sheen that doesn't match the flat 2D art.
          mat.shininess = 4;
          mat.specular.set(0x0a0a0a);
          mat.needsUpdate = true;
        }
      });
      if (unmatchedMaterials.length > 0) {
        console.warn("Model Viewer: no texture match for materials", unmatchedMaterials);
      }

      // Bind-pose rotations captured once here so the walk cycle can apply
      // its own rotation as an *offset* from the model's actual rest pose
      // (each frame sets bone.rotation.x = bind.x + delta), rather than
      // assuming 0 is neutral.
      fbx.traverse((obj) => {
        if (obj.isBone && WALK_BONE_NAMES.includes(obj.name)) {
          walkBones[obj.name] = obj;
          walkBindRotations[obj.name] = obj.rotation.clone();
        }
        if (obj.isBone) {
          allBonesByName[obj.name] = obj;
          allBindRotations[obj.name] = obj.rotation.clone();
        }
      });
      baseY = fbx.position.y;
      modelRoot = fbx;

      scene.add(fbx);
      status.textContent = "Loaded — drag to orbit, scroll to zoom.";
      onModelReady();
    },
    (progress) => {
      if (progress.total) status.textContent = `Loading model… ${Math.round((progress.loaded / progress.total) * 100)}%`;
    },
    (error) => {
      console.error("Model Viewer: failed to load FBX", error);
      status.textContent = "Failed to load the model — check the developer console for details.";
    },
  );

  // ---- Animation Maker -----------------------------------------------
  // State lives in mount()'s own closure (like glophimon's Pose Designer),
  // not reset when the panel is closed — so accidentally closing it never
  // loses in-progress work; only "Clear" resets it.
  let animationMakerOpen = false;
  let animationMakerValues = animationMakerDefaultValues();
  let animationMakerKeyframes = [];
  let animationMakerPlaying = false;
  let animationMakerPlaybackMs = 0;
  const animationMakerSliderEls = {}; // key -> {slider, valueEl}

  const animMakerPanelEl = document.createElement("div");
  animMakerPanelEl.style.display = "none";
  animMakerPanelEl.style.flexDirection = "column";
  animMakerPanelEl.style.gap = "6px";
  animMakerPanelEl.style.flex = "0 0 300px";
  animMakerPanelEl.style.maxWidth = "100%";
  animMakerPanelEl.style.maxHeight = "60vh";
  animMakerPanelEl.style.overflowY = "auto";
  animMakerPanelEl.style.background = "#1a1a1aee";
  animMakerPanelEl.style.border = "1px solid #3333334d";
  animMakerPanelEl.style.borderRadius = "6px";
  animMakerPanelEl.style.padding = "8px";
  animMakerPanelEl.style.fontSize = "11px";
  contentRow.appendChild(animMakerPanelEl);

  const animMakerHeaderRow = document.createElement("div");
  animMakerHeaderRow.style.display = "flex";
  animMakerHeaderRow.style.alignItems = "center";
  animMakerHeaderRow.style.justifyContent = "space-between";
  const animMakerHeading = document.createElement("strong");
  animMakerHeading.textContent = "Animation Maker";
  animMakerHeaderRow.appendChild(animMakerHeading);
  const animMakerCloseBtn = document.createElement("button");
  animMakerCloseBtn.textContent = "✕";
  animMakerCloseBtn.style.fontSize = "11px";
  animMakerCloseBtn.style.cursor = "pointer";
  animMakerHeaderRow.appendChild(animMakerCloseBtn);
  animMakerPanelEl.appendChild(animMakerHeaderRow);

  const animMakerNameLabel = document.createElement("label");
  animMakerNameLabel.style.display = "flex";
  animMakerNameLabel.style.gap = "6px";
  animMakerNameLabel.style.alignItems = "center";
  animMakerNameLabel.style.margin = "4px 0";
  const animMakerNameInput = document.createElement("input");
  animMakerNameInput.type = "text";
  animMakerNameInput.placeholder = "e.g. wave, bow, dance";
  animMakerNameInput.style.flex = "1";
  animMakerNameLabel.append(document.createTextNode("Name"), animMakerNameInput);
  animMakerPanelEl.appendChild(animMakerNameLabel);

  const animMakerNoModelP = document.createElement("p");
  animMakerNoModelP.style.fontSize = "10px";
  animMakerNoModelP.style.color = "#a3a3a3";
  animMakerNoModelP.textContent = "Waiting for the model to finish loading…";
  animMakerPanelEl.appendChild(animMakerNoModelP);

  // One <details> section per ANIMATION_MAKER_GROUP_ORDER entry, each its
  // own scrollable-with-the-panel collapsible group (open by default —
  // functionally a flat list until the user chooses to collapse one) so
  // ~50 sliders across 7 joint groups stay navigable instead of one long
  // undifferentiated column (glophimon's own ~17-slider Pose Designer
  // didn't need this grouping; this rig has roughly 3x as many controls).
  for (const group of ANIMATION_MAKER_GROUP_ORDER) {
    const details = document.createElement("details");
    details.open = true;
    details.style.margin = "2px 0";
    const summary = document.createElement("summary");
    summary.textContent = group;
    summary.style.cursor = "pointer";
    summary.style.fontWeight = "bold";
    summary.style.margin = "2px 0";
    details.appendChild(summary);
    const groupBody = document.createElement("div");
    groupBody.style.display = "flex";
    groupBody.style.flexDirection = "column";
    groupBody.style.gap = "3px";
    groupBody.style.margin = "4px 0";
    details.appendChild(groupBody);
    animMakerPanelEl.appendChild(details);

    for (const spec of ANIMATION_MAKER_PARTS) {
      if (spec.group !== group) continue;
      const row = document.createElement("div");
      const topRow = document.createElement("div");
      topRow.style.display = "flex";
      topRow.style.justifyContent = "space-between";
      const labelEl = document.createElement("span");
      labelEl.textContent = spec.label;
      // A real editable number input, not a plain readout span — typing an
      // exact value is more precise than dragging for e.g. matching two
      // limbs' angles exactly. Clamped to the same min/max as the slider on
      // blur/Enter (typing mid-edit, e.g. a lone "-", is left alone rather
      // than fighting the user keystroke-by-keystroke).
      const valueEl = document.createElement("input");
      valueEl.type = "number";
      valueEl.value = "0.00";
      valueEl.step = String(spec.step);
      valueEl.min = String(spec.min);
      valueEl.max = String(spec.max);
      valueEl.style.width = "56px";
      valueEl.style.fontSize = "10px";
      valueEl.style.background = "transparent";
      valueEl.style.color = "#e5e5e5";
      valueEl.style.border = "1px solid #3333334d";
      valueEl.style.borderRadius = "3px";
      topRow.append(labelEl, valueEl);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(spec.min);
      slider.max = String(spec.max);
      slider.step = String(spec.step);
      slider.value = "0";
      slider.style.width = "100%";
      function setAnimationMakerSliderValue(v) {
        animationMakerValues[spec.key] = v;
        slider.value = String(v);
        valueEl.value = v.toFixed(2);
        animationMakerPlaying = false;
        updatePlayButtonLabel();
      }
      slider.addEventListener("input", () => setAnimationMakerSliderValue(parseFloat(slider.value)));
      function commitTypedValue() {
        const parsed = parseFloat(valueEl.value);
        const v = Number.isFinite(parsed) ? Math.min(spec.max, Math.max(spec.min, parsed)) : animationMakerValues[spec.key];
        setAnimationMakerSliderValue(v);
      }
      valueEl.addEventListener("change", commitTypedValue);
      valueEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commitTypedValue();
      });
      row.append(topRow, slider);
      groupBody.appendChild(row);
      animationMakerSliderEls[spec.key] = { slider, valueEl };
    }
  }

  // Pushes an external values object onto every slider (and the live
  // animationMakerValues state) without rebuilding any DOM — used by
  // keyframe Load, Clear, and Import.
  function loadAnimationMakerValues(values) {
    for (const spec of ANIMATION_MAKER_PARTS) {
      const v = values[spec.key] ?? 0;
      animationMakerValues[spec.key] = v;
      const els = animationMakerSliderEls[spec.key];
      if (els) {
        els.slider.value = String(v);
        els.valueEl.value = v.toFixed(2);
      }
    }
  }

  const animMakerKeyframeBtnRow = document.createElement("div");
  animMakerKeyframeBtnRow.style.display = "flex";
  animMakerKeyframeBtnRow.style.gap = "4px";
  animMakerKeyframeBtnRow.style.margin = "6px 0 4px 0";
  const animMakerAddKeyframeBtn = document.createElement("button");
  animMakerAddKeyframeBtn.textContent = "+ Keyframe";
  animMakerAddKeyframeBtn.style.flex = "1";
  animMakerAddKeyframeBtn.style.fontSize = "11px";
  animMakerAddKeyframeBtn.style.cursor = "pointer";
  const animMakerPlayBtn = document.createElement("button");
  animMakerPlayBtn.style.flex = "1";
  animMakerPlayBtn.style.fontSize = "11px";
  animMakerPlayBtn.style.cursor = "pointer";
  const animMakerClearBtn = document.createElement("button");
  animMakerClearBtn.textContent = "Clear";
  animMakerClearBtn.style.flex = "1";
  animMakerClearBtn.style.fontSize = "11px";
  animMakerClearBtn.style.cursor = "pointer";
  animMakerKeyframeBtnRow.append(animMakerAddKeyframeBtn, animMakerPlayBtn, animMakerClearBtn);
  animMakerPanelEl.appendChild(animMakerKeyframeBtnRow);

  function updatePlayButtonLabel() {
    animMakerPlayBtn.textContent = animationMakerPlaying ? "⏹ Stop" : "▶ Play";
  }
  updatePlayButtonLabel();

  const animMakerKeyframesEl = document.createElement("div");
  animMakerKeyframesEl.style.display = "flex";
  animMakerKeyframesEl.style.flexDirection = "column";
  animMakerKeyframesEl.style.gap = "3px";
  animMakerKeyframesEl.style.margin = "0 0 6px 0";
  animMakerPanelEl.appendChild(animMakerKeyframesEl);

  function renderAnimationMakerKeyframes() {
    animMakerKeyframesEl.innerHTML = "";
    animationMakerKeyframes.forEach((kf, i) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "4px";
      const indexLabel = document.createElement("span");
      indexLabel.textContent = `${i + 1}.`;
      const msInput = document.createElement("input");
      msInput.type = "number";
      msInput.min = "1";
      msInput.step = "50";
      msInput.value = String(kf.transitionMs);
      msInput.style.width = "60px";
      msInput.addEventListener("input", () => {
        kf.transitionMs = Math.max(1, parseInt(msInput.value, 10) || 1);
      });
      const msLabel = document.createElement("span");
      msLabel.textContent = "ms";
      const loadBtn = document.createElement("button");
      loadBtn.textContent = "Load";
      loadBtn.style.fontSize = "10px";
      loadBtn.style.cursor = "pointer";
      loadBtn.addEventListener("click", () => {
        animationMakerPlaying = false;
        updatePlayButtonLabel();
        loadAnimationMakerValues(kf.values);
      });
      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save";
      saveBtn.style.fontSize = "10px";
      saveBtn.style.cursor = "pointer";
      saveBtn.title = "Overwrite this keyframe with the sliders' current values";
      saveBtn.addEventListener("click", () => {
        kf.values = { ...animationMakerValues };
      });
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "✕";
      deleteBtn.style.fontSize = "10px";
      deleteBtn.style.cursor = "pointer";
      deleteBtn.addEventListener("click", () => {
        animationMakerKeyframes.splice(i, 1);
        renderAnimationMakerKeyframes();
      });
      row.append(indexLabel, msInput, msLabel, loadBtn, saveBtn, deleteBtn);
      animMakerKeyframesEl.appendChild(row);
    });
  }

  animMakerAddKeyframeBtn.addEventListener("click", () => {
    animationMakerKeyframes.push({ values: { ...animationMakerValues }, transitionMs: 400 });
    renderAnimationMakerKeyframes();
  });
  animMakerPlayBtn.addEventListener("click", () => {
    animationMakerPlaying = !animationMakerPlaying;
    animationMakerPlaybackMs = 0;
    updatePlayButtonLabel();
  });
  animMakerClearBtn.addEventListener("click", () => {
    animationMakerPlaying = false;
    updatePlayButtonLabel();
    animationMakerKeyframes = [];
    animMakerNameInput.value = "";
    loadAnimationMakerValues(animationMakerDefaultValues());
    renderAnimationMakerKeyframes();
  });

  // ---- Saved animations (localStorage) + Export/Import ----
  const animMakerSavedRow = document.createElement("div");
  animMakerSavedRow.style.display = "flex";
  animMakerSavedRow.style.gap = "4px";
  animMakerSavedRow.style.margin = "4px 0";
  const animMakerSavedSelect = document.createElement("select");
  animMakerSavedSelect.style.flex = "1";
  animMakerSavedRow.appendChild(animMakerSavedSelect);
  const animMakerLoadSavedBtn = document.createElement("button");
  animMakerLoadSavedBtn.textContent = "Load";
  animMakerLoadSavedBtn.style.fontSize = "11px";
  animMakerLoadSavedBtn.style.cursor = "pointer";
  animMakerSavedRow.appendChild(animMakerLoadSavedBtn);
  const animMakerDeleteSavedBtn = document.createElement("button");
  animMakerDeleteSavedBtn.textContent = "Delete";
  animMakerDeleteSavedBtn.style.fontSize = "11px";
  animMakerDeleteSavedBtn.style.cursor = "pointer";
  animMakerSavedRow.appendChild(animMakerDeleteSavedBtn);
  animMakerPanelEl.appendChild(animMakerSavedRow);

  const animMakerSaveBtn = document.createElement("button");
  animMakerSaveBtn.textContent = "💾 Save As (uses Name above)";
  animMakerSaveBtn.style.fontSize = "11px";
  animMakerSaveBtn.style.width = "100%";
  animMakerSaveBtn.style.cursor = "pointer";
  animMakerSaveBtn.style.margin = "0 0 4px 0";
  animMakerPanelEl.appendChild(animMakerSaveBtn);

  const animMakerStatusP = document.createElement("p");
  animMakerStatusP.style.fontSize = "10px";
  animMakerStatusP.style.margin = "0 0 4px 0";
  animMakerStatusP.style.minHeight = "12px";
  animMakerPanelEl.appendChild(animMakerStatusP);

  function refreshSavedAnimationsSelect() {
    const saved = loadSavedAnimations();
    const previousValue = animMakerSavedSelect.value;
    animMakerSavedSelect.innerHTML = "";
    if (saved.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no saved animations yet)";
      animMakerSavedSelect.appendChild(opt);
    }
    for (const anim of saved) {
      const opt = document.createElement("option");
      opt.value = anim.name;
      opt.textContent = anim.name;
      animMakerSavedSelect.appendChild(opt);
    }
    if (saved.some((a) => a.name === previousValue)) animMakerSavedSelect.value = previousValue;
  }
  refreshSavedAnimationsSelect();

  animMakerSaveBtn.addEventListener("click", () => {
    const name = animMakerNameInput.value.trim();
    if (!name) {
      animMakerStatusP.style.color = "#f87171";
      animMakerStatusP.textContent = "Enter a name above before saving.";
      return;
    }
    const saved = loadSavedAnimations();
    const entry = { name, keyframes: animationMakerKeyframes.map((kf) => ({ values: { ...kf.values }, transitionMs: kf.transitionMs })) };
    const existingIdx = saved.findIndex((a) => a.name === name);
    if (existingIdx >= 0) saved[existingIdx] = entry;
    else saved.push(entry);
    saveSavedAnimations(saved);
    refreshSavedAnimationsSelect();
    animMakerSavedSelect.value = name;
    animMakerStatusP.style.color = "#4ade80";
    animMakerStatusP.textContent = `Saved "${name}" to this browser.`;
  });

  animMakerLoadSavedBtn.addEventListener("click", () => {
    const saved = loadSavedAnimations();
    const anim = saved.find((a) => a.name === animMakerSavedSelect.value);
    if (!anim) return;
    animationMakerPlaying = false;
    updatePlayButtonLabel();
    animationMakerKeyframes = anim.keyframes.map((kf) => ({
      values: { ...animationMakerDefaultValues(), ...kf.values },
      transitionMs: Math.max(1, kf.transitionMs || 400),
    }));
    animMakerNameInput.value = anim.name;
    if (animationMakerKeyframes.length > 0) loadAnimationMakerValues(animationMakerKeyframes[0].values);
    renderAnimationMakerKeyframes();
    animMakerStatusP.style.color = "#a3a3a3";
    animMakerStatusP.textContent = `Loaded "${anim.name}".`;
  });

  animMakerDeleteSavedBtn.addEventListener("click", () => {
    const name = animMakerSavedSelect.value;
    if (!name) return;
    const saved = loadSavedAnimations().filter((a) => a.name !== name);
    saveSavedAnimations(saved);
    refreshSavedAnimationsSelect();
    animMakerStatusP.style.color = "#a3a3a3";
    animMakerStatusP.textContent = `Deleted "${name}".`;
  });

  const animMakerExportImportRow = document.createElement("div");
  animMakerExportImportRow.style.display = "flex";
  animMakerExportImportRow.style.gap = "4px";
  const animMakerExportBtn = document.createElement("button");
  animMakerExportBtn.textContent = "Export";
  animMakerExportBtn.style.flex = "1";
  animMakerExportBtn.style.fontSize = "11px";
  animMakerExportBtn.style.cursor = "pointer";
  const animMakerImportBtn = document.createElement("button");
  animMakerImportBtn.textContent = "Import";
  animMakerImportBtn.style.flex = "1";
  animMakerImportBtn.style.fontSize = "11px";
  animMakerImportBtn.style.cursor = "pointer";
  animMakerExportImportRow.append(animMakerExportBtn, animMakerImportBtn);
  animMakerPanelEl.appendChild(animMakerExportImportRow);

  const animMakerJsonTextarea = document.createElement("textarea");
  animMakerJsonTextarea.style.width = "100%";
  animMakerJsonTextarea.style.height = "70px";
  animMakerJsonTextarea.style.fontSize = "10px";
  animMakerJsonTextarea.style.marginTop = "4px";
  animMakerJsonTextarea.placeholder = "Export writes JSON here; Import reads JSON from here.";
  animMakerPanelEl.appendChild(animMakerJsonTextarea);

  const animMakerErrorP = document.createElement("p");
  animMakerErrorP.style.fontSize = "10px";
  animMakerErrorP.style.color = "#f87171";
  animMakerErrorP.style.display = "none";
  animMakerPanelEl.appendChild(animMakerErrorP);

  animMakerExportBtn.addEventListener("click", () => {
    const payload = {
      name: animMakerNameInput.value.trim() || "untitled",
      keyframes: animationMakerKeyframes.map((kf) => ({ values: { ...kf.values }, transitionMs: kf.transitionMs })),
    };
    const json = JSON.stringify(payload, null, 2);
    animMakerJsonTextarea.value = json;
    animMakerJsonTextarea.focus();
    animMakerJsonTextarea.select();
    navigator.clipboard?.writeText(json).catch(() => {});
    animMakerErrorP.style.display = "none";
  });

  animMakerImportBtn.addEventListener("click", () => {
    let payload;
    try {
      payload = JSON.parse(animMakerJsonTextarea.value);
    } catch {
      animMakerErrorP.textContent = "Couldn't parse that as JSON.";
      animMakerErrorP.style.display = "block";
      return;
    }
    if (!Array.isArray(payload?.keyframes)) {
      animMakerErrorP.textContent = 'Expected an object with a "keyframes" array.';
      animMakerErrorP.style.display = "block";
      return;
    }
    animationMakerPlaying = false;
    updatePlayButtonLabel();
    animationMakerKeyframes = payload.keyframes.map((kf) => ({
      values: { ...animationMakerDefaultValues(), ...kf.values },
      transitionMs: Math.max(1, parseInt(kf.transitionMs, 10) || 400),
    }));
    animMakerNameInput.value = payload.name || "";
    if (animationMakerKeyframes.length > 0) loadAnimationMakerValues(animationMakerKeyframes[0].values);
    renderAnimationMakerKeyframes();
    animMakerErrorP.style.display = "none";
  });

  // Restores every Animation Maker-controlled bone (plus the root pseudo-
  // axes) back to bind pose — called whenever the panel closes or playback
  // stops being the active pose source, so nothing is left stuck offset
  // once the walk cycle (or plain idle bind pose) resumes control of the
  // same bones.
  function resetAnimationMakerPose() {
    applyAnimationMakerValues(allBonesByName, allBindRotations, modelRoot ?? { position: {}, rotation: {} }, baseY, animationMakerDefaultValues());
  }

  function setAnimationMakerOpen(open) {
    animationMakerOpen = open;
    animMakerPanelEl.style.display = open ? "flex" : "none";
    if (!open) {
      animationMakerPlaying = false;
      updatePlayButtonLabel();
      if (modelRoot) resetAnimationMakerPose();
    }
  }

  function onAnimMakerToggle() {
    setAnimationMakerOpen(!animationMakerOpen);
  }
  function onAnimMakerClose() {
    setAnimationMakerOpen(false);
  }
  animMakerButton.addEventListener("click", onAnimMakerToggle);
  animMakerCloseBtn.addEventListener("click", onAnimMakerClose);

  function onModelReady() {
    animMakerButton.disabled = false;
    animMakerNoModelP.style.display = "none";
  }

  // Called once per frame instead of updateWalkCycle whenever the panel is
  // open (see frame() below) — live slider pose while stopped, keyframe
  // playback while playing, on the SAME live model/bones the main canvas
  // already renders.
  function updateAnimationMakerFrame(dt) {
    if (animationMakerPlaying && animationMakerKeyframes.length > 0) {
      animationMakerPlaybackMs += dt * 1000;
      playAnimationKeyframes(allBonesByName, allBindRotations, modelRoot, baseY, animationMakerKeyframes, animationMakerPlaybackMs);
    } else {
      applyAnimationMakerValues(allBonesByName, allBindRotations, modelRoot, baseY, animationMakerValues);
    }
  }
  // ---- End Animation Maker --------------------------------------------

  let lastWidth = 0;
  let lastHeight = 0;
  let lastFrameTime = performance.now();
  let rafId = 0;

  function applyWalkDelta(name, axis, amount) {
    const bone = walkBones[name];
    const bind = walkBindRotations[name];
    if (!bone || !bind) return;
    bone.rotation[axis] = bind[axis] + amount * walkBlend;
  }

  function updateWalkCycle(dt) {
    const target = isWalking ? 1 : 0;
    walkBlend += (target - walkBlend) * Math.min(1, dt * WALK_BLEND_RATE);
    if (walkBlend > 0.001) walkPhase += dt * WALK_FREQUENCY;
    const p = walkPhase;

    applyWalkDelta("Bip001-Pelvis", "z", HIP_SWAY * Math.sin(p));
    applyWalkDelta("Bip001-Spine", "z", SPINE_COUNTER_SWAY * Math.sin(p));
    applyWalkDelta("Bip001-Spine1", "z", SPINE1_COUNTER_SWAY * Math.sin(p));
    applyWalkDelta("Bip001-Spine2", "z", SPINE2_COUNTER_SWAY * Math.sin(p));
    // L/R bones on this rig have mirrored *bind-pose rotations* (not a
    // mirrored scale), so the same phase already alternates L/R naturally —
    // no explicit +Math.PI offset needed.
    applyWalkDelta("Bip001-L-Thigh", "x", STRIDE_AMOUNT * Math.sin(p));
    applyWalkDelta("Bip001-R-Thigh", "x", STRIDE_AMOUNT * Math.sin(p));
    applyWalkDelta("Bip001-L-Calf", "x", KNEE_BEND * Math.max(0, Math.sin(p)));
    applyWalkDelta("Bip001-R-Calf", "x", KNEE_BEND * Math.max(0, Math.sin(p)));
    applyWalkDelta("Bip001-L-UpperArm", "x", -ARM_SWING * Math.sin(p));
    applyWalkDelta("Bip001-R-UpperArm", "x", -ARM_SWING * Math.sin(p));

    if (modelRoot) {
      modelRoot.position.y = baseY + BOB_AMOUNT * Math.abs(Math.sin(p)) * walkBlend;
    }
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    // Mutually exclusive with the procedural walk cycle — Animation Maker
    // directly drives (a superset of) the same bones, so only one may
    // control the rig on a given frame. setAnimationMakerOpen's own reset
    // restores bind pose the moment the panel closes, so updateWalkCycle
    // resuming control right after never picks up a stale offset.
    if (animationMakerOpen && modelRoot) updateAnimationMakerFrame(dt);
    else updateWalkCycle(dt);
    controls.update();
    const width = canvas.clientWidth || canvas.getBoundingClientRect().width;
    const height = canvas.clientHeight || canvas.getBoundingClientRect().height;
    if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  el._modelViewerCleanup = () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    walkButton.removeEventListener("click", onWalkToggle);
    animMakerButton.removeEventListener("click", onAnimMakerToggle);
    animMakerCloseBtn.removeEventListener("click", onAnimMakerClose);
    controls.dispose();
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.geometry.dispose();
      const material = obj.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    renderer.dispose();
  };
}

export function unmount(el) {
  if (el && el._modelViewerCleanup) {
    el._modelViewerCleanup();
    delete el._modelViewerCleanup;
  }
}

window.CheddarGames = window.CheddarGames || {};
window.CheddarGames["model_viewer"] = { mount, unmount };
