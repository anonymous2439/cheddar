// Background chat-bubble flavor, fetched live from karirs-api's
// /glsims/conversations on mount (see game.js's onEvent) rather than baked
// into the client at build time — an edit to conversation_lines or
// filtered_messages (see names.php and games/karirs/api/app/models.py's
// FilteredMessage) shows up next time GL Sims opens, no vscode extension
// update required.
//
// A conversation is a genuine interaction its participants are locked
// into — much like hit/kiss/fight in simulation.js — rather than a bubble
// popping up over whoever happens to be standing around. The flow, per the
// explicit spec:
//   1. A random line is picked; its speaker (if currently free — not
//      already doing something else) is pulled out of whatever they were
//      doing and settles to idle first, *then* the bubble appears.
//   2. Both participants' bubbles stay up for as long as they're both in
//      the conversation — a bubble is never hidden just because its
//      turn's pacing timer expired. When a specific person speaks again,
//      their *own* bubble is replaced in place (see showBubble's
//      state.bubbles map, keyed by participant object — see below); the
//      other participant's bubble is left completely alone.
//   3. To advance, the script is scanned forward for the next line whose
//      speaker is present. If it's the same speaker, they just continue
//      (their bubble gets replaced). If it's the other participant (the
//      current listener), they reply in place — already close enough,
//      already facing — and now show *their own* bubble alongside the
//      first speaker's. If it's a third participant, the current listener
//      is released back to normal life (their bubble hidden with them)
//      and the new speaker arrives to replace them — a roster racer walks
//      over, a non-racer falls from the sky as a temporary "ghost angel"
//      stand-in (see the ghost slot system below) — their bubble only
//      appears once they've actually arrived. A racer whose line comes up
//      while they're busy with something unrelated is skipped, per spec;
//      a non-racer is never "busy" in that sense, so their lines are
//      never skipped for that reason.
//   4. Both participants are claimed (can't be picked for anything else)
//      for as long as they're in the conversation. A burst spends a
//      random 2-5 turns total (any line successfully staged, whether the
//      same speaker continuing or a hop to someone new) before both
//      bubbles are hidden, everyone's released, and the whole thing
//      pauses, then eventually starts over from a fresh random line.
//      Turns are capped on *every* line, not just hops — otherwise a
//      speaker who dominates the source data (Xiao runs to thousands of
//      consecutive-ish lines) could monologue indefinitely without ever
//      spending down to a hop or an end.
//
// Every frame a bubble is up, its position also gets two corrections (see
// repositionAllBubbles) on top of the plain "above the speaker's head"
// placement: it's clamped to stay within the visible screen even if the
// character has wandered off-frame, and — since it's up to two bubbles at
// once now — pushed apart sideways if they'd otherwise overlap.
//
// Internally, "who's speaking/listening/pending" is tracked as direct
// object references (a real characters[] entry, or one of the two pooled
// ghost-slot objects below) rather than integer indices — the uniform
// shape lets almost all of this file's logic treat a roster racer and a
// ghost angel identically, only branching on participant.isGhost at the
// handful of places that actually differ (how they arrive, and how they
// leave).
import {
  createChatBubble,
  computeBubbleAnchorWorld,
  positionChatBubbleAt,
  scaleChatBubble,
  disposeChatBubble,
  clampWorldPointToScreen,
  worldToScreenPixels,
  screenPixelsToWorld,
  buildGhostAngel,
  applyIdlePose,
  syncNameLabel,
  disposeRig,
  setFaceExpression,
} from "./character.js";
import { isFreeToInteract, INTERACTION_RANGE, faceToward, distanceTo, enterIdle, ARENA_HALF_X, ARENA_HALF_Z } from "./simulation.js";

