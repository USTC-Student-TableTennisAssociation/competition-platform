"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type BracketRound = {
  name: string;
  matches: Array<{
    id: string;
    homeLabel: string;
    awayLabel: string;
    homePlayerId?: string | null;
    awayPlayerId?: string | null;
    homeFilled?: boolean;
    awayFilled?: boolean;
    homeOutcome?: string;
    awayOutcome?: string;
    homeScoreText?: string;
    awayScoreText?: string;
  }>;
};

type MatchNode = {
  id: string;
  roundIndex: number;
  matchIndex: number;
  x: number;
  y: number;
  data: {
    id: string;
    homeLabel: string;
    awayLabel: string;
    homePlayerId?: string | null;
    awayPlayerId?: string | null;
    homeFilled?: boolean;
    awayFilled?: boolean;
    homeOutcome?: string;
    awayOutcome?: string;
    homeScoreText?: string;
    awayScoreText?: string;
  };
};

const CARD_W = 220;
const CARD_H = 84;
const COL_GAP = 56;
const ROW_GAP = 28;
const PAD = 36;
const CENTER_GAP = 70;
const ABSOLUTE_MIN_SCALE = 0.2;
const ABSOLUTE_MAX_SCALE = 1.8;

function splitSideRounds(rounds: BracketRound[]) {
  const preFinalRounds = rounds.slice(0, -1);

  const leftRounds = preFinalRounds.map((round) => ({
    name: round.name,
    matches: round.matches.slice(0, Math.floor(round.matches.length / 2)),
  }));

  const rightRounds = preFinalRounds.map((round) => ({
    name: round.name,
    matches: round.matches.slice(Math.floor(round.matches.length / 2)),
  }));

  return { leftRounds, rightRounds };
}

function buildYByRounds(matchCounts: number[]) {
  if (matchCounts.length === 0) return [] as number[][];

  const yRounds: number[][] = [];
  yRounds[0] = Array.from(
    { length: matchCounts[0] },
    (_, i) => PAD + i * (CARD_H + ROW_GAP),
  );

  for (let r = 1; r < matchCounts.length; r += 1) {
    const prev = yRounds[r - 1];
    const current = Array.from({ length: matchCounts[r] }, (_, i) => {
      const top = prev[i * 2];
      const bottom = prev[i * 2 + 1];
      return (top + bottom) / 2;
    });
    yRounds[r] = current;
  }

  return yRounds;
}

