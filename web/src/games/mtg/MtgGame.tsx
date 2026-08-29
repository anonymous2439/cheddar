import Konva from "konva";
import { useEffect, useRef, useState } from "react";
import { Group, Image as KonvaImage, Layer, Rect, Stage, Text } from "react-konva";
import useImage from "use-image";
import * as mtgApi from "../../api/mtg";
import { useWebSocket } from "../../context/WebSocketContext";
import type { Lobby, MtgCard, MtgPhase, MtgPlayerState, MtgState, MtgZone } from "../../types";

interface Props {
  lobby: Lobby;
  currentUserId: number;
  onFinished?: () => void;
}

const PHASE_LABEL: Record<MtgPhase, string> = {
  untap: "Untap",
  upkeep: "Upkeep",
  draw: "Draw",
  main1: "Main 1",
  combat_begin: "Begin Combat",
  attackers: "Declare Attackers",
  blockers: "Declare Blockers",
  damage: "Combat Damage",
  combat_end: "End Combat",
  main2: "Main 2",
  end: "End Step",
  cleanup: "Cleanup",
};

const ALL_ZONES: MtgZone[] = ["hand", "battlefield", "graveyard", "exile", "library"];
const CANVAS_HEIGHT = 360;
const CARD_W = 64;
const CARD_H = 90;
// Keeps a dropped/repositioned card's own body fully inside the canvas —
// just enough margin for the card plus its border, no more (card options
// live in the side panel now, not as buttons under the card on-canvas, so
// there's no extra footprint below it to account for). Both margins are
// symmetric (not just top/bottom, not just left/right) because the board
// renders rotated 180° for one player (see `flipped` below) — what's
// "near the left/top" for one player is "near the right/bottom" for the
// other, so any of the four edges can end up being the close one.
const CARD_MARGIN_X = CARD_W / 2 + 2;
const CARD_MARGIN_Y = CARD_H / 2 + 2;

function clampBattlefieldPosition(x: number, y: number, canvasWidth: number): { x: number; y: number } {
  const marginXFrac = CARD_MARGIN_X / canvasWidth;
  const marginYFrac = CARD_MARGIN_Y / CANVAS_HEIGHT;
  return {
    x: Math.min(1 - marginXFrac, Math.max(marginXFrac, x)),
    y: Math.min(1 - marginYFrac, Math.max(marginYFrac, y)),
  };
}

function CardFace({ card, small }: { card: MtgCard; small?: boolean }) {
  const size = small ? "h-16 w-[46px]" : "h-24 w-[68px]";
  if (!card.name || !card.image_url) {
    return (
      <div
        className={`${size} flex items-center justify-center rounded border border-neutral-700 bg-gradient-to-br from-red-900 to-red-950 text-[8px] text-red-200`}
        title="Hidden card"
      >
        🂠
      </div>
    );
  }
  return <img src={card.image_url} alt={card.name} title={card.name} className={`${size} rounded object-cover shadow`} draggable={false} />;
}

// Drag source for hand cards and pile top cards — built on the Pointer
// Events API (not native HTML5 draggable/dragstart) since HTML5 drag-and-
// drop has no touch equivalent at all and simply doesn't fire on mobile.
// Pointer events unify mouse/touch/pen into one model, so the same handler
// works everywhere. The actual move/drop-target logic lives in the parent
// (see handlePointerUp), this just reports "a drag on this card started".
function DraggableCard({
  card,
  ownerUserId,
  fromZone,
  small,
  selectable = true,
  onDragStart,
}: {
  card: MtgCard;
  ownerUserId: number;
  fromZone: MtgZone;
  small?: boolean;
  // A plain click/tap (no real drag movement) opens the selected-card
  // panel — except for a Pile's own top-card preview, where a click should
  // instead open that pile's full browse modal (see Pile below); only a
  // card clicked *inside* that browse modal is selectable.
  selectable?: boolean;
  onDragStart: (e: React.PointerEvent, card: MtgCard, ownerUserId: number, fromZone: MtgZone, selectable: boolean) => void;
}) {
  return (
    <div
      onPointerDown={(e) => onDragStart(e, card, ownerUserId, fromZone, selectable)}
      style={{ touchAction: "none" }}
      className="cursor-grab active:cursor-grabbing"
    >
      <CardFace card={card} small={small} />
    </div>
  );
}

