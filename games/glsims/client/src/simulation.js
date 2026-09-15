// Autonomous behavior state machine — one independent instance per
// character, no player input anywhere in this file. Each character
// wanders, sits, and occasionally picks another (unclaimed) character to
// walk over to and either hit or kiss, then goes back to wandering.
//
// decideNextAction() is deliberately the one place a future "manually
// pick this character's next action" feature would hook in — it would
// just replace the random pickWeighted() call with whatever the user
// selected, without touching any of the state-machine plumbing below.
import {
  buildStickFigure,
  updateWalkCycle,
  applyIdlePose,
  applySitPose,
  applyHitWindupPose,
  applyHitSwingPose,
  applyReactPose,
  applyKissPose,
  applyFightPose,
  FIGHT_EXCHANGE_MS,
  PUNCH_IMPACT_T,
  KICK_IMPACT_T,
  applyKnockedDownPose,
  KNOCKDOWN_FALL_MS,
  applyLyingPose,
  applyLaunchedPose,
  applyDancePose,
  syncNameLabel,
  disposeRig,
  setFaceExpression,
} from "./character.js";

// A wide rectangle, not a square — long enough (east-west, X) to comfortably
// hold the full 25-name roster, shallow (north-south, Z) to keep the default
// landscape camera framing (see game.js) tight on the action.
export const ARENA_HALF_X = 18; // characters wander within [-ARENA_HALF_X, ARENA_HALF_X] on the long axis
export const ARENA_HALF_Z = 6; // ...and [-ARENA_HALF_Z, ARENA_HALF_Z] on the short axis
const WALK_SPEED = 1.3;
const ARRIVE_DIST = 0.15;
export const INTERACTION_RANGE = 1.0; // conversation.js also uses this to detect "arrived to talk"
const IDLE_MIN_MS = 1000;
const IDLE_MAX_MS = 2600;
const SIT_MIN_MS = 3000;
const SIT_MAX_MS = 6500;
const HIT_WINDUP_MS = 300;
const HIT_SWING_MS = 280;
const HIT_REACT_MS = 450;
const DANCE_MIN_MS = 4000;
const DANCE_MAX_MS = 9000;
// A lingering, "really intimate" embrace rather than a quick peck, per
// explicit request — see applyKissPose in character.js for the pose curve
// that fills this whole duration.
const KISS_MS = 30000;

// Nobody's root position may get closer than this to anybody else's,
// most of the time — the general "don't walk through each other" collider.
// Deliberately less than INTERACTION_RANGE (1.0) so a character walking up
// to start a hit/kiss always triggers that state transition well before
// this would ever push them back apart.
const PERSONAL_SPACE = 0.6;
// The one exception: an active kissing pair is allowed to close all the
// way down to this distance (see moveTowardDistance below), which is
// tighter than PERSONAL_SPACE but still leaves enough gap that the two
// rigs' leaned-forward heads/torsos don't actually clip into each other —
// tuned against KISS_LEAN_MAX/KISS_HEAD_REACH in character.js. Brought in
// closer than the original 0.75 per explicit request — with bodies
// already this close, closing the remaining gap needs much less forward
// lean, so KISS_LEAN_MAX/KISS_HEAD_REACH came down to match.
const INTIMATE_DISTANCE = 0.5;
// How fast a kissing pair closes the gap between their INTERACTION_RANGE
// approach distance and INTIMATE_DISTANCE — slower than a normal walk, for
// a slow, deliberate "closing in" rather than a brisk final step.
const EMBRACE_CLOSE_SPEED = 0.9;

// A fight runs for a random duration up to this max ("can last up to 30
// seconds") rather than always the full length, so not every brawl drags
// on equally long — unless a finishing blow ends it early (see below).
const FIGHT_MIN_MS = 8000;
const FIGHT_MAX_MS = 30000;
// Each exchange has this chance of being a finishing blow instead of a
// normal hit — a hard punch drops the target straight to the ground, a
// hard kick sends them flying before they land — either way the fight
// ends there rather than continuing to the normal exchange rhythm.
const FIGHT_HARD_HIT_CHANCE = 0.15;
const KICK_LAUNCH_SPEED = 3.5; // horizontal, units/sec
const KICK_LAUNCH_UP_SPEED = 5.5; // vertical, units/sec
const GRAVITY = 14;
const LYING_MS = 2600; // how long a finished-off fighter stays down before getting back up