export default function KnockoutBracket({
  rounds,
  currentUserId,
  currentUserNickname,
  selectedMatchId,
  autoFocusMatchId,
}: {
  rounds: BracketRound[];
  currentUserId?: string | null;
  currentUserNickname?: string | null;
  selectedMatchId?: string | null;
  autoFocusMatchId?: string | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragOriginRef = useRef({ x: 0, y: 0 });
  const offsetOriginRef = useRef({ x: 0, y: 0 });
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchStartRef = useRef<{
    distance: number;
    scale: number;
    contentX: number;
    contentY: number;
  } | null>(null);

  const scene = useMemo(() => {
    if (rounds.length === 0) return null;

    if (rounds.length === 1) {
      const only = rounds[0];
      const x = PAD;
      const y = PAD;
      const width = CARD_W + PAD * 2;
      const height = CARD_H + PAD * 2;
      return {
        width,
        height,
        leftRounds: [] as BracketRound[],
        rightRounds: [] as BracketRound[],
        leftNodes: [] as MatchNode[],
        rightNodes: [] as MatchNode[],
        finalNode: {
          id: only.matches[0].id,
          roundIndex: 0,
          matchIndex: 0,
          x,
          y,
          data: only.matches[0],
        } as MatchNode,
      };
    }

    const finalRound = rounds[rounds.length - 1];
    const { leftRounds, rightRounds } = splitSideRounds(rounds);

    const leftCounts = leftRounds.map((r) => r.matches.length);
    const rightCounts = rightRounds.map((r) => r.matches.length);

    const leftY = buildYByRounds(leftCounts);
    const rightY = buildYByRounds(rightCounts);

    const preFinalCols = leftRounds.length;
    const colStep = CARD_W + COL_GAP;
    const finalX = PAD + preFinalCols * colStep + CENTER_GAP;

    const leftNodes: MatchNode[] = [];
    leftRounds.forEach((round, rIdx) => {
      round.matches.forEach((match, mIdx) => {
        leftNodes.push({
          id: match.id,
          roundIndex: rIdx,
          matchIndex: mIdx,
          x: PAD + rIdx * colStep,
          y: leftY[rIdx][mIdx],
          data: match,
        });
      });
    });

    const rightNodes: MatchNode[] = [];
    rightRounds.forEach((round, rIdx) => {
      round.matches.forEach((match, mIdx) => {
        rightNodes.push({
          id: match.id,
          roundIndex: rIdx,
          matchIndex: mIdx,
          x: finalX + CARD_W + CENTER_GAP + (preFinalCols - 1 - rIdx) * colStep,
          y: rightY[rIdx][mIdx],
          data: match,
        });
      });
    });

    const maxY = Math.max(
      ...leftNodes.map((n) => n.y + CARD_H),
      ...rightNodes.map((n) => n.y + CARD_H),
      PAD + CARD_H,
    );

    const finalNode: MatchNode = {
      id: finalRound.matches[0].id,
      roundIndex: rounds.length - 1,
      matchIndex: 0,
      x: finalX,
      y: maxY / 2 - CARD_H / 2,
      data: finalRound.matches[0],
    };

    const width = finalX + CARD_W + CENTER_GAP + preFinalCols * colStep + PAD;
    const height = Math.max(maxY + PAD, finalNode.y + CARD_H + PAD);

    return {
      width,
      height,
      leftRounds,
      rightRounds,
      leftNodes,
      rightNodes,
      finalNode,
    };
  }, [rounds]);

  const clampOffset = (
    nextOffset: { x: number; y: number },
    nextScale = scale,
  ) => {
    if (!scene) return nextOffset;
    const viewport = viewportRef.current;
    if (!viewport) return nextOffset;

    const viewportW = viewport.clientWidth;
    const viewportH = viewport.clientHeight;
    const contentW = scene.width * nextScale;
    const contentH = scene.height * nextScale;
    const pad = viewportW < 640 ? 36 : 80;

    const clampAxis = (
      value: number,
      viewportSize: number,
      contentSize: number,
    ) => {
      if (contentSize <= viewportSize) {
        return (viewportSize - contentSize) / 2;
      }
      const min = viewportSize - contentSize - pad;
      const max = pad;
      return Math.max(min, Math.min(max, value));
    };

    return {
      x: clampAxis(nextOffset.x, viewportW, contentW),
      y: clampAxis(nextOffset.y, viewportH, contentH),
    };
  };

  const getPointerDistance = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => Math.hypot(a.x - b.x, a.y - b.y);

  const getPointerMidpoint = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  const getMinScale = () => {
    if (!scene) return ABSOLUTE_MIN_SCALE;
    const viewport = viewportRef.current;
    if (!viewport) return ABSOLUTE_MIN_SCALE;

    const fitWidth = viewport.clientWidth / scene.width;
    const fitHeight = viewport.clientHeight / scene.height;
    const fitScale = Math.min(fitWidth, fitHeight);
    const fitFactor = viewport.clientWidth < 640 ? 0.62 : 0.4;

    return Math.max(ABSOLUTE_MIN_SCALE, Math.min(1, fitScale * fitFactor));
  };

  useEffect(() => {
    if (!scene) return;
    setOffset((prev) => clampOffset(prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  const zoomTo = (next: number) => {
    const minScale = getMinScale();
    const nextScale = Math.max(minScale, Math.min(ABSOLUTE_MAX_SCALE, next));
    setScale(nextScale);
    setOffset((prev) => clampOffset(prev, nextScale));
  };

  const isSelfLabel = (playerId: string | null | undefined, label: string) => {
    if (currentUserId && playerId === currentUserId) return true;
    if (currentUserNickname && label === currentUserNickname) {
      return true;
    }
    return false;
  };

  const locateToSelf = () => {
    if (!scene) return;

    const allNodes = [...scene.leftNodes, ...scene.rightNodes, scene.finalNode];
    const target = allNodes.find(
      (node) =>
        isSelfLabel(node.data.homePlayerId, node.data.homeLabel) ||
        isSelfLabel(node.data.awayPlayerId, node.data.awayLabel),
    );

    if (!target || !viewportRef.current) return;

    const viewport = viewportRef.current;
    const targetScale = Math.max(getMinScale(), Math.min(1, scale));

    const isHome = isSelfLabel(target.data.homePlayerId, target.data.homeLabel);
    const targetX = target.x + CARD_W / 2;
    const targetY = target.y + (isHome ? 33 : 61);

    const centeredOffset = {
      x: viewport.clientWidth / 2 - targetX * targetScale,
      y: viewport.clientHeight / 2 - targetY * targetScale,
    };

    setScale(targetScale);
    setOffset(clampOffset(centeredOffset, targetScale));
  };

  const focusMatchById = (matchId: string) => {
    if (!scene || !viewportRef.current) return;

    const allNodes = [...scene.leftNodes, ...scene.rightNodes, scene.finalNode];
    const target = allNodes.find((node) => node.id === matchId);
    if (!target) return;

    const viewport = viewportRef.current;
    const targetScale = Math.max(getMinScale(), Math.min(1, scale));
    const targetX = target.x + CARD_W / 2;
    const targetY = target.y + CARD_H / 2;

    const centeredOffset = {
      x: viewport.clientWidth / 2 - targetX * targetScale,
      y: viewport.clientHeight / 2 - targetY * targetScale,
    };

    setScale(targetScale);
    setOffset(clampOffset(centeredOffset, targetScale));
  };

  const buildPlayerProfileHref = (playerId?: string | null) => {
    if (!playerId) return null;
    return `/profile/${playerId}`;
  };

  useEffect(() => {
    if (!autoFocusMatchId) return;
    focusMatchById(autoFocusMatchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocusMatchId, scene]);

  const renderMatchCard = (node: MatchNode, isFinal = false) => (
    <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
      <rect
        x={0}
        y={0}
        width={CARD_W}
        height={CARD_H}
        rx={10}
        fill={isFinal ? "rgba(34,211,238,0.1)" : "rgba(30,41,59,0.85)"}
        stroke={
          node.id === selectedMatchId
            ? "rgba(250,204,21,0.95)"
            : isFinal
              ? "rgba(34,211,238,0.45)"
              : "rgba(51,65,85,1)"
        }
        strokeWidth={node.id === selectedMatchId ? 2.4 : 1}
      />
      <text
        x={isFinal ? CARD_W / 2 : 10}
        y={13}
        textAnchor={isFinal ? "middle" : "start"}
        fill={isFinal ? "rgb(165,243,252)" : "rgb(148,163,184)"}
        fontSize={11}
      >
        {node.data.id}
      </text>

      <rect
        x={8}
        y={22}
        width={CARD_W - 16}
        height={22}
        rx={6}
        fill={
          node.data.homeOutcome === "winner"
            ? "rgba(16,185,129,0.28)"
            : node.data.homeOutcome === "loser"
              ? "rgba(244,63,94,0.24)"
              : node.data.homeFilled
                ? "rgba(6,182,212,0.25)"
                : "rgba(51,65,85,0.75)"
        }
        stroke={
          isSelfLabel(node.data.homePlayerId, node.data.homeLabel)
            ? "rgba(250,204,21,0.9)"
            : "transparent"
        }
        strokeWidth={
          isSelfLabel(node.data.homePlayerId, node.data.homeLabel) ? 1.5 : 1
        }
      />
      {buildPlayerProfileHref(node.data.homePlayerId) ? (
        <a
          href={buildPlayerProfileHref(node.data.homePlayerId) ?? undefined}
          data-player-link="true"
        >
          <text
            x={14}
            y={36}
            fill="rgb(241,245,249)"
            fontSize={12}
            fontWeight={
              isSelfLabel(node.data.homePlayerId, node.data.homeLabel)
                ? "600"
                : "400"
            }
            style={{ cursor: "pointer", textDecoration: "underline" }}
          >
            {node.data.homeLabel}
            {isSelfLabel(node.data.homePlayerId, node.data.homeLabel)
              ? "（我）"
              : ""}
          </text>
        </a>
      ) : (
        <text
          x={14}
          y={36}
          fill="rgb(241,245,249)"
          fontSize={12}
          fontWeight={
            isSelfLabel(node.data.homePlayerId, node.data.homeLabel)
              ? "600"
              : "400"
          }
        >
          {node.data.homeLabel}
          {isSelfLabel(node.data.homePlayerId, node.data.homeLabel)
            ? "（我）"
            : ""}
        </text>
      )}
      {node.data.homeScoreText ? (
        <text
          x={CARD_W - 14}
          y={36}
          textAnchor="end"
          fill="rgb(226,232,240)"
          fontSize={12}
        >
          {node.data.homeScoreText}
        </text>
      ) : null}

      <rect
        x={8}
        y={50}
        width={CARD_W - 16}
        height={22}
        rx={6}
        fill={
          node.data.awayOutcome === "winner"
            ? "rgba(16,185,129,0.28)"
            : node.data.awayOutcome === "loser"
              ? "rgba(244,63,94,0.24)"
              : node.data.awayFilled
                ? "rgba(6,182,212,0.25)"
                : "rgba(51,65,85,0.75)"
        }
        stroke={
          isSelfLabel(node.data.awayPlayerId, node.data.awayLabel)
            ? "rgba(250,204,21,0.9)"
            : "transparent"
        }
        strokeWidth={
          isSelfLabel(node.data.awayPlayerId, node.data.awayLabel) ? 1.5 : 1
        }
      />
      {buildPlayerProfileHref(node.data.awayPlayerId) ? (
        <a
          href={buildPlayerProfileHref(node.data.awayPlayerId) ?? undefined}
          data-player-link="true"
        >
          <text
            x={14}
            y={64}
            fill="rgb(241,245,249)"
            fontSize={12}
            fontWeight={
              isSelfLabel(node.data.awayPlayerId, node.data.awayLabel)
                ? "600"
                : "400"
            }
            style={{ cursor: "pointer", textDecoration: "underline" }}
          >
            {node.data.awayLabel}
            {isSelfLabel(node.data.awayPlayerId, node.data.awayLabel)
              ? "（我）"
              : ""}
          </text>
        </a>
      ) : (
        <text
          x={14}
          y={64}
          fill="rgb(241,245,249)"
          fontSize={12}
          fontWeight={
            isSelfLabel(node.data.awayPlayerId, node.data.awayLabel)
              ? "600"
              : "400"
          }
        >
          {node.data.awayLabel}
          {isSelfLabel(node.data.awayPlayerId, node.data.awayLabel)
            ? "（我）"
            : ""}
        </text>
      )}
      {node.data.awayScoreText ? (
        <text
          x={CARD_W - 14}
          y={64}
          textAnchor="end"
          fill="rgb(226,232,240)"
          fontSize={12}
        >
          {node.data.awayScoreText}
        </text>
      ) : null}
    </g>
  );

  if (!scene) return null;

  return (
    <div className="space-y-2 sm:space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {selectedMatchId ? (
            <button
              type="button"
              onClick={() => focusMatchById(selectedMatchId)}
              className="rounded border border-amber-500/50 px-2 py-1 text-[11px] text-amber-200 sm:text-xs"
            >
              定位到所选对局
            </button>
          ) : null}
          <button
            type="button"
            onClick={locateToSelf}
            disabled={!currentUserId && !currentUserNickname}
            className="rounded border border-amber-500/50 px-2 py-1 text-[11px] text-amber-200 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500 sm:text-xs"
          >
            定位到我
          </button>
          <button
            type="button"
            onClick={() => zoomTo(scale - 0.1)}
            className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-200 sm:text-xs"
          >
            -
          </button>
          <span className="min-w-10 text-center text-[11px] text-slate-300 sm:text-xs">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => zoomTo(scale + 0.1)}
            className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-200 sm:text-xs"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => {
              setScale(1);
              setOffset(clampOffset({ x: 0, y: 0 }, 1));
            }}
            className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-200 sm:text-xs"
          >
            重置
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="relative h-[58dvh] min-h-[340px] touch-none overflow-hidden rounded-xl border border-slate-700 bg-slate-950/70 sm:h-[70vh]"
        onWheel={(event) => {
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            const delta = event.deltaY > 0 ? -0.08 : 0.08;
            zoomTo(scale + delta);
          }
        }}
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("a[data-player-link='true']")
          ) {
            return;
          }
          activePointersRef.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          event.currentTarget.setPointerCapture(event.pointerId);

          const pointers = Array.from(activePointersRef.current.values());
          if (pointers.length >= 2) {
            const first = pointers[0];
            const second = pointers[1];
            const midpoint = getPointerMidpoint(first, second);
            const distance = getPointerDistance(first, second);
            if (distance > 0) {
              pinchStartRef.current = {
                distance,
                scale,
                contentX: (midpoint.x - offset.x) / scale,
                contentY: (midpoint.y - offset.y) / scale,
              };
            }
            setDragging(false);
            return;
          }

          pinchStartRef.current = null;
          setDragging(true);
          dragOriginRef.current = { x: event.clientX, y: event.clientY };
          offsetOriginRef.current = offset;
        }}
        onPointerMove={(event) => {
          if (activePointersRef.current.has(event.pointerId)) {
            activePointersRef.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
          }

          const pointers = Array.from(activePointersRef.current.values());
          if (pointers.length >= 2 && pinchStartRef.current) {
            const first = pointers[0];
            const second = pointers[1];
            const midpoint = getPointerMidpoint(first, second);
            const distance = getPointerDistance(first, second);
            if (distance > 0 && pinchStartRef.current.distance > 0) {
              const minScale = getMinScale();
              const ratio = distance / pinchStartRef.current.distance;
              const nextScale = Math.max(
                minScale,
                Math.min(
                  ABSOLUTE_MAX_SCALE,
                  pinchStartRef.current.scale * ratio,
                ),
              );
              const nextOffset = {
                x: midpoint.x - pinchStartRef.current.contentX * nextScale,
                y: midpoint.y - pinchStartRef.current.contentY * nextScale,
              };
              setScale(nextScale);
              setOffset(clampOffset(nextOffset, nextScale));
            }
            return;
          }

          if (!dragging) return;
          const dx = event.clientX - dragOriginRef.current.x;
          const dy = event.clientY - dragOriginRef.current.y;
          setOffset(
            clampOffset({
              x: offsetOriginRef.current.x + dx,
              y: offsetOriginRef.current.y + dy,
            }),
          );
        }}
        onPointerUp={(event) => {
          activePointersRef.current.delete(event.pointerId);
          pinchStartRef.current = null;
          const pointers = Array.from(activePointersRef.current.values());
          if (pointers.length === 1) {
            setDragging(true);
            dragOriginRef.current = { x: pointers[0].x, y: pointers[0].y };
            offsetOriginRef.current = offset;
            return;
          }
          setDragging(false);
        }}
        onPointerCancel={(event) => {
          activePointersRef.current.delete(event.pointerId);
          pinchStartRef.current = null;
          if (activePointersRef.current.size < 2) {
            setDragging(false);
          }
        }}
        onPointerLeave={(event) => {
          activePointersRef.current.delete(event.pointerId);
          if (activePointersRef.current.size === 0) {
            pinchStartRef.current = null;
            setDragging(false);
          }
        }}
      >
        <svg
          width={scene.width}
          height={scene.height}
          className="absolute left-0 top-0"
        >
          <g transform={`translate(${offset.x} ${offset.y}) scale(${scale})`}>
            {scene.leftNodes.map((node) => {
              const next = scene.leftNodes.find(
                (n) =>
                  n.roundIndex === node.roundIndex + 1 &&
                  n.matchIndex === Math.floor(node.matchIndex / 2),
              );
              if (!next) return null;
              const x1 = node.x + CARD_W;
              const y1 = node.y + CARD_H / 2;
              const x2 = next.x;
              const y2 = next.y + CARD_H / 2;
              const xm = (x1 + x2) / 2;
              return (
                <path
                  key={`${node.id}->${next.id}`}
                  d={`M ${x1} ${y1} H ${xm} V ${y2} H ${x2}`}
                  stroke="rgba(148,163,184,0.65)"
                  fill="none"
                  strokeWidth="1.5"
                />
              );
            })}

            {scene.rightNodes.map((node) => {
              const next = scene.rightNodes.find(
                (n) =>
                  n.roundIndex === node.roundIndex + 1 &&
                  n.matchIndex === Math.floor(node.matchIndex / 2),
              );
              if (!next) return null;
              const x1 = node.x;
              const y1 = node.y + CARD_H / 2;
              const x2 = next.x + CARD_W;
              const y2 = next.y + CARD_H / 2;
              const xm = (x1 + x2) / 2;
              return (
                <path
                  key={`${node.id}->${next.id}`}
                  d={`M ${x1} ${y1} H ${xm} V ${y2} H ${x2}`}
                  stroke="rgba(148,163,184,0.65)"
                  fill="none"
                  strokeWidth="1.5"
                />
              );
            })}

            {scene.leftRounds.length > 0 &&
              (() => {
                const leftFinal = scene.leftNodes.find(
                  (n) =>
                    n.roundIndex === scene.leftRounds.length - 1 &&
                    n.matchIndex === 0,
                );
                if (!leftFinal) return null;
                const x1 = leftFinal.x + CARD_W;
                const y1 = leftFinal.y + CARD_H / 2;
                const x2 = scene.finalNode.x;
                const y2 = scene.finalNode.y + CARD_H / 2;
                const xm = (x1 + x2) / 2;
                return (
                  <path
                    d={`M ${x1} ${y1} H ${xm} V ${y2} H ${x2}`}
                    stroke="rgba(34,211,238,0.75)"
                    fill="none"
                    strokeWidth="2"
                  />
                );
              })()}

            {scene.rightRounds.length > 0 &&
              (() => {
                const rightFinal = scene.rightNodes.find(
                  (n) =>
                    n.roundIndex === scene.rightRounds.length - 1 &&
                    n.matchIndex === 0,
                );
                if (!rightFinal) return null;
                const x1 = rightFinal.x;
                const y1 = rightFinal.y + CARD_H / 2;
                const x2 = scene.finalNode.x + CARD_W;
                const y2 = scene.finalNode.y + CARD_H / 2;
                const xm = (x1 + x2) / 2;
                return (
                  <path
                    d={`M ${x1} ${y1} H ${xm} V ${y2} H ${x2}`}
                    stroke="rgba(34,211,238,0.75)"
                    fill="none"
                    strokeWidth="2"
                  />
                );
              })()}
            {scene.leftNodes.map((node) => renderMatchCard(node))}
            {scene.rightNodes.map((node) => renderMatchCard(node))}
            {renderMatchCard(scene.finalNode, true)}
          </g>
        </svg>
      </div>
    </div>
  );
}
