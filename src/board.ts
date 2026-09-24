// Геометрия стола косынки и превращение жестов мыши/клавиш в ходы симуляции.

import {
  Action,
  Column,
  GameState,
  UNKNOWN,
  canPlaceOnColumn,
  canPlaceOnFoundation,
  suitOf,
} from '@sim';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardLayout {
  rect: Rect;
  cardW: number;
  cardH: number;
  gap: number;
  pad: number;
  headerH: number;
  waste: { x: number; y: number };
  wasteFan: number;
  found: { x: number; y: number }[];
  colX: number[];
  colY: number;
  /** Вертикальные шаги (закрытые/открытые) — свои для каждой колонки. */
  colStep: { down: number; up: number }[];
}

export function layoutBoard(rect: Rect, s: GameState): BoardLayout {
  const pad = Math.max(12, Math.min(20, rect.w * 0.03));
  const headerH = 34;
  const gapRatio = 0.14;
  const cardW = Math.min(96, (rect.w - pad * 2) / (7 + 6 * gapRatio));
  const cardH = cardW * 1.4;
  const gap = cardW * gapRatio;
  const colX = Array.from({ length: 7 }, (_, i) => rect.x + pad + i * (cardW + gap));
  const row1 = rect.y + pad + headerH;
  const colY = row1 + cardH + pad * 1.2;
  const available = rect.y + rect.h - pad - colY - cardH;

  const colStep = s.cols.map((col) => {
    let down = cardH * 0.12;
    let up = cardH * 0.27;
    const need = col.down.length * down + Math.max(0, col.up.length - 1) * up;
    if (need > available && need > 0) {
      const k = Math.max(0.2, available / need);
      down *= k;
      up *= k;
    }
    return { down, up };
  });

  return {
    rect,
    cardW,
    cardH,
    gap,
    pad,
    headerH,
    waste: { x: colX[0], y: row1 },
    wasteFan: cardW * 0.3,
    found: [3, 4, 5, 6].map((i) => ({ x: colX[i], y: row1 })),
    colX,
    colY,
    colStep,
  };
}

/** Координата y открытой карты k в колонке. */
export function upCardY(l: BoardLayout, colIndex: number, col: Column, k: number): number {
  const st = l.colStep[colIndex];
  return l.colY + col.down.length * st.down + k * st.up;
}

/** Позиция верхней видимой карты сброса (веер из трёх). */
export function wasteTopPos(l: BoardLayout, s: GameState): { x: number; y: number } {
  const shown = Math.min(3, s.waste.length);
  return { x: l.waste.x + Math.max(0, shown - 1) * l.wasteFan, y: l.waste.y };
}

// -- Источник и цель перетаскивания ------------------------------------------

export type Source =
  | { kind: 'waste' }
  | { kind: 'col'; col: number; idx: number }
  | { kind: 'found'; s: number };

export type Target = { kind: 'col'; col: number } | { kind: 'found' };

function inside(px: number, py: number, x: number, y: number, w: number, h: number) {
  return px >= x && px <= x + w && py >= y && py <= y + h;
}

/** Какую карту (стопку) схватили в точке. */
export function hitSource(l: BoardLayout, s: GameState, px: number, py: number): Source | null {
  if (s.waste.length > 0) {
    const p = wasteTopPos(l, s);
    if (inside(px, py, p.x, p.y, l.cardW, l.cardH)) return { kind: 'waste' };
  }
  for (let i = 0; i < 4; i++) {
    const f = l.found[i];
    if (s.found[i] > 0 && inside(px, py, f.x, f.y, l.cardW, l.cardH)) return { kind: 'found', s: i };
  }
  for (let c = 0; c < 7; c++) {
    const col = s.cols[c];
    for (let k = col.up.length - 1; k >= 0; k--) {
      const y = upCardY(l, c, col, k);
      if (inside(px, py, l.colX[c], y, l.cardW, l.cardH)) {
        if (col.up[k] === UNKNOWN) return null;
        return { kind: 'col', col: c, idx: k };
      }
    }
  }
  return null;
}