// One card sitting on the shared canvas. Usually a public zone (server
// never hides it) — except a face-down summon, which nulls out name/
// image_url for everyone but its owner, same as a hand card.
function BattlefieldCardNode({
  card,
  isMine,
  canvasWidth,
  flipped,
  onSelect,
  onDragEnd,
}: {
  card: MtgCard;
  isMine: boolean;
  canvasWidth: number;
  // True when the current viewer isn't the reference seat the stored (x, y)
  // is relative to — the whole board renders rotated 180° for them (both
  // axes flip), so the two players see the table the way two people
  // actually facing each other across it would: my bottom-left is their
  // upper-right, not just mirrored top-to-bottom.
  flipped: boolean;
  // Clicking no longer taps directly — it opens the card-options panel
  // (tap/untap, view full card, add/remove counter) plus a magnified
  // preview, so a misclick doesn't accidentally change board state.
  onSelect: () => void;
  onDragEnd: (finalScreenPoint: { x: number; y: number } | null, node: Konva.Node) => void;
}) {
  const [image] = useImage(card.image_url ?? "", "anonymous");
  const counterEntries = Object.entries(card.counters);
  const displayX = flipped ? 1 - card.x : card.x;
  const displayY = flipped ? 1 - card.y : card.y;
  const isHidden = !card.name || !card.image_url;

  return (
    <Group
      x={displayX * canvasWidth}
      y={displayY * CANVAS_HEIGHT}
      rotation={card.tapped ? 90 : 0}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => {
        const evt = e.evt as MouseEvent & Partial<TouchEvent>;
        const touch = evt.changedTouches?.[0];
        const point = touch ? { x: touch.clientX, y: touch.clientY } : "clientX" in evt ? { x: evt.clientX, y: evt.clientY } : null;
        onDragEnd(point, e.target);
      }}
    >
      <Rect
        width={CARD_W + 4}
        height={CARD_H + 4}
        offsetX={CARD_W / 2 + 2}
        offsetY={CARD_H / 2 + 2}
        stroke={isMine ? "#3b82f6" : "#f97316"}
        strokeWidth={2.5}
        cornerRadius={5}
        fill="#111827"
      />
      {isHidden ? (
        <>
          <Rect
            width={CARD_W}
            height={CARD_H}
            offsetX={CARD_W / 2}
            offsetY={CARD_H / 2}
            fillLinearGradientStartPoint={{ x: 0, y: 0 }}
            fillLinearGradientEndPoint={{ x: CARD_W, y: CARD_H }}
            fillLinearGradientColorStops={[0, "#7f1d1d", 1, "#450a0a"]}
            cornerRadius={4}
          />
          <Text
            width={CARD_W}
            height={CARD_H}
            offsetX={CARD_W / 2}
            offsetY={CARD_H / 2}
            align="center"
            verticalAlign="middle"
            fontSize={20}
            fill="#fca5a5"
            text="🂠"
          />
        </>
      ) : (
        image && <KonvaImage image={image} width={CARD_W} height={CARD_H} offsetX={CARD_W / 2} offsetY={CARD_H / 2} cornerRadius={4} />
      )}
      {/* Revealed to the owner but hidden from the opponent — a reminder
          badge so the owner doesn't forget it's secretly face-down. */}
      {card.face_down && !isHidden && (
        <Text
          x={-CARD_W / 2 + 2}
          y={-CARD_H / 2 + 2}
          fontSize={9}
          fill="#fca5a5"
          text="🂠 face down"
        />
      )}
      {counterEntries.length > 0 && (
        <>
          <Rect
            x={CARD_W / 2 - 20}
            y={CARD_H / 2 - 12}
            width={20}
            height={12}
            fill="black"
            opacity={0.8}
            cornerRadius={2}
          />
          <Text
            x={CARD_W / 2 - 20}
            y={CARD_H / 2 - 12}
            width={20}
            height={12}
            align="center"
            verticalAlign="middle"
            fontSize={8}
            fill="white"
            text={counterEntries.map(([, n]) => `${n >= 0 ? "+" : ""}${n}`).join(" ")}
          />
        </>
      )}
    </Group>
  );
}