// Standing around (thinking) is the single most common thing a character
// does — walking, sitting, dancing, and the interactions are all less
// frequent than that by design.
const ACTIONS = [
  { name: "idle", weight: 34 },
  { name: "walk", weight: 20 },
  { name: "sit", weight: 12 },
  { name: "dance", weight: 10 },
  { name: "hit", weight: 6 },
  { name: "kiss", weight: 8 },
  { name: "fight", weight: 10 },
];

function pickWeighted(list) {
  const total = list.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of list) {
    if (roll < item.weight) return item.name;
    roll -= item.weight;
  }
  return list[list.length - 1].name;
}

function randomArenaPoint() {
  return {
    x: (Math.random() * 2 - 1) * ARENA_HALF_X,
    z: (Math.random() * 2 - 1) * ARENA_HALF_Z,
  };
}

export function createCharacter(scene, color, x, z, name) {
  const rig = buildStickFigure(color, name);
  rig.group.position.set(x, 0, z);
  scene.add(rig.group);
  return {
    rig,
    name, // matched against the live conversation feed's "name" field (see conversation.js) for chat bubbles
    x,
    y: 0, // ground level except while "launched" by a finishing kick
    z,
    facingAngle: Math.random() * Math.PI * 2,
    state: "idle",
    stateEnteredAt: 0,
    stateDurationMs: IDLE_MIN_MS,
    walkTargetX: x,
    walkTargetZ: z,
    // Where a "conv_approaching" walk heads toward — a plain world point
    // rather than another characters[] index, since the target of a
    // conversation walk-over can be a ghost angel (see conversation.js's
    // ghost slot system), which has no index into this array at all.
    convTargetX: x,
    convTargetZ: z,
    partnerIndex: -1,
    approachIntent: null,
    // True while some other character has picked *this* one as their
    // interaction target — keeps a third character from also claiming it
    // at the same time.
    isClaimed: false,
    // Fight-only scheduling state — see the "fighting" case below.
    // fightRole is "a" or "b"; fightStartedAt/fightDurationMs are copied
    // identically onto both fighters at fight start so each side can
    // independently compute whose turn it is to strike this exchange.
    fightRole: null,
    fightStartedAt: 0,
    fightDurationMs: 0,
    // Guards the once-per-exchange hard-hit roll below from re-rolling on
    // every frame of the same exchange.
    lastFightExchangeIndex: -1,
    pendingHardHit: false,
    // Set only while "launched" (a finishing kick's flight arc).
    launchVX: 0,
    launchVY: 0,
    launchVZ: 0,
    // Index of whoever this character is *currently* touching (within
    // PERSONAL_SPACE), or -1 — see resolveCollisions' accidental-bump
    // fight roll. Guards a single contact (which can span several frames
    // while the collider gradually separates them) from rolling more than
    // once; cleared once they're no longer touching.
    bumpedWith: -1,
  };
}

export function disposeCharacter(scene, character) {
  scene.remove(character.rig.group);
  disposeRig(character.rig);
}

export function distanceTo(c, x, z) {
  return Math.hypot(x - c.x, z - c.z);
}

export function faceToward(c, x, z) {
  const dx = x - c.x;
  const dz = z - c.z;
  if (Math.hypot(dx, dz) < 0.001) return;
  c.facingAngle = Math.atan2(dx, dz);
}

function moveToward(c, x, z, dt) {
  const dx = x - c.x;
  const dz = z - c.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.001) return;
  const step = Math.min(dist, WALK_SPEED * dt);
  c.x += (dx / dist) * step;
  c.z += (dz / dist) * step;
  faceToward(c, x, z);
}

// Like moveToward, but stops short at desiredDistance instead of walking
// all the way to the target point — used by the kiss states to close the
// gap from the initial INTERACTION_RANGE approach distance down to a true
// embrace distance, then hold there (once dist <= desiredDistance this is
// a no-op, so both partners settle in place rather than jittering).
function moveTowardDistance(c, x, z, desiredDistance, speed, dt) {
  const dx = x - c.x;
  const dz = z - c.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= desiredDistance) return;
  const step = Math.min(dist - desiredDistance, speed * dt);
  c.x += (dx / dist) * step;
  c.z += (dz / dist) * step;
  faceToward(c, x, z);
}