export function sourceCards(s: GameState, src: Source): number[] {
  switch (src.kind) {
    case 'waste':
      return s.waste.length ? [s.waste[s.waste.length - 1]] : [];
    case 'found':
      return s.found[src.s] > 0 ? [src.s * 13 + s.found[src.s] - 1] : [];
    case 'col':
      return s.cols[src.col].up.slice(src.idx);
  }
}

/** Куда бросили: колонка по X (ниже строки домов) или любой дом. */
export function hitTarget(l: BoardLayout, px: number, py: number): Target | null {
  if (py < l.colY - l.pad * 0.6) {
    const f0 = l.found[0];
    if (px >= f0.x - l.gap && py >= f0.y - l.gap && py <= f0.y + l.cardH + l.gap) {
      return { kind: 'found' };
    }
    return null;
  }
  for (let c = 0; c < 7; c++) {
    if (px >= l.colX[c] - l.gap / 2 && px <= l.colX[c] + l.cardW + l.gap / 2) {
      return { kind: 'col', col: c };
    }
  }
  return null;
}

export function moveAction(s: GameState, src: Source, dst: Target): Action | null {
  if (dst.kind === 'found') {
    if (src.kind === 'waste') return { t: 'w2f' };
    if (src.kind === 'col' && src.idx === s.cols[src.col].up.length - 1) {
      return { t: 't2f', from: src.col };
    }
    return null;
  }
  if (src.kind === 'waste') return { t: 'w2t', to: dst.col };
  if (src.kind === 'found') return { t: 'f2t', s: src.s, to: dst.col };
  if (src.col === dst.col) return null;
  return { t: 't2t', from: src.col, n: s.cols[src.col].up.length - src.idx, to: dst.col };
}

export function isValidDrop(s: GameState, src: Source, dst: Target): boolean {
  const cards = sourceCards(s, src);
  if (!cards.length) return false;
  if (dst.kind === 'found') {
    return cards.length === 1 && src.kind !== 'found' && canPlaceOnFoundation(cards[0], s.found);
  }
  if (src.kind === 'col' && src.col === dst.col) return false;
  return canPlaceOnColumn(cards[0], s.cols[dst.col]);
}

/**
 * Лучший ход для клика по карте: сначала в дом, затем на непустую
 * колонку, затем (король) на пустую.
 */
export function autoAction(s: GameState, src: Source): Action | null {
  const cards = sourceCards(s, src);
  if (!cards.length) return null;
  if (src.kind !== 'found' && cards.length === 1 && canPlaceOnFoundation(cards[0], s.found)) {
    return moveAction(s, src, { kind: 'found' });
  }
  const order = [0, 1, 2, 3, 4, 5, 6].sort(
    (a, b) => Number(s.cols[a].up.length === 0) - Number(s.cols[b].up.length === 0),
  );
  for (const c of order) {
    if (src.kind === 'col' && src.col === c) continue;
    // Не гоняем короля с одной пустой колонки на другую.
    if (
      src.kind === 'col' &&
      src.idx === 0 &&
      s.cols[src.col].down.length === 0 &&
      s.cols[c].up.length === 0
    ) {
      continue;
    }
    if (canPlaceOnColumn(cards[0], s.cols[c])) return moveAction(s, src, { kind: 'col', col: c });
  }
  return null;
}

/** «Всё в дом»: цепочка ходов, пока хоть что-то можно положить. */
export function flushToFoundations(s0: GameState): Action[] {
  const s = JSON.parse(JSON.stringify(s0)) as GameState;
  const out: Action[] = [];
  for (let guard = 0; guard < 60; guard++) {
    let moved = false;
    const w = s.waste[s.waste.length - 1];
    if (w !== undefined && canPlaceOnFoundation(w, s.found)) {
      s.waste.pop();
      s.found[suitOf(w)]++;
      out.push({ t: 'w2f' });
      moved = true;
    }
    for (let c = 0; c < 7; c++) {
      const col = s.cols[c];
      const top = col.up[col.up.length - 1];
      if (top !== undefined && canPlaceOnFoundation(top, s.found)) {
        col.up.pop();
        s.found[suitOf(top)]++;
        // Открытие закрытой карты предсказать нельзя (она неизвестна) —
        // дальше по этой колонке цепочку не строим.
        if (col.up.length === 0 && col.down.length > 0) col.up.push(UNKNOWN);
        out.push({ t: 't2f', from: c });
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}