function Pile({
  playerState,
  zone,
  onOpen,
  containerRef,
  onCardDragStart,
}: {
  playerState: MtgPlayerState;
  zone: "graveyard" | "exile";
  onOpen: (userId: number, zone: "graveyard" | "exile") => void;
  containerRef: (el: HTMLDivElement | null) => void;
  onCardDragStart: (e: React.PointerEvent, card: MtgCard, ownerUserId: number, fromZone: MtgZone, selectable: boolean) => void;
}) {
  const cards = playerState[zone];
  const top = cards[cards.length - 1];
  return (
    <div
      ref={containerRef}
      onClick={() => cards.length > 0 && onOpen(playerState.user_id, zone)}
      className="flex h-20 w-[56px] flex-col items-center justify-center rounded border border-dashed border-neutral-300 text-[9px] text-neutral-500"
      title={`${zone} (${cards.length})`}
    >
      {top ? (
        // Clicking the top-card preview opens this pile's browse modal
        // (via the wrapping div's onClick above), not the selected-card
        // panel — only a card clicked inside that modal is selectable.
        <DraggableCard card={top} ownerUserId={playerState.user_id} fromZone={zone} small selectable={false} onDragStart={onCardDragStart} />
      ) : (
        <span className="capitalize">{zone}</span>
      )}
      <span className="mt-0.5 font-semibold">{cards.length}</span>
    </div>
  );
}

function PlayerInfoBar({
  playerState,
  label,
  isSelf,
  onLifeChange,
  onDraw,
  onShuffle,
}: {
  playerState: MtgPlayerState;
  label: string;
  isSelf: boolean;
  onLifeChange: (delta: number) => void;
  onDraw: () => void;
  onShuffle: () => void;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="font-semibold">{label}</span>
      <span className="flex items-center gap-1">
        ❤️ {playerState.life}
        <button onClick={() => onLifeChange(-1)} className="rounded bg-neutral-200 px-1.5 text-xs hover:bg-neutral-300">
          −
        </button>
        <button onClick={() => onLifeChange(1)} className="rounded bg-neutral-200 px-1.5 text-xs hover:bg-neutral-300">
          +
        </button>
      </span>
      <span className="text-neutral-500">📚 {playerState.library_count}</span>
      {isSelf && (
        <>
          <button onClick={onDraw} className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-white hover:bg-neutral-900">
            Draw
          </button>
          <button onClick={onShuffle} className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100">
            Shuffle
          </button>
        </>
      )}
    </div>
  );
}

