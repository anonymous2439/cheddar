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
  wrap.appendChild(header);

  const status = document.createElement("p");
  status.style.fontSize = "12px";
  status.style.margin = "0 0 6px 0";
  status.style.color = "#a3a3a3";
  status.textContent = "Loading model…";
  wrap.appendChild(status);

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  canvas.style.width = "100%";
  canvas.style.maxWidth = "720px";
  canvas.style.display = "block";
  canvas.style.borderRadius = "4px";
  wrap.appendChild(canvas);

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
      });
      baseY = fbx.position.y;
      modelRoot = fbx;

      scene.add(fbx);
      status.textContent = "Loaded — drag to orbit, scroll to zoom.";
    },
    (progress) => {
      if (progress.total) status.textContent = `Loading model… ${Math.round((progress.loaded / progress.total) * 100)}%`;
    },
    (error) => {
      console.error("Model Viewer: failed to load FBX", error);
      status.textContent = "Failed to load the model — check the developer console for details.";
    },
  );

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
    updateWalkCycle(dt);
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