const PAUSE_MIN_MS = 5000;
const PAUSE_MAX_MS = 15000;
// "2 to 5 one-on-one talk[s]" per burst — see the file comment above for
// what counts as a turn.
const BURST_MIN_TURNS = 2;
const BURST_MAX_TURNS = 5;
const CONV_SETTLE_MS = 500; // forced "stop and turn idle" beat before a freshly-recruited racer does anything else (ghosts skip this — see the ghost slot system)
// How long a turn holds the floor before the script advances — no longer
// how long a bubble stays visible (see file comment above); a bubble now
// only ever goes away when its owner is replaced or the burst ends.
const CONV_TURN_MS = 10000;
const BUBBLE_COLLISION_GAP_PX = 6; // minimum on-screen gap kept between two bubbles once separated

// --- Ghost angels -----------------------------------------------------
// A conversation line whose speaker doesn't match any roster racer no
// longer gets skipped — it's given to one of exactly 2 reusable "ghost
// slots" instead, since at most 2 people are ever on stage in this system
// at once. A slot parks high above the arena when unused, falls to a
// landing spot near its conversation partner when claimed, and flies back
// up once released — the same lifecycle for whichever non-racer name
// happens to need it next, not a persistent identity per unique person.
const GHOST_SKY_Y = 9; // parked height while inactive/mid-transition — well above the camera's normal framing
const GHOST_FALL_MS = 900;
const GHOST_RISE_MS = 900;
const GHOST_LAND_OFFSET = INTERACTION_RANGE * 0.6; // lands already within talking range of its partner — no walk-over needed

function createGhostSlot() {
  return {
    isGhost: true,
    active: false, // currently assigned to a conversation participant
    name: null,
    rig: null,
    x: 0,
    y: GHOST_SKY_Y,
    z: 0,
    facingAngle: 0,
    animState: "sky", // "sky" (inactive) | "falling" | "grounded" | "rising"
    animStartedAt: 0,
  };
}

function randomArenaLandingPoint() {
  // Shrunk a bit from the full arena bounds so a ghost with no anchor
  // (the very first speaker of a fresh burst) doesn't land right at the
  // edge, same margin spirit as game.js's own randomArenaPoint.
  return {
    x: (Math.random() * 2 - 1) * ARENA_HALF_X * 0.7,
    z: (Math.random() * 2 - 1) * ARENA_HALF_Z * 0.7,
  };
}

// anchor is whoever this ghost needs to land near (another already-on-
// stage participant, racer or ghost) — null only for the very first
// speaker of a fresh burst, who has nobody to land near yet.
function activateGhostSlot(state, slot, name, anchor, now) {
  if (slot.rig) {
    // Shouldn't happen given the lifecycle (a slot is only claimed once
    // fully released), but guard against leaking a stale rig regardless.
    state.scene.remove(slot.rig.group);
    disposeRig(slot.rig);
  }

  let landX;
  let landZ;
  if (anchor) {
    const angle = Math.random() * Math.PI * 2;
    landX = anchor.x + Math.cos(angle) * GHOST_LAND_OFFSET;
    landZ = anchor.z + Math.sin(angle) * GHOST_LAND_OFFSET;
  } else {
    const p = randomArenaLandingPoint();
    landX = p.x;
    landZ = p.z;
  }

  const rig = buildGhostAngel();
  rig.group.position.set(landX, GHOST_SKY_Y, landZ);
  state.scene.add(rig.group);

  slot.name = name;
  slot.rig = rig;
  slot.x = landX;
  slot.y = GHOST_SKY_Y;
  slot.z = landZ;
  slot.facingAngle = anchor ? Math.atan2(anchor.x - landX, anchor.z - landZ) : 0;
  slot.active = true;
  slot.animState = "falling";
  slot.animStartedAt = now;
}

// Never fails to produce a usable slot: with only ever 2 conversation
// roles (speaker/listener) and exactly 2 slots, a free one is always
// available in practice — the fallback to slot 0 is just defensive.
function claimGhostSlot(state, name, anchor, now) {
  const slot = state.ghostSlots.find((s) => !s.active) ?? state.ghostSlots[0];
  activateGhostSlot(state, slot, name, anchor, now);
  return slot;
}

function releaseGhostSlot(slot, now) {
  if (!slot.active || slot.animState === "rising") return;
  slot.animState = "rising";
  slot.animStartedAt = now;
}