export function MtgGame({ lobby, currentUserId, onFinished }: Props) {
  const { subscribe } = useWebSocket();
  const [state, setState] = useState<MtgState | null>(null);
  const [error, setError] = useState("");
  const [pileView, setPileView] = useState<{ userId: number; zone: "graveyard" | "exile" } | null>(null);
  // Which card is selected (clicked) — from any zone, not just the
  // battlefield — stored as an id+zone reference rather than a snapshot, so
  // the options panel always reflects the card's live server state
  // (tap/counters) rather than freezing whatever it looked like at click
  // time, and quietly disappears once the card leaves that zone.
  const [selectedCard, setSelectedCard] = useState<{ instanceId: string; ownerUserId: number; zone: MtgZone } | null>(null);
  // Set the instant a hand card is dropped onto the battlefield — the move
  // itself waits on the face-up/face-down choice below before it's sent.
  const [pendingSummon, setPendingSummon] = useState<{ instanceId: string; ownerUserId: number; x: number; y: number } | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(640);
  // Tracks whether the canvas wrapper div is actually mounted, so the
  // ResizeObserver effect below re-runs once it exists — the component
  // returns an early "Loading…" placeholder before `state` arrives, so the
  // ref-bearing div doesn't exist yet on first mount, and a plain
  // useEffect(..., []) would attach to nothing and never retry.
  const [canvasWrapMounted, setCanvasWrapMounted] = useState(false);
  const lastFinishedRef = useRef<string | null>(null);
  const onFinishedRef = useRef(onFinished);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const handRef = useRef<HTMLDivElement | null>(null);
  const graveyardRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const exileRefs = useRef<Record<number, HTMLDivElement | null>>({});
  // The card currently being pointer-dragged (hand/pile source) — a ref
  // since drop-target detection only needs its value at pointerup, not a
  // re-render on every move; dragGhost is the bit that actually needs to
  // re-render (the floating preview following the pointer).
  const dragStateRef = useRef<{
    instanceId: string;
    ownerUserId: number;
    fromZone: MtgZone;
    card: MtgCard;
    startX: number;
    startY: number;
    selectable: boolean;
  } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ card: MtgCard; clientX: number; clientY: number } | null>(null);

  function attachCanvasWrapRef(el: HTMLDivElement | null) {
    canvasWrapRef.current = el;
    setCanvasWrapMounted(!!el);
  }

  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setCanvasWidth(Math.max(320, Math.floor(width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasWrapMounted]);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError("");
    lastFinishedRef.current = null;
    mtgApi.getMtgState(lobby.id).then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [lobby.id]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "mtg.state" && event.data.lobby_id === lobby.id) {
        setState(event.data);
      }
    });
  }, [subscribe, lobby.id]);

  useEffect(() => {
    if (!state) return;
    const marker = `${lobby.id}:${state.status}:${state.winner_user_id}`;
    if (state.status !== "in_progress" && lastFinishedRef.current !== marker) {
      lastFinishedRef.current = marker;
      onFinishedRef.current?.();
    }
  }, [state, lobby.id]);

  if (!state) {
    return <div className="p-6 text-sm text-neutral-500">Loading table…</div>;
  }

  const me = state.players.find((p) => p.user_id === currentUserId);
  const opponent = state.players.find((p) => p.user_id !== currentUserId);
  if (!me || !opponent) {
    return <div className="p-6 text-sm text-neutral-500">Waiting for both players' board state…</div>;
  }

  function run(promise: Promise<MtgState>) {
    setError("");
    promise
      .then(setState)
      .catch((err) => {
        const detail = err?.response?.data?.detail as string | undefined;
        setError(detail ?? "That didn't work");
      });
  }

  function toggleTap(card: MtgCard, ownerUserId: number) {
    run(mtgApi.tapMtgCard(lobby.id, card.id, ownerUserId, !card.tapped));
  }

  function bumpCounter(card: MtgCard, ownerUserId: number, delta: number) {
    run(mtgApi.updateMtgCounter(lobby.id, card.id, ownerUserId, "+1/+1", delta));
  }

  // Resolves a stored selection reference against the live state, so the
  // options panel always shows current tap/counter values instead of a
  // stale snapshot — and quietly disappears once the card leaves the zone
  // it was selected from (moved to a pile, played from hand, etc). Works
  // for any of the four browsable zones (library isn't sent to the client
  // card-by-card, only as a count, so it's never a selection source).
  function resolveSelection(
    sel: { instanceId: string; ownerUserId: number; zone: MtgZone } | null,
  ): { card: MtgCard; ownerUserId: number; zone: MtgZone } | null {
    if (!sel || !state) return null;
    const owner = state.players.find((p) => p.user_id === sel.ownerUserId);
    if (!owner || sel.zone === "library") return null;
    const card = owner[sel.zone].find((c) => c.id === sel.instanceId);
    return card ? { card, ownerUserId: sel.ownerUserId, zone: sel.zone } : null;
  }

  function pointInRect(point: { x: number; y: number } | null, rect: DOMRect | null | undefined): boolean {
    if (!point || !rect) return false;
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  }

  // Konva's drag system is entirely separate from native HTML5 DnD, so a
  // card leaving the canvas is detected by comparing the release point's
  // screen coordinates against each DOM drop zone's rect, rather than by
  // any drag-event payload.
  function handleBattlefieldDragEnd(card: MtgCard, ownerUserId: number, point: { x: number; y: number } | null, node: Konva.Node) {
    const handRect = ownerUserId === currentUserId ? handRef.current?.getBoundingClientRect() : null;
    const graveyardRect = graveyardRefs.current[ownerUserId]?.getBoundingClientRect();
    const exileRect = exileRefs.current[ownerUserId]?.getBoundingClientRect();

    if (pointInRect(point, handRect)) {
      run(mtgApi.moveMtgCard(lobby.id, { instanceId: card.id, ownerUserId, fromZone: "battlefield", toZone: "hand" }));
      return;
    }
    if (pointInRect(point, graveyardRect)) {
      run(mtgApi.moveMtgCard(lobby.id, { instanceId: card.id, ownerUserId, fromZone: "battlefield", toZone: "graveyard" }));
      return;
    }
    if (pointInRect(point, exileRect)) {
      run(mtgApi.moveMtgCard(lobby.id, { instanceId: card.id, ownerUserId, fromZone: "battlefield", toZone: "exile" }));
      return;
    }

    // node.x()/y() are screen-space (post-180°-rotation) — convert back to
    // the canonical, storage-relative frame before clamping/persisting.
    const screenX = node.x() / canvasWidth;
    const screenY = node.y() / CANVAS_HEIGHT;
    const canonical = { x: flipped ? 1 - screenX : screenX, y: flipped ? 1 - screenY : screenY };
    const { x, y } = clampBattlefieldPosition(canonical.x, canonical.y, canvasWidth);
    const displayX = flipped ? 1 - x : x;
    const displayY = flipped ? 1 - y : y;
    node.position({ x: displayX * canvasWidth, y: displayY * CANVAS_HEIGHT });
    run(mtgApi.moveMtgCard(lobby.id, { instanceId: card.id, ownerUserId, fromZone: "battlefield", toZone: "battlefield", x, y }));
  }

  function resolvePendingSummon(faceDown: boolean) {
    if (!pendingSummon) return;
    run(
      mtgApi.moveMtgCard(lobby.id, {
        instanceId: pendingSummon.instanceId,
        ownerUserId: pendingSummon.ownerUserId,
        fromZone: "hand",
        toZone: "battlefield",
        x: pendingSummon.x,
        y: pendingSummon.y,
        faceDown,
      }),
    );
    setPendingSummon(null);
  }

  // Pointer-based drag for hand cards and pile top cards (see DraggableCard)
  // — replaces native HTML5 drag-and-drop, which has no touch equivalent
  // and simply never fires on mobile. Pointer events unify mouse/touch/pen,
  // so this one path works everywhere. Drop-target detection is a rect-
  // overlap check at pointerup, the same technique already used for
  // dragging a battlefield card off the Konva canvas (handleBattlefieldDragEnd).
  function handleCardPointerDown(e: React.PointerEvent, card: MtgCard, ownerUserId: number, fromZone: MtgZone, selectable: boolean) {
    e.preventDefault();
    dragStateRef.current = { instanceId: card.id, ownerUserId, fromZone, card, startX: e.clientX, startY: e.clientY, selectable };
    setDragGhost({ card, clientX: e.clientX, clientY: e.clientY });
    window.addEventListener("pointermove", handleDragPointerMove);
    window.addEventListener("pointerup", handleDragPointerUp);
    window.addEventListener("pointercancel", handleDragPointerCancel);
  }

  function handleDragPointerMove(e: PointerEvent) {
    if (!dragStateRef.current) return;
    setDragGhost((g) => (g ? { ...g, clientX: e.clientX, clientY: e.clientY } : g));
  }

  function endCardDrag() {
    window.removeEventListener("pointermove", handleDragPointerMove);
    window.removeEventListener("pointerup", handleDragPointerUp);
    window.removeEventListener("pointercancel", handleDragPointerCancel);
    dragStateRef.current = null;
    setDragGhost(null);
  }

  function handleDragPointerCancel() {
    endCardDrag();
  }

  function handleDragPointerUp(e: PointerEvent) {
    const drag = dragStateRef.current;
    endCardDrag();
    if (!drag) return;
    const point = { x: e.clientX, y: e.clientY };

    // Barely any movement since pointerdown — treat this as a tap/click
    // rather than a drag-and-drop. If this card is selectable (hand cards,
    // and cards inside a pile's browse modal), that means opening the same
    // selected-card panel a battlefield card click opens (see
    // BattlefieldCardNode's onSelect). A Pile's own top-card preview isn't
    // selectable this way — its plain click is left alone so it falls
    // through to that pile's own onClick, which opens the browse modal
    // instead (see Pile below).
    if (Math.hypot(point.x - drag.startX, point.y - drag.startY) < 6) {
      if (drag.selectable) {
        setSelectedCard({ instanceId: drag.instanceId, ownerUserId: drag.ownerUserId, zone: drag.fromZone });
      }
      return;
    }

    const canvasRect = canvasWrapRef.current?.getBoundingClientRect();
    if (pointInRect(point, canvasRect) && canvasRect) {
      let x = (point.x - canvasRect.left) / canvasRect.width;
      let y = (point.y - canvasRect.top) / canvasRect.height;
      // Screen-space (post-180°-rotation) — convert to canonical before
      // clamping/persisting, same as handleBattlefieldDragEnd.
      if (flipped) {
        x = 1 - x;
        y = 1 - y;
      }
      ({ x, y } = clampBattlefieldPosition(x, y, canvasWidth));
      if (drag.fromZone === "hand") {
        // Summoning offers a face-up/face-down choice — the actual move
        // waits for that pick (see the pendingSummon prompt in the JSX below).
        setPendingSummon({ instanceId: drag.instanceId, ownerUserId: drag.ownerUserId, x, y });
      } else {
        run(
          mtgApi.moveMtgCard(lobby.id, {
            instanceId: drag.instanceId,
            ownerUserId: drag.ownerUserId,
            fromZone: drag.fromZone,
            toZone: "battlefield",
            x,
            y,
          }),
        );
      }
      return;
    }

    if (drag.fromZone !== "hand" && drag.ownerUserId === currentUserId && pointInRect(point, handRef.current?.getBoundingClientRect())) {
      run(mtgApi.moveMtgCard(lobby.id, { instanceId: drag.instanceId, ownerUserId: drag.ownerUserId, fromZone: drag.fromZone, toZone: "hand" }));
      return;
    }
    if (drag.fromZone !== "graveyard" && pointInRect(point, graveyardRefs.current[drag.ownerUserId]?.getBoundingClientRect())) {
      run(mtgApi.moveMtgCard(lobby.id, { instanceId: drag.instanceId, ownerUserId: drag.ownerUserId, fromZone: drag.fromZone, toZone: "graveyard" }));
      return;
    }
    if (drag.fromZone !== "exile" && pointInRect(point, exileRefs.current[drag.ownerUserId]?.getBoundingClientRect())) {
      run(mtgApi.moveMtgCard(lobby.id, { instanceId: drag.instanceId, ownerUserId: drag.ownerUserId, fromZone: drag.fromZone, toZone: "exile" }));
      return;
    }
    // Dropped nowhere valid — leave the card where it was.
  }

  const isMyTurn = state.active_user_id === currentUserId;
  const isFinished = state.status === "finished";
  const winnerIsMe = state.winner_user_id === currentUserId;
  // Battlefield (x, y) is stored relative to player1_user_id's seat — every
  // other viewer sees the board rotated 180° (both x and y flip), the way
  // two people actually sitting across a table from each other would see
  // it: my bottom-left is their upper-right, not just a top/bottom mirror.
  const flipped = currentUserId !== state.player1_user_id;
  const allBattlefieldCards = [
    ...opponent.battlefield.map((c) => ({ card: c, ownerUserId: opponent.user_id, isMine: false })),
    ...me.battlefield.map((c) => ({ card: c, ownerUserId: me.user_id, isMine: true })),
  ];
  const selected = resolveSelection(selectedCard);
  // Every zone but wherever the card currently sits is a valid transfer target.
  const moveTargets = selected ? ALL_ZONES.filter((z) => z !== selected.zone) : [];

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">🃏 {lobby.name}</h2>
        {!isFinished && (
          <button onClick={() => run(mtgApi.concedeMtg(lobby.id))} className="text-xs text-neutral-500 hover:text-red-600 hover:underline">
            Concede
          </button>
        )}
      </div>

      {isFinished ? (
        <p className="text-sm font-semibold">{winnerIsMe ? "You win — opponent conceded!" : "You conceded — opponent wins."}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
          <span>
            Turn {state.turn_number} · <span className="font-semibold">{PHASE_LABEL[state.phase]}</span>
          </span>
          <span className={isMyTurn ? "font-semibold text-green-700" : "text-neutral-500"}>{isMyTurn ? "Your turn" : "Opponent's turn"}</span>
          <button onClick={() => run(mtgApi.advanceMtgPhase(lobby.id))} className="rounded bg-neutral-800 px-2 py-1 text-xs text-white hover:bg-neutral-900">
            Next Phase →
          </button>
        </div>
      )}

      <PlayerInfoBar
        playerState={opponent}
        label="Opponent"
        isSelf={false}
        onLifeChange={(d) => run(mtgApi.adjustMtgLife(lobby.id, opponent.user_id, d))}
        onDraw={() => {}}
        onShuffle={() => {}}
      />

      {/* Main column (battlefield, "You" bar, hand) all share the
          battlefield's own width. The selected-card/zones panel is a true
          aside next to it — stretched (via items-stretch, the flex default)
          to match the column's full height rather than just the canvas's,
          so it has the whole column to scroll alongside instead of a
          fixed, canvas-only sliver. */}
      <div className="flex items-stretch gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div
            ref={attachCanvasWrapRef}
            className="relative overflow-hidden rounded border border-neutral-300 bg-gradient-to-b from-neutral-50 to-green-50"
            style={{ height: CANVAS_HEIGHT }}
          >
            <div className="pointer-events-none absolute left-2 top-2 text-[10px] font-semibold uppercase text-neutral-400">Battlefield</div>
            <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-neutral-300" />
            <Stage width={canvasWidth} height={CANVAS_HEIGHT}>
              <Layer>
                {allBattlefieldCards.map(({ card, ownerUserId, isMine }) => (
                  <BattlefieldCardNode
                    key={card.id}
                    card={card}
                    isMine={isMine}
                    canvasWidth={canvasWidth}
                    flipped={flipped}
                    onSelect={() => setSelectedCard({ instanceId: card.id, ownerUserId, zone: "battlefield" })}
                    onDragEnd={(point, node) => handleBattlefieldDragEnd(card, ownerUserId, point, node)}
                  />
                ))}
              </Layer>
            </Stage>
          </div>

          <PlayerInfoBar
            playerState={me}
            label="You"
            isSelf={true}
            onLifeChange={(d) => run(mtgApi.adjustMtgLife(lobby.id, me.user_id, d))}
            onDraw={() => run(mtgApi.drawMtgCard(lobby.id))}
            onShuffle={() => run(mtgApi.shuffleMtgLibrary(lobby.id))}
          />

          <div ref={handRef} className="flex min-h-[104px] flex-wrap gap-1 rounded border border-blue-200 bg-blue-50/40 p-2">
            <span className="w-full text-[10px] font-semibold uppercase text-neutral-400">Your hand ({me.hand.length})</span>
            {me.hand.map((card) => (
              <DraggableCard key={card.id} card={card} ownerUserId={currentUserId} fromZone="hand" onDragStart={handleCardPointerDown} />
            ))}
          </div>
        </div>

        {/* Selected-card panel lives in-flow beside the board instead of
            floating over it — it never covers board state, and its
            presence/absence never steals focus the way a modal overlay
            would. */}
        <div className="flex w-60 flex-shrink-0 flex-col gap-2">
          <div className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-300 bg-white p-2 shadow-sm">
            {selected ? (
              <>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-neutral-500">
                    Selected card <span className="capitalize text-neutral-400">· {selected.zone}</span>
                  </span>
                  <button onClick={() => setSelectedCard(null)} className="text-xs text-neutral-500 hover:underline">
                    Close
                  </button>
                </div>
                <div className="mb-2 flex justify-center">
                  {selected.card.name && selected.card.image_url ? (
                    <img src={selected.card.image_url} alt={selected.card.name} className="w-full max-w-[160px] rounded shadow" />
                  ) : (
                    <div className="flex h-44 w-full max-w-[160px] items-center justify-center rounded bg-gradient-to-br from-red-900 to-red-950 text-3xl text-red-200">
                      🂠
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  {selected.zone === "battlefield" && (
                    <>
                      <button
                        onClick={() => toggleTap(selected.card, selected.ownerUserId)}
                        className="w-full rounded bg-neutral-800 px-2 py-1 text-xs text-white hover:bg-neutral-900"
                      >
                        {selected.card.tapped ? "Untap" : "Tap"}
                      </button>
                      <div className="flex items-center justify-between rounded border border-neutral-200 px-2 py-1">
                        <span className="text-xs">+1/+1: {selected.card.counters["+1/+1"] ?? 0}</span>
                        <div className="flex gap-1">
                          <button
                            onClick={() => bumpCounter(selected.card, selected.ownerUserId, -1)}
                            className="rounded bg-neutral-200 px-2 text-xs hover:bg-neutral-300"
                          >
                            −
                          </button>
                          <button
                            onClick={() => bumpCounter(selected.card, selected.ownerUserId, 1)}
                            className="rounded bg-neutral-200 px-2 text-xs hover:bg-neutral-300"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                  <div className="rounded border border-neutral-200 p-1">
                    <span className="mb-1 block text-[10px] font-semibold uppercase text-neutral-400">Move to zone</span>
                    <div className="grid grid-cols-2 gap-1">
                      {moveTargets.map((zone) => (
                        <button
                          key={zone}
                          onClick={() => {
                            // Summoning from hand offers a face-up/face-down
                            // choice — same prompt a hand->battlefield drag
                            // triggers (see resolvePendingSummon) — every
                            // other transfer applies immediately.
                            if (selected.zone === "hand" && zone === "battlefield") {
                              setPendingSummon({ instanceId: selected.card.id, ownerUserId: selected.ownerUserId, x: 0.5, y: 0.5 });
                              setSelectedCard(null);
                              return;
                            }
                            run(
                              mtgApi.moveMtgCard(lobby.id, {
                                instanceId: selected.card.id,
                                ownerUserId: selected.ownerUserId,
                                fromZone: selected.zone,
                                toZone: zone,
                                ...(zone === "battlefield" ? { x: 0.5, y: 0.5 } : {}),
                              }),
                            );
                          }}
                          className="rounded border border-neutral-300 px-1.5 py-1 text-[11px] capitalize hover:bg-neutral-100"
                        >
                          {zone}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex h-32 items-center justify-center text-center text-xs text-neutral-400">
                Click any card — battlefield, hand, graveyard, or exile — to view it here
              </div>
            )}
          </div>

          <div className="grid flex-shrink-0 grid-cols-4 gap-1">
            <Pile
              playerState={opponent}
              zone="graveyard"
              onOpen={(userId, zone) => setPileView({ userId, zone })}
              containerRef={(el) => (graveyardRefs.current[opponent.user_id] = el)}
              onCardDragStart={handleCardPointerDown}
            />
            <Pile
              playerState={opponent}
              zone="exile"
              onOpen={(userId, zone) => setPileView({ userId, zone })}
              containerRef={(el) => (exileRefs.current[opponent.user_id] = el)}
              onCardDragStart={handleCardPointerDown}
            />
            <Pile
              playerState={me}
              zone="graveyard"
              onOpen={(userId, zone) => setPileView({ userId, zone })}
              containerRef={(el) => (graveyardRefs.current[me.user_id] = el)}
              onCardDragStart={handleCardPointerDown}
            />
            <Pile
              playerState={me}
              zone="exile"
              onOpen={(userId, zone) => setPileView({ userId, zone })}
              containerRef={(el) => (exileRefs.current[me.user_id] = el)}
              onCardDragStart={handleCardPointerDown}
            />
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {dragGhost && (
        <div
          className="pointer-events-none fixed z-50 opacity-90"
          style={{ left: dragGhost.clientX - 34, top: dragGhost.clientY - 48 }}
        >
          <CardFace card={dragGhost.card} />
        </div>
      )}

      {pendingSummon && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPendingSummon(null)}>
          <div className="rounded bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <p className="mb-3 text-sm font-semibold">Summon this card face up or face down?</p>
            <div className="flex gap-2">
              <button
                onClick={() => resolvePendingSummon(false)}
                className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-900"
              >
                Face Up
              </button>
              <button
                onClick={() => resolvePendingSummon(true)}
                className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
              >
                Face Down
              </button>
            </div>
          </div>
        </div>
      )}

      {pileView &&
        (() => {
          const p = state.players.find((pl) => pl.user_id === pileView.userId);
          const cards = p ? p[pileView.zone] : [];
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPileView(null)}>
              <div className="max-h-[80vh] w-80 overflow-y-auto rounded bg-white p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold capitalize">{pileView.zone}</h3>
                  <button onClick={() => setPileView(null)} className="text-xs text-neutral-500 hover:underline">
                    Close
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {cards.map((card) => (
                    <DraggableCard
                      key={card.id}
                      card={card}
                      ownerUserId={pileView.userId}
                      fromZone={pileView.zone}
                      onDragStart={handleCardPointerDown}
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
