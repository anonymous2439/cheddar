// Model Viewer — load a rigged FBX character model and look it over with
// a free-orbit camera. First pass deliberately just shows the model in
// its bind/standing pose; posing individual bones is a later step (see
// the conversation this was scoped from). Web-only: no vscode
// counterpart, no networking, no lobby session state — this is a single
// local viewer, same "pure client, no backend involvement" shape as GL
// Sims (vscode) or the Pokémon Fire Red emulator (web).
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Lobby } from "../../types";

interface Props {
  lobby: Lobby;
  currentUserId: number;
  onFinished?: () => void;
}

// Served as-is from web/public (gitignored — see web/.gitignore's own
// comment on why these particular assets aren't tracked) rather than
// bundled: a 40+MB FBX has no business going through the JS bundler.
// import.meta.env.BASE_URL (not a hardcoded leading "/") matters here:
// vite.config.ts serves the production build under a "/cheddar/" base
// path, so a literal "/models/..." 404s in production even though it
// resolves fine against a bare local dev server — confirmed by curling
// both paths against the live site directly.
const MODEL_URL = `${import.meta.env.BASE_URL}models/blackbird/blackbird.fbx`;
const TEXTURE_PATH = `${import.meta.env.BASE_URL}models/blackbird/textures/`;
// Roughly human height in meters — ripped game-model FBX files commonly
// come in at an arbitrary source scale (often centimeters, sometimes
// something stranger), so the model is rescaled to this after loading
// rather than trusting whatever scale it exports at.
const TARGET_HEIGHT_M = 1.75;

// This particular FBX's texture *references* are just generic
// placeholders (every material's map is literally named
// "base_color_texture", with no real filename or embedded image data
// survives the export) — confirmed by loading it standalone and
// inspecting each material: every `map` was a Texture object with no
// `.image` at all. An empty texture bound to a material's map slot makes
// WebGL treat the whole draw as incomplete, which is why the model
// rendered as fully invisible rather than just untextured.
//
// So textures are matched up by hand here instead of trusting FBXLoader's
// (broken, for this file) automatic resolution — this table was built by
// loading the model standalone and reading off its actual material names.
// A generic fuzzy name-matcher (substring-score every material name
// against every filename) was tried first and discarded: it scored
// "..._hair_01" and "..._hair_02" as an exact tie against
// "hair1_d.png" (the trailing digit never actually disambiguated them as
// intended) and silently sent both to the same file, which a bespoke
// table for this one specific model sidesteps entirely. Four materials
// (eyelash, gaoguang/specular-highlight, "03", "siwa") have no
// corresponding file in the extracted texture set at all — left out here
// on purpose rather than guessed, so they just render as an untextured
// flat color instead of something confidently wrong.
const MATERIAL_TEXTURE_OVERRIDES: Record<string, string> = {
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
// distinct flat unlit color to see which geometry it actually covers):
// every single material in this FBX — not just the ones with a broken
// texture reference — parses to the exact same generic fallback
// (color #cccccc, a light gray FBXLoader falls back to when it can't
// read real material data at all). There's no real per-material color to
// recover, so the four still-untextured materials from the table above
// need an explicit choice. White is a reasonable default (and correct
// for "gaoguang", a tiny specular-highlight decal, and "Blackbird_03", a
// large fluffy white feather collar/trim) — except "alphard_eyelash",
// which the same diagnostic pass showed sitting directly across the eye
// as the eyelash/eyeliner line shape. A white eyelash reads as a stray
// light smear right over the eye, which is exactly the "face looks like
// it's wearing a mask" symptom — that one gets an explicit dark tone
// instead.
const MATERIAL_COLOR_OVERRIDES: Record<string, number> = {
  MI_player_043_alphard_eyelash: 0x1a1310,
};

// A procedural "catwalk" walk cycle — this rig is a standard 3ds Max
// Biped skeleton (confirmed by inspecting its bone names directly:
// Bip001-Pelvis/Spine/Spine1/Spine2/L-R-Thigh/Calf/UpperArm etc., the
// well-documented naming convention that toolchain uses), driven by
// rotating named bones each frame rather than playing one of the FBX's
// own baked animation clips — those all turned out to be generic
// "DefaultSlot" showcase clips (idle/pose loops for a character-profile
// screen), none of them a walk. Local rotation.x is the primary
// swing/hinge axis for a Biped's limbs (thigh/calf/upper-arm), which is
// what drives the actual stride; rotation.z on the pelvis is a lateral
// tilt/roll, confirmed by testing it directly.
//
// The first version of this only counter-rotated one spine segment
// against the pelvis's own sway, which wasn't nearly enough — Spine1,
// Spine2, the neck, the head, and the (huge) hat all sit above that in
// the chain and inherit rotation from everything below them, so the
// whole upper body still swung along with the hips almost as much as the
// hips themselves did. It read as "swinging the whole body back and
// forth", not a hip-sway walk. The actual signature of a runway walk is
// the *opposite*: hips swing, shoulders/head stay comparatively level —
// which needs the counter-rotation spread across the *whole* remaining
// chain (Spine, Spine1, Spine2) so it sums to roughly cancel the
// pelvis's own rotation by the time it reaches the chest, not just
// partially offset it at the very first segment.
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
] as const;
const WALK_FREQUENCY = 1.7; // rad/sec — a slow, deliberate runway cadence, not a brisk casual walk
const WALK_BLEND_RATE = 4; // how fast the pose eases in/out of the walk when toggled, not the walk's own speed
const HIP_SWAY = 0.28; // pelvis lateral tilt — the single biggest contributor to the "runway" read
// Split across all three spine segments so their *sum* cancels HIP_SWAY
// almost entirely by the top of the spine — see the big comment above
// WALK_BONE_NAMES for why one segment alone wasn't enough.
const SPINE_COUNTER_SWAY = -HIP_SWAY * 0.45;
const SPINE1_COUNTER_SWAY = -HIP_SWAY * 0.3;
const SPINE2_COUNTER_SWAY = -HIP_SWAY * 0.2;
const STRIDE_AMOUNT = 0.5;
const KNEE_BEND = 0.7;
const ARM_SWING = 0.22; // deliberately subtler than a normal walk — runway models keep their arms fairly still
const BOB_AMOUNT = 0.02;