// Falls/rises are plain eased Y-position animations (see the two branches
// below); once "grounded" a ghost just idles in place like any resting
// character, via the same applyIdlePose everyone else's rig uses.
function updateGhostSlots(state, dt, now) {
  for (const slot of state.ghostSlots) {
    if (!slot.active) continue;

    if (slot.animState === "falling") {
      const t = Math.min(1, (now - slot.animStartedAt) / GHOST_FALL_MS);
      const eased = 1 - Math.pow(1 - t, 2); // ease-out, decelerating into land
      slot.y = GHOST_SKY_Y * (1 - eased);
      if (t >= 1) {
        slot.y = 0;
        slot.animState = "grounded";
      }
    } else if (slot.animState === "rising") {
      const t = Math.min(1, (now - slot.animStartedAt) / GHOST_RISE_MS);
      const eased = t * t; // ease-in, accelerating away upward
      slot.y = GHOST_SKY_Y * eased;
      if (t >= 1) {
        state.scene.remove(slot.rig.group);
        disposeRig(slot.rig);
        slot.rig = null;
        slot.active = false;
        slot.name = null;
        slot.animState = "sky";
        continue;
      }
    }

    if (slot.rig) {
      applyIdlePose(slot.rig, dt);
      slot.rig.group.position.set(slot.x, slot.y, slot.z);
      slot.rig.group.rotation.y = slot.facingAngle;
      syncNameLabel(slot.rig);
      // Grounded is the only state a ghost is ever actually part of the
      // conversation (speaking or listening — this rig has no separate
      // pose for the two) — same "confused while talking" rule real
      // characters get in simulation.js's updateCharacter.
      setFaceExpression(slot.rig, slot.animState === "grounded" ? "confused" : "neutral");
    }
  }
}

export function createConversationState(scene) {
  return {
    scene, // where bubble sprites live — they're scene-level, not rig.group children (see character.js's computeBubbleAnchorWorld)
    lines: [], // populated live by setConversationLines once game.js's fetch resolves — empty (and harmless) until then
    phase: "idle", // "idle" (paused) | "burst" (a conversation is in progress)
    nextAt: 0,
    lineIndex: 0,
    turnsLeft: 0,
    speaker: null, // participant object currently holding the floor (talking, or settling/falling with nobody to reach yet)
    listener: null, // the other already-arrived participant, if any
    pending: null, // a new joiner currently settling/walking/falling to replace the listener, if any
    pendingLineText: "",
    turnStartedAt: 0, // when the current speaker's bubble went up — pacing timer, replaces reading a per-character stateEnteredAt so ghosts and racers share one mechanism
    bubbles: new Map(), // participant object -> bubble sprite, for everyone currently showing one
    ghostSlots: [createGhostSlot(), createGhostSlot()],
    lastFrameAt: 0, // for computing this file's own dt (updateConversation's caller doesn't pass one)
  };
}

// Called once game.js's fetch of karirs-api's /glsims/conversations
// resolves (or with [] if it failed — see that call site's comment on
// graceful degrade). Safe to call at any point; an in-progress burst just
// keeps playing off whatever lines it already grabbed.
export function setConversationLines(state, lines) {
  state.lines = Array.isArray(lines) ? lines : [];
}

function findByName(characters, name) {
  return characters.findIndex((c) => c.name === name);
}

// A non-racer name currently already on stage (as speaker or listener) is
// always one of the 2 ghost slots — never allocates a new one itself (see
// claimGhostSlot for that), so a name with no active slot yet resolves to
// null, signaling "brand new ghost joiner" to the callers below.
function resolveExistingGhost(state, name) {
  return state.ghostSlots.find((slot) => slot.active && slot.name === name) ?? null;
}

// Ghosts are never "free" for the general busy/skip check below — they're
// always either already on stage (and therefore never reach that check;
// see advanceConversation) or not yet claimed at all (in which case
// claiming one always succeeds).
function participantIsFree(participant) {
  return !participant.isGhost && isFreeToInteract(participant);
}