function isIntimateState(state) {
  return state === "kissing" || state === "kissing_reply";
}

// Sets both sides up identically for a fight, whichever way it started —
// a deliberate approach (see the "approaching" case's fight branch below)
// or an accidental shoulder-bump (see resolveCollisions below). Both
// fighters end up with a valid partnerIndex pointing at each other, which
// alone already excludes them from isFreeToInteract; isClaimed is set too
// for consistency with how a deliberate target gets claimed the moment
// they're picked, not just once the fight actually starts.
function startFight(a, indexA, b, indexB, now) {
  const fightStartedAt = now;
  const fightDurationMs = FIGHT_MIN_MS + Math.random() * (FIGHT_MAX_MS - FIGHT_MIN_MS);
  for (const [fighter, role, partnerIndex] of [
    [a, "a", indexB],
    [b, "b", indexA],
  ]) {
    fighter.isClaimed = true;
    fighter.partnerIndex = partnerIndex;
    fighter.approachIntent = "fight";
    fighter.state = "fighting";
    fighter.stateEnteredAt = now;
    fighter.fightRole = role;
    fighter.fightStartedAt = fightStartedAt;
    fighter.fightDurationMs = fightDurationMs;
    fighter.lastFightExchangeIndex = -1;
  }
}

// Only wandering, unclaimed characters can accidentally bump into each
// other — someone already mid-interaction (sitting, dancing, claimed by
// or approaching another character) is either not moving into anyone's
// way or is already accounted for by its own interaction's collision
// handling (e.g. a kissing pair).
function isBumpable(character) {
  return !character.isClaimed && character.partnerIndex === -1 && (character.state === "idle" || character.state === "walking");
}

const BUMP_FIGHT_CHANCE = 0.5;

// General body collider — run once per frame, after every character's own
// state-machine update, so nobody's root position ends up closer than
// PERSONAL_SPACE to anybody else's (they'd otherwise just walk straight
// through each other, since nothing in updateCharacter's per-character
// logic knows about anyone but its own interaction partner). The one pair
// allowed closer is an active kissing pair, which gets INTIMATE_DISTANCE
// instead — moveTowardDistance above is what actually pulls them in that
// close in the first place; this is just the floor that keeps them (or an
// unrelated third character) from pressing in past it.
//
// Also where an accidental shoulder-bump between two wandering characters
// gets its one dice roll: a coin-flip chance the bump escalates into a
// full fight (reusing the exact same fight state machine as a deliberate
// one). bumpedWith tracks who each character is *currently* touching so a
// single contact — which can span several frames while the push-apart
// above gradually separates them — only ever rolls once, not once per
// frame; it's cleared the moment they're no longer within PERSONAL_SPACE,
// so a later, separate contact can roll again.
export function resolveCollisions(characters, now) {
  for (let i = 0; i < characters.length; i++) {
    for (let j = i + 1; j < characters.length; j++) {
      const a = characters[i];
      const b = characters[j];
      const isKissPair = isIntimateState(a.state) && isIntimateState(b.state) && (a.partnerIndex === j || b.partnerIndex === i);
      const minDist = isKissPair ? INTIMATE_DISTANCE : PERSONAL_SPACE;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let dist = Math.hypot(dx, dz);
      if (dist >= minDist) {
        if (a.bumpedWith === j) a.bumpedWith = -1;
        if (b.bumpedWith === i) b.bumpedWith = -1;
        continue;
      }
      if (dist < 0.0001) {
        dx = 1;
        dz = 0;
        dist = 0.0001;
      }
      const overlap = minDist - dist;
      const pushX = (dx / dist) * (overlap / 2);
      const pushZ = (dz / dist) * (overlap / 2);
      a.x -= pushX;
      a.z -= pushZ;
      b.x += pushX;
      b.z += pushZ;

      if (!isKissPair && a.bumpedWith !== j && isBumpable(a) && isBumpable(b)) {
        a.bumpedWith = j;
        b.bumpedWith = i;
        if (Math.random() < BUMP_FIGHT_CHANCE) {
          startFight(a, i, b, j, now);
        }
      }
    }
  }
}