export function ModelViewerGame({ onFinished }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState("Loading model…");
  // isWalking (React state) is only for the button's own label; the ref is
  // what the render loop actually reads each frame, since the loop lives
  // inside a plain closure in the effect below, not React's render cycle.
  const [isWalking, setIsWalking] = useState(false);
  const isWalkingRef = useRef(false);
  function toggleWalk() {
    isWalkingRef.current = !isWalkingRef.current;
    setIsWalking(isWalkingRef.current);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#1b1b21");
    scene.fog = new THREE.Fog("#1b1b21", 10, 32);

    // This character's textures are flat, painted-on anime art (see
    // MATERIAL_TEXTURE_OVERRIDES's own comment) — eyes, brows, blush, and
    // highlight shapes are already baked into the diffuse image, meant to
    // be viewed under flat/toon shading, not realistic directional
    // lighting. A strong directional key light plus a cool-toned rim
    // light (the original setup here) casts real shadows and a cool cast
    // across a face that already has its own painted shadows/highlights,
    // which is what read as "grayed out skin" and "clown-like paint" —
    // doubled-up lighting info fighting the art itself. Weighted much
    // more toward flat ambient now, with a single gentle warm-neutral
    // light just for a touch of dimensionality, no shadow casting, and no
    // cool-colored light at all (that's what was pushing pale skin
    // toward gray).
    scene.add(new THREE.AmbientLight("#ffffff", 1.6));
    const keyLight = new THREE.DirectionalLight("#fff8ef", 0.35);
    keyLight.position.set(3, 6, 4);
    scene.add(keyLight);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: "#28282f" }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    scene.add(new THREE.GridHelper(20, 20, "#3a3a45", "#3a3a45"));

    // Populated once the FBX finishes loading (see below) — plain
    // closure variables, not refs, since the render loop that reads them
    // lives in this same effect, not in React's render cycle.
    const walkBones: Record<string, THREE.Bone> = {};
    const walkBindRotations: Record<string, THREE.Euler> = {};
    let modelRoot: THREE.Group | null = null;
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
    const loader = new FBXLoader();
    const textureLoader = new THREE.TextureLoader();
    loader.setResourcePath(TEXTURE_PATH);
    loader.load(
      MODEL_URL,
      (fbx) => {
        if (disposed) return;

        const rawSize = new THREE.Box3().setFromObject(fbx).getSize(new THREE.Vector3());
        if (rawSize.y > 0) {
          fbx.scale.setScalar(TARGET_HEIGHT_M / rawSize.y);
        }
        // Re-measure after scaling, then recenter horizontally and drop
        // the model so its lowest point sits exactly on the ground plane
        // — the FBX's own pivot/origin isn't necessarily at the feet.
        const box = new THREE.Box3().setFromObject(fbx);
        const center = box.getCenter(new THREE.Vector3());
        fbx.position.x -= center.x;
        fbx.position.z -= center.z;
        fbx.position.y -= box.min.y;

        const unmatchedMaterials: string[] = [];
        fbx.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;

          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) {
            const mat = material as THREE.MeshPhongMaterial;
            // Drop any texture slot the FBX left as an empty placeholder
            // (see the big comment above MATERIAL_TEXTURE_OVERRIDES) —
            // this is what actually fixes the invisible-model bug,
            // independent of whether the lookup below finds a real
            // replacement.
            for (const slot of ["map", "normalMap", "specularMap", "bumpMap", "emissiveMap", "alphaMap"] as const) {
              const tex = mat[slot];
              if (tex && !tex.image) mat[slot] = null;
            }
            if (!mat.map) {
              const file = MATERIAL_TEXTURE_OVERRIDES[mat.name];
              if (file) {
                const tex = textureLoader.load(TEXTURE_PATH + file);
                tex.colorSpace = THREE.SRGBColorSpace;
                mat.map = tex;
              } else {
                unmatchedMaterials.push(mat.name);
              }
            }
            // This mesh ships per-vertex color data with vertexColors
            // already enabled on every material, which multiplies that
            // data straight into the diffuse output. Found by isolating
            // the face material on a bare plane with the exact same
            // Phong+lighting setup (rendered correctly, pale skin) versus
            // on the real skinned mesh (rendered as a garish
            // yellow-green/magenta smear across the face) — the only
            // difference was this per-vertex data. It's almost certainly
            // game-engine-specific shader input (an AO or rim-light mask,
            // by the look of it), never meant to be read as a literal
            // "tint the texture by this color" the way THREE.js's generic
            // vertex-color feature does — this is what actually produced
            // the "face looks like it's wearing a mask" symptom, not the
            // lighting.
            mat.vertexColors = false;
            // A textured material gets de-tinted to white so the texture's
            // own colors show through undiluted (the FBX parses every
            // material's color to the same generic gray fallback — see
            // MATERIAL_COLOR_OVERRIDES's comment — which would otherwise
            // multiply against the texture and dull it toward gray). An
            // untextured one has no real color to fall back to at all, so
            // it gets its explicit override if it has one (see that same
            // comment), or white otherwise.
            mat.color.set(mat.map ? 0xffffff : (MATERIAL_COLOR_OVERRIDES[mat.name] ?? 0xffffff));
            // Flatten the specular response — Phong's real-time specular
            // highlight sitting on top of eyes/brows/blush that are
            // already painted *with their own* highlight shapes doubles
            // up into an extra glossy sheen that doesn't match the flat
            // 2D art.
            mat.shininess = 4;
            mat.specular.set(0x0a0a0a);
            mat.needsUpdate = true;
          }
        });
        if (unmatchedMaterials.length > 0) {
          console.warn("Model Viewer: no texture match for materials", unmatchedMaterials);
        }

        // Bind-pose rotations captured once here so the walk cycle can
        // apply its own rotation as an *offset* from the model's actual
        // rest pose (each frame sets bone.rotation.x = bind.x + delta),
        // rather than assuming 0 is neutral — cleanly returns to the
        // exact rest pose when walking is toggled off, however that rest
        // pose happens to be posed.
        fbx.traverse((obj) => {
          const bone = obj as THREE.Bone;
          if ((bone as any).isBone && (WALK_BONE_NAMES as readonly string[]).includes(bone.name)) {
            walkBones[bone.name] = bone;
            walkBindRotations[bone.name] = bone.rotation.clone();
          }
        });
        baseY = fbx.position.y;
        modelRoot = fbx;

        scene.add(fbx);
        setStatus("Loaded — drag to orbit, scroll to zoom.");
      },
      (progress) => {
        if (progress.total) setStatus(`Loading model… ${Math.round((progress.loaded / progress.total) * 100)}%`);
      },
      (error) => {
        console.error("Model Viewer: failed to load FBX", error);
        setStatus("Failed to load the model — check the browser console for details.");
      },
    );

    let lastWidth = 0;
    let lastHeight = 0;
    let lastFrameTime = performance.now();
    let rafId = 0;

    function applyWalkDelta(name: string, axis: "x" | "y" | "z", amount: number) {
      const bone = walkBones[name];
      const bind = walkBindRotations[name];
      if (!bone || !bind) return;
      bone.rotation[axis] = bind[axis] + amount * walkBlend;
    }

    function updateWalkCycle(dt: number) {
      const target = isWalkingRef.current ? 1 : 0;
      walkBlend += (target - walkBlend) * Math.min(1, dt * WALK_BLEND_RATE);
      if (walkBlend > 0.001) walkPhase += dt * WALK_FREQUENCY;
      const p = walkPhase;

      applyWalkDelta("Bip001-Pelvis", "z", HIP_SWAY * Math.sin(p));
      applyWalkDelta("Bip001-Spine", "z", SPINE_COUNTER_SWAY * Math.sin(p));
      applyWalkDelta("Bip001-Spine1", "z", SPINE1_COUNTER_SWAY * Math.sin(p));
      applyWalkDelta("Bip001-Spine2", "z", SPINE2_COUNTER_SWAY * Math.sin(p));
      // L/R bones on this rig have mirrored *bind-pose rotations* (not a
      // mirrored scale) — confirmed by measuring world-space displacement
      // from an identical local rotation.x delta on the L vs R thigh/arm:
      // the two resulting vectors point in near-opposite directions
      // (dot product strongly negative) even though local rotation values
      // are the same sign. That means the SAME phase already alternates
      // L/R naturally; an explicit +Math.PI offset here was cancelling
      // that built-in mirroring instead of complementing it, which is why
      // both legs (and both arms) swung in sync instead of alternating.
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

    function frame(now: number) {
      const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
      lastFrameTime = now;
      updateWalkCycle(dt);
      controls.update();
      const width = canvas!.clientWidth;
      const height = canvas!.clientHeight;
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

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      controls.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      renderer.dispose();
    };
  }, []);

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">🕊️ Model Viewer</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleWalk}
            className={`rounded px-3 py-1 text-xs font-medium ${isWalking ? "bg-amber-500 text-white hover:bg-amber-600" : "bg-neutral-200 text-neutral-700 hover:bg-neutral-300"}`}
          >
            {isWalking ? "⏹ Stop Walk" : "🚶 Walk"}
          </button>
          {onFinished && (
            <button onClick={onFinished} className="text-xs text-neutral-500 hover:underline">
              Leave
            </button>
          )}
        </div>
      </div>
      <p className="mb-2 text-sm text-neutral-500">{status}</p>
      <canvas ref={canvasRef} width={640} height={400} className="block min-h-0 w-full flex-1 rounded border border-neutral-200" />
    </div>
  );
}