// Computes where a bubble should actually end up this frame: the natural
// "above the head" anchor, stacked upward by half the bubble's own height
// (so it clears the name label) — and *then* clamped, not the other way
// around. Clamping the pre-stack anchor and adding the stack offset
// afterward (the first version of this) looks equivalent but isn't: the
// camera here is often tilted/orbiting, so a purely-vertical world-space
// shift (the stack offset) does *not* correspond to a purely-vertical
// shift on screen — it has real horizontal screen-space consequences too.
// Clamping the point *before* that shift is applied means the clamp is
// checking the wrong final position entirely, and the actual rendered
// bubble (after the shift) can end up back past the edge the clamp was
// supposed to enforce. Scaling happens twice for the same reason
// scaleChatBubble already needs the *final* render distance: once
// (against the unstacked anchor) just to learn how tall the bubble is —
// distance barely changes over such a small offset, so this is accurate
// enough purely to size the stack — and again against the clamped result,
// for the actual final size.
function computeClampedBubbleTarget(participant, sprite, viewport) {
  const baseAnchor = computeBubbleAnchorWorld(participant);
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

// Creates a fresh bubble for this participant, or replaces their existing
// one in place if they already had one (same person speaking again) —
// never touches any other participant's bubble. Not separated against the
// other bubble yet if one exists — repositionAllBubbles corrects that on
// the very next frame, same one-frame lag scaleChatBubble/
// positionChatBubbleAt already had before this feature.
function showBubble(state, participant, text, viewport) {
  const existing = state.bubbles.get(participant);
  if (existing) {
    state.scene.remove(existing);
    disposeChatBubble(existing);
  }
  const sprite = createChatBubble(participant.name, text, viewport.widthPx);
  const target = computeClampedBubbleTarget(participant, sprite, viewport);
  positionChatBubbleAt(sprite, target);
  state.scene.add(sprite);
  state.bubbles.set(participant, sprite);
}

function hideBubbleFor(state, participant) {
  const sprite = state.bubbles.get(participant);
  if (!sprite) return;
  state.scene.remove(sprite);
  disposeChatBubble(sprite);
  state.bubbles.delete(participant);
}

function hideAllBubbles(state) {
  for (const participant of [...state.bubbles.keys()]) {
    hideBubbleFor(state, participant);
  }
}

// Recomputes every currently-shown bubble's position each frame — see
// computeClampedBubbleTarget for the natural-anchor/stack/clamp pipeline
// — then, when both participants have a bubble up, separates them
// sideways if they'd otherwise overlap. Runs unconditional on whatever
// conv_*/ghost sub-state is active, since a bubble can be sitting up (the
// listener's, or the anchor's while a joiner arrives) independent of
// whatever's actively happening this frame.
function repositionAllBubbles(state, viewport) {
  const participants = [...state.bubbles.keys()];
  if (participants.length === 0) return;

  const anchors = new Map();
  for (const participant of participants) {
    const sprite = state.bubbles.get(participant);
    anchors.set(participant, computeClampedBubbleTarget(participant, sprite, viewport));
  }

  if (participants.length === 2) {
    const [a, b] = participants;
    separateIfColliding(state, anchors, a, b, viewport);
    // separateIfColliding can push an anchor sideways past the edge that
    // was just clamped above (nothing about it is screen-bounds-aware) —
    // re-clamp whichever one(s) it touched so the final, post-separation
    // position still respects the screen edge too.
    for (const participant of participants) {
      const sprite = state.bubbles.get(participant);
      anchors.set(
        participant,
        clampWorldPointToScreen(
          anchors.get(participant),
          viewport.camera,
          sprite.userData.canvasWidth / 2,
          sprite.userData.canvasHeight / 2,
          viewport.widthPx,
          viewport.heightPx,
        ),
      );
    }
  }

  for (const participant of participants) {
    positionChatBubbleAt(state.bubbles.get(participant), anchors.get(participant));
  }
}

// Pushes two bubbles' (already screen-clamped) anchors apart sideways, in
// screen space, just enough that their on-screen boxes no longer overlap
// — "beside each other" rather than stacked on top of one another.
function separateIfColliding(state, anchors, participantA, participantB, viewport) {
  const spriteA = state.bubbles.get(participantA);
  const spriteB = state.bubbles.get(participantB);
  const pxA = worldToScreenPixels(anchors.get(participantA), viewport.camera, viewport.widthPx, viewport.heightPx);
  const pxB = worldToScreenPixels(anchors.get(participantB), viewport.camera, viewport.widthPx, viewport.heightPx);
  const halfWA = spriteA.userData.canvasWidth / 2;
  const halfWB = spriteB.userData.canvasWidth / 2;
  const halfHA = spriteA.userData.canvasHeight / 2;
  const halfHB = spriteB.userData.canvasHeight / 2;

  const dx = pxB.x - pxA.x;
  const dy = pxB.y - pxA.y;
  const overlapX = halfWA + halfWB + BUBBLE_COLLISION_GAP_PX - Math.abs(dx);
  const overlapY = halfHA + halfHB - Math.abs(dy);
  if (overlapX <= 0 || overlapY <= 0) return; // boxes don't actually overlap

  const pushEach = overlapX / 2;
  const dir = dx === 0 ? 1 : Math.sign(dx);
  pxA.x -= dir * pushEach;
  pxB.x += dir * pushEach;
  anchors.set(participantA, screenPixelsToWorld(pxA.x, pxA.y, anchors.get(participantA), viewport.camera, viewport.widthPx, viewport.heightPx));
  anchors.set(participantB, screenPixelsToWorld(pxB.x, pxB.y, anchors.get(participantB), viewport.camera, viewport.widthPx, viewport.heightPx));
}

// A racer goes back to normal ambient wandering; a ghost flies back up to
// the sky and, once that finishes, simply ceases to exist until claimed
// again for someone else (see updateGhostSlots).
function release(participant, now) {
  if (participant.isGhost) {
    releaseGhostSlot(participant, now);
    return;
  }
  participant.isClaimed = false;
  participant.partnerIndex = -1;
  enterIdle(participant, now);
}

function endBurst(state, now) {
  hideAllBubbles(state);
  for (const participant of [state.speaker, state.listener, state.pending]) {
    if (participant) release(participant, now);
  }
  state.speaker = null;
  state.listener = null;
  state.pending = null;
  state.phase = "idle";
  state.nextAt = now + PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
}

function beginTalking(state, participant, now, viewport) {
  if (!participant.isGhost) {
    participant.isClaimed = true;
    participant.state = "conv_talking";
    participant.stateEnteredAt = now;
  }
  state.speaker = participant;
  state.turnStartedAt = now;
  showBubble(state, participant, state.pendingLineText, viewport);
}

function startBurst(state, characters, now) {
  if (state.lines.length === 0) {
    // Nothing fetched yet (or the fetch failed) — try again shortly
    // rather than spinning on an empty script every frame.
    state.nextAt = now + PAUSE_MIN_MS;
    return;
  }

  state.lineIndex = Math.floor(Math.random() * state.lines.length);
  state.turnsLeft = BURST_MIN_TURNS + Math.floor(Math.random() * (BURST_MAX_TURNS - BURST_MIN_TURNS + 1));
  state.listener = null;
  state.pending = null;

  for (let attempts = 0; attempts < state.lines.length; attempts++) {
    if (state.lineIndex >= state.lines.length) state.lineIndex = 0;
    const line = state.lines[state.lineIndex];
    state.lineIndex++;

    const racerIndex = findByName(characters, line.name);
    if (racerIndex !== -1) {
      const first = characters[racerIndex];
      if (!isFreeToInteract(first)) continue;
      first.isClaimed = true;
      first.partnerIndex = -1;
      first.state = "conv_settling";
      first.stateEnteredAt = now;
      state.speaker = first;
      state.pendingLineText = line.text;
      state.phase = "burst";
      return;
    }

    // Not a racer — claim a ghost slot as the opening speaker. No anchor
    // participant exists yet, so it falls to a random arena point rather
    // than "near" anyone; beginTalking happens once it's grounded (see
    // updateConversation's ghost branch).
    const slot = claimGhostSlot(state, line.name, null, now);
    state.speaker = slot;
    state.pendingLineText = line.text;
    state.phase = "burst";
    return;
  }
  // Nobody available to start a conversation right now (every racer
  // candidate was busy) — just try again shortly rather than never firing.
  state.nextAt = now + PAUSE_MIN_MS;
}

// Scans forward from the current script position for the next line this
// system can actually stage, per the rules in the file comment above.
function advanceConversation(state, characters, now, viewport) {
  for (let attempts = 0; attempts < state.lines.length; attempts++) {
    if (state.lineIndex >= state.lines.length) state.lineIndex = 0;
    const line = state.lines[state.lineIndex];
    state.lineIndex++;

    const racerIndex = findByName(characters, line.name);
    const isRacerLine = racerIndex !== -1;
    const existing = isRacerLine ? characters[racerIndex] : resolveExistingGhost(state, line.name);

    if (existing) {
      // Budget is checked once a stageable line is actually found (not on
      // every skipped one), and spent on *any* successful line — same
      // speaker continuing included — otherwise a speaker who dominates
      // the source data (Xiao runs to thousands of consecutive-ish lines)
      // could monologue forever without ever spending down to a hop or
      // an end.
      if (existing !== state.speaker && existing !== state.listener && !participantIsFree(existing)) {
        continue; // busy with something unrelated (racers only) — skip this line, per spec
      }
      if (state.turnsLeft <= 0) break;
      state.turnsLeft--;

      if (existing === state.speaker) {
        state.pendingLineText = line.text;
        beginTalking(state, state.speaker, now, viewport);
        return;
      }

      if (existing === state.listener) {
        const oldSpeaker = state.speaker;
        if (!oldSpeaker.isGhost) {
          oldSpeaker.state = "conv_listening";
          oldSpeaker.stateEnteredAt = now;
        }
        state.listener = oldSpeaker;
        state.pendingLineText = line.text;
        beginTalking(state, existing, now, viewport); // already on stage — no walk/fall needed
        return;
      }
    } else {
      if (state.turnsLeft <= 0) break;
      state.turnsLeft--;
    }

    // A third participant taking the floor (existing === null here means
    // a brand new ghost joiner never yet seen this burst) — the old
    // listener (only ever 2 participants at a time) is released back to
    // normal life, their bubble hidden with them, and the new speaker
    // arrives to replace them: a racer settles then walks over, a ghost
    // just falls from the sky.
    if (state.listener) {
      hideBubbleFor(state, state.listener);
      release(state.listener, now);
      state.listener = null;
    }
    if (!state.speaker.isGhost) {
      state.speaker.state = "conv_listening"; // waits, standing, for the joiner to arrive — bubble stays up
      state.speaker.stateEnteredAt = now;
    }
    state.pendingLineText = line.text;

    if (isRacerLine) {
      const joiner = characters[racerIndex];
      joiner.isClaimed = true;
      // Not a real characters[] index — see createCharacter's own comment
      // on convTargetX/Z, which is what conv_approaching actually walks
      // toward now. This only needs to read as "busy" to isBumpable/
      // isFreeToInteract, never gets dereferenced as an index.
      joiner.partnerIndex = -2;
      joiner.state = "conv_settling";
      joiner.stateEnteredAt = now;
      state.pending = joiner;
    } else {
      state.pending = claimGhostSlot(state, line.name, state.speaker, now);
    }
    return; // beginTalking happens later, once handlePendingJoiner sees them arrive
  }
  // Ran out of lines to stage (or ran out of budget) — wrap up.
  endBurst(state, now);
}

function handlePendingJoiner(state, characters, now, viewport) {
  const joiner = state.pending;
  const anchor = state.speaker;
  if (!joiner || !anchor) {
    endBurst(state, now);
    return;
  }

  if (joiner.isGhost) {
    // Falling *is* the ghost's entire arrival — no separate settle/walk
    // phase the way a racer joiner has (see claimGhostSlot/
    // updateGhostSlots, which runs every frame from updateConversation
    // regardless of this function). Nothing to do here but wait for it.
    if (joiner.animState !== "grounded") return;
    state.listener = anchor;
    state.pending = null;
    beginTalking(state, joiner, now, viewport);
    return;
  }

  if (joiner.state === "conv_settling") {
    if (now - joiner.stateEnteredAt >= CONV_SETTLE_MS) {
      joiner.state = "conv_approaching";
      joiner.stateEnteredAt = now;
      joiner.convTargetX = anchor.x;
      joiner.convTargetZ = anchor.z;
    }
    return;
  }

  if (joiner.state === "conv_approaching") {
    if (distanceTo(joiner, anchor.x, anchor.z) >= INTERACTION_RANGE) return;
    faceToward(joiner, anchor.x, anchor.z);
    faceToward(anchor, joiner.x, joiner.z);
    state.listener = anchor;
    state.pending = null;
    beginTalking(state, joiner, now, viewport);
    return;
  }

  // Knocked out of the expected states somehow — bail out cleanly.
  endBurst(state, now);
}

export function updateConversation(state, characters, now, viewport) {
  // This file's own dt — updateConversation's caller (game.js) only ever
  // passes `now`, and only ghost fall/rise/idle animation needs a delta.
  const dt = state.lastFrameAt ? Math.min(0.1, (now - state.lastFrameAt) / 1000) : 0;
  state.lastFrameAt = now;
  updateGhostSlots(state, dt, now);

  if (state.phase === "idle") {
    if (now < state.nextAt) return;
    startBurst(state, characters, now);
    return;
  }

  // Every currently-shown bubble is repositioned/rescaled unconditionally
  // each frame — independent of which sub-state is active, since a bubble
  // can be standing up (the listener's, or the anchor's while a joiner
  // arrives) regardless of what's actively happening right now.
  repositionAllBubbles(state, viewport);

  if (state.pending) {
    handlePendingJoiner(state, characters, now, viewport);
    return;
  }

  const speaker = state.speaker;
  if (!speaker) {
    endBurst(state, now);
    return;
  }

  if (speaker.isGhost) {
    if (speaker.animState !== "grounded") return; // still falling — beginTalking fires the instant it lands, just below
    if (!state.bubbles.has(speaker)) {
      // Landed but hasn't shown its opening line yet — only the very
      // first speaker of a fresh burst reaches this (a mid-burst ghost
      // joiner shows its line from handlePendingJoiner instead, the
      // instant *it* lands).
      beginTalking(state, speaker, now, viewport);
      return;
    }
  } else if (speaker.state === "conv_settling") {
    // Only the very first speaker of a fresh burst reaches this with no
    // listener yet to walk to — everyone else goes through
    // handlePendingJoiner's settle step above instead.
    if (now - speaker.stateEnteredAt >= CONV_SETTLE_MS) {
      beginTalking(state, speaker, now, viewport);
    }
    return;
  } else if (speaker.state !== "conv_talking") {
    // Something knocked the speaker out of the conversation (shouldn't
    // happen — nothing else in simulation.js touches conv_* states, but
    // guard it rather than getting stuck forever).
    endBurst(state, now);
    return;
  }

  if (now - state.turnStartedAt >= CONV_TURN_MS) {
    advanceConversation(state, characters, now, viewport);
  }
}

// Where the auto camera (see game.js) should pan/zoom toward while a
// conversation is up — the average position of everyone currently showing
// a bubble (usually the speaker and, once they've replied at least once,
// the listener too), so the active exchange stays framed together rather
// than the camera chasing whichever of the two just started talking.
// Returns null when nobody currently has a bubble up, so the caller can
// fall back to the arena's default centered framing.
export function getConversationFocusPoint(state) {
  const participants = [...state.bubbles.keys()];
  if (participants.length === 0) return null;
  let x = 0;
  let z = 0;
  for (const participant of participants) {
    x += participant.x;
    z += participant.z;
  }
  return { x: x / participants.length, z: z / participants.length };
}

export function disposeConversation(state) {
  hideAllBubbles(state);
  for (const slot of state.ghostSlots) {
    if (slot.rig) {
      state.scene.remove(slot.rig.group);
      disposeRig(slot.rig);
    }
  }
}