export function enterIdle(c, now) {
  c.state = "idle";
  c.stateEnteredAt = now;
  c.stateDurationMs = IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS);
}

function enterWalk(c, now, x, z) {
  c.state = "walking";
  c.stateEnteredAt = now;
  c.walkTargetX = x;
  c.walkTargetZ = z;
}

function enterSit(c, now) {
  c.state = "sitting";
  c.stateEnteredAt = now;
  c.stateDurationMs = SIT_MIN_MS + Math.random() * (SIT_MAX_MS - SIT_MIN_MS);
}

function enterDance(c, now) {
  c.state = "dancing";
  c.stateEnteredAt = now;
  c.stateDurationMs = DANCE_MIN_MS + Math.random() * (DANCE_MAX_MS - DANCE_MIN_MS);
}

// Shared "can this character be pulled into a new interaction right now"
// check — used both for hit/kiss/fight target-picking below and for
// conversation.js recruiting a next speaker. Dancing is deliberately not
// included: a character mid-dance-break is "busy" the same way one that's
// already claimed is.
export function isFreeToInteract(character) {
  if (character.isClaimed || character.partnerIndex !== -1) return false;
  return character.state === "idle" || character.state === "walking" || character.state === "sitting";
}

function pickFreePartnerIndex(characters, selfIndex) {
  const candidates = [];
  for (let i = 0; i < characters.length; i++) {
    if (i === selfIndex) continue;
    if (isFreeToInteract(characters[i])) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function decideNextAction(c, index, characters, now) {
  const action = pickWeighted(ACTIONS);
  if (action === "idle") {
    // Re-rolls a fresh idle stand rather than falling through to a new
    // action immediately — this is the "just stands there thinking a
    // while longer" outcome, and it's the most heavily weighted one.
    enterIdle(c, now);
    return;
  }
  if (action === "walk") {
    const p = randomArenaPoint();
    enterWalk(c, now, p.x, p.z);
    return;
  }
  if (action === "sit") {
    enterSit(c, now);
    return;
  }
  if (action === "dance") {
    enterDance(c, now);
    return;
  }
  // hit, kiss, or fight — needs a free partner; falls back to a walk if everyone
  // else is already busy, rather than idling forever waiting for one.
  const partnerIndex = pickFreePartnerIndex(characters, index);
  if (partnerIndex === -1) {
    const p = randomArenaPoint();
    enterWalk(c, now, p.x, p.z);
    return;
  }
  c.state = "approaching";
  c.stateEnteredAt = now;
  c.partnerIndex = partnerIndex;
  c.approachIntent = action;
  characters[partnerIndex].isClaimed = true;
}

export function updateCharacter(c, index, characters, now, dt) {
  // Default for every state below except the three that set their own
  // (kissing/kissing_reply via applyKissPose, fighting via applyFightPose,
  // conv_talking just below) — cheap to call unconditionally since
  // setFaceExpression no-ops when the texture's already showing.
  setFaceExpression(c.rig, "neutral");

  switch (c.state) {
    case "idle":
      applyIdlePose(c.rig, dt);
      if (now - c.stateEnteredAt >= c.stateDurationMs) decideNextAction(c, index, characters, now);
      break;

    case "walking":
      moveToward(c, c.walkTargetX, c.walkTargetZ, dt);
      updateWalkCycle(c.rig, dt);
      if (distanceTo(c, c.walkTargetX, c.walkTargetZ) < ARRIVE_DIST) enterIdle(c, now);
      break;

    case "sitting":
      applySitPose(c.rig, dt);
      if (now - c.stateEnteredAt >= c.stateDurationMs) enterIdle(c, now);
      break;

    case "dancing":
      applyDancePose(c.rig, dt);
      if (now - c.stateEnteredAt >= c.stateDurationMs) enterIdle(c, now);
      break;

    case "approaching": {
      const partner = characters[c.partnerIndex];
      if (!partner) {
        enterIdle(c, now);
        break;
      }
      // Recomputed every frame (rather than a one-shot waypoint like the
      // plain "walking" case) since the partner may itself be moving.
      moveToward(c, partner.x, partner.z, dt);
      updateWalkCycle(c.rig, dt);
      if (distanceTo(c, partner.x, partner.z) < INTERACTION_RANGE) {
        faceToward(c, partner.x, partner.z);
        faceToward(partner, c.x, c.z);
        if (c.approachIntent === "hit") {
          c.state = "hit_windup";
          c.stateEnteredAt = now;
          // Freezes the target in place (facing the attacker) for the
          // rest of the windup+swing — without this, a target that was
          // still "walking" or "sitting" when claimed would keep doing
          // its own thing and could wander off mid-animation, making the
          // swing visually whiff at empty space.
          partner.state = "awaiting_hit";
          partner.stateEnteredAt = now;
        } else if (c.approachIntent === "fight") {
          startFight(c, index, partner, c.partnerIndex, now);
        } else {
          c.state = "kissing";
          c.stateEnteredAt = now;
          partner.state = "kissing_reply";
          partner.stateEnteredAt = now;
          // kissing_reply's own moveTowardDistance (below) needs to know
          // who to close the embrace distance with — every other partner
          // reference on this object already points the other way (c
          // already has partner.index via c.partnerIndex).
          partner.partnerIndex = index;
        }
      }
      break;
    }

    case "hit_windup":
      applyHitWindupPose(c.rig, now - c.stateEnteredAt, HIT_WINDUP_MS);
      if (now - c.stateEnteredAt >= HIT_WINDUP_MS) {
        c.state = "hit_swing";
        c.stateEnteredAt = now;
      }
      break;

    case "hit_swing": {
      const elapsed = now - c.stateEnteredAt;
      applyHitSwingPose(c.rig, elapsed, HIT_SWING_MS);
      if (elapsed >= HIT_SWING_MS) {
        const partner = characters[c.partnerIndex];
        if (partner) {
          partner.state = "reacting_hit";
          partner.stateEnteredAt = now;
        }
        c.partnerIndex = -1;
        c.approachIntent = null;
        enterIdle(c, now);
      }
      break;
    }

    // Held by the attacker's own hit_windup/hit_swing transitions above —
    // just stands its ground facing the attacker until struck.
    case "awaiting_hit":
      break;

    case "reacting_hit": {
      const elapsed = now - c.stateEnteredAt;
      applyReactPose(c.rig, elapsed, HIT_REACT_MS);
      if (elapsed >= HIT_REACT_MS) {
        c.isClaimed = false;
        enterIdle(c, now);
      }
      break;
    }

    case "kissing": {
      const elapsed = now - c.stateEnteredAt;
      const partner = characters[c.partnerIndex];
      if (partner) moveTowardDistance(c, partner.x, partner.z, INTIMATE_DISTANCE, EMBRACE_CLOSE_SPEED, dt);
      applyKissPose(c.rig, elapsed, KISS_MS, dt);
      if (elapsed >= KISS_MS) {
        c.partnerIndex = -1;
        c.approachIntent = null;
        enterIdle(c, now);
      }
      break;
    }

    case "fighting": {
      const elapsed = now - c.fightStartedAt;
      const partner = characters[c.partnerIndex];
      if (!partner || elapsed >= c.fightDurationMs) {
        c.partnerIndex = -1;
        c.approachIntent = null;
        c.fightRole = null;
        // Harmless no-op for whichever side was the original initiator
        // (isClaimed is only ever set true on the target side) — cheaper
        // than tracking which of the two this character was.
        c.isClaimed = false;
        enterIdle(c, now);
        break;
      }
      const exchangeIndex = Math.floor(elapsed / FIGHT_EXCHANGE_MS);
      const isAttacker = (exchangeIndex % 2 === 0) === (c.fightRole === "a");
      const localT = (elapsed % FIGHT_EXCHANGE_MS) / FIGHT_EXCHANGE_MS;

      if (isAttacker) {
        // Rolled once per exchange (guarded by lastFightExchangeIndex),
        // then actually resolved at the strike's own impact moment below
        // — so the normal windup/strike animation still plays out before
        // a finishing blow lands, rather than cutting the fight short
        // before the audience even sees the hit connect.
        if (exchangeIndex !== c.lastFightExchangeIndex) {
          c.lastFightExchangeIndex = exchangeIndex;
          c.pendingHardHit = Math.random() < FIGHT_HARD_HIT_CHANCE;
        }
        const isPunch = exchangeIndex % 2 === 0;
        const impactT = isPunch ? PUNCH_IMPACT_T : KICK_IMPACT_T;
        if (c.pendingHardHit && localT >= impactT) {
          c.pendingHardHit = false;
          const dx = partner.x - c.x;
          const dz = partner.z - c.z;
          const dist = Math.hypot(dx, dz) || 1;
          if (isPunch) {
            partner.state = "knocked_down";
            partner.stateEnteredAt = now;
          } else {
            partner.state = "launched";
            partner.stateEnteredAt = now;
            partner.launchVX = (dx / dist) * KICK_LAUNCH_SPEED;
            partner.launchVZ = (dz / dist) * KICK_LAUNCH_SPEED;
            partner.launchVY = KICK_LAUNCH_UP_SPEED;
          }
          partner.partnerIndex = -1;
          partner.isClaimed = false;
          partner.fightRole = null;
          c.partnerIndex = -1;
          c.approachIntent = null;
          c.fightRole = null;
          c.isClaimed = false;
          enterIdle(c, now);
          break;
        }
      }
      applyFightPose(c.rig, elapsed, isAttacker);
      break;
    }

    case "knocked_down": {
      const elapsed = now - c.stateEnteredAt;
      applyKnockedDownPose(c.rig, elapsed);
      if (elapsed >= KNOCKDOWN_FALL_MS) {
        c.state = "lying";
        c.stateEnteredAt = now;
      }
      break;
    }

    case "launched": {
      c.launchVY -= GRAVITY * dt;
      c.x += c.launchVX * dt;
      c.z += c.launchVZ * dt;
      c.y += c.launchVY * dt;
      applyLaunchedPose(c.rig, now - c.stateEnteredAt);
      if (c.y <= 0) {
        c.y = 0;
        c.state = "lying";
        c.stateEnteredAt = now;
      }
      break;
    }

    case "lying":
      applyLyingPose(c.rig);
      if (now - c.stateEnteredAt >= LYING_MS) enterIdle(c, now);
      break;

    case "kissing_reply": {
      const elapsed = now - c.stateEnteredAt;
      const partner = characters[c.partnerIndex];
      if (partner) moveTowardDistance(c, partner.x, partner.z, INTIMATE_DISTANCE, EMBRACE_CLOSE_SPEED, dt);
      applyKissPose(c.rig, elapsed, KISS_MS, dt);
      if (elapsed >= KISS_MS) {
        c.partnerIndex = -1;
        c.isClaimed = false;
        enterIdle(c, now);
      }
      break;
    }

    // The four conversation.js states below only handle the *mechanical*
    // side (movement/pose) — all the cross-character decisions (who's
    // arrived, when to advance to the next line, when the whole exchange
    // ends) live in conversation.js's own per-frame update instead, since
    // that's the one place that actually knows the scripted dialogue data.
    // Recruited but not yet doing anything — a brief forced "stops and
    // settles" beat before either starting to talk (no target) or walking
    // over to whoever they're joining, per the explicit ask that a
    // just-recruited character always turns idle first.
    case "conv_settling":
      applyIdlePose(c.rig, dt);
      break;

    case "conv_approaching": {
      // convTargetX/Z (a plain world point conversation.js sets directly,
      // not necessarily another character's position — see that field's
      // comment in createCharacter) rather than resolving through
      // characters[c.partnerIndex], which a ghost-angel target has no
      // valid entry for at all.
      moveToward(c, c.convTargetX, c.convTargetZ, dt);
      updateWalkCycle(c.rig, dt);
      break;
    }

    // conv_talking (bubble showing, this is the current speaker) and
    // conv_listening (present in the conversation, waiting their turn or
    // just finished talking) are otherwise visually identical — both just
    // stand and idle; conversation.js is what actually attaches/removes
    // the bubble. Only the active talker gets the confused face, per
    // explicit request ("confuse face when talking") — the listener keeps
    // the neutral default set above.
    case "conv_talking":
      applyIdlePose(c.rig, dt);
      setFaceExpression(c.rig, "confused");
      break;
    case "conv_listening":
      applyIdlePose(c.rig, dt);
      break;
  }

  syncNameLabel(c.rig);
}
