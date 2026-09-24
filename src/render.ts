// Отрисовка на canvas: трасса с видом сверху, машина, карты-пикапы, HUD и стол косынки.

import {
  CENTERLINE,
  CHECKPOINTS,
  GameState,
  MAGNET_RADIUS,
  RANK_LABELS,
  SUIT_SYMBOLS,
  TICK_HZ,
  TIME_LIMIT_TICKS,
  TRACK_LEN,
  TRACK_WIDTH,
  UNKNOWN,
  WORLD_H,
  WORLD_W,
  isRed,
  rankOf,
  suitOf,
} from '@sim';
import {
  BoardLayout,
  Rect,
  Source,
  Target,
  isValidDrop,
  upCardY,
  wasteTopPos,
} from './board';

export const SUIT_COLORS = ['#a78bfa', '#f472b6', '#fb923c', '#4ade80'];
export const BUFF_NAMES = ['Магнит', 'Очки x2', 'Нитро', 'Сцепление'];

// -- Общие примитивы ---------------------------------------------------------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Карта лицом или рубашкой. c === UNKNOWN рисуется рубашкой со знаком «?». */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  c: number,
  x: number,
  y: number,
  w: number,
  h: number,
  faceUp = true,
  highlight: string | null = null,
) {
  const r = w * 0.09;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = w * 0.08;
  ctx.shadowOffsetY = w * 0.03;

  if (!faceUp || c === UNKNOWN) {
    roundRect(ctx, x, y, w, h, r);
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#1e40af');
    g.addColorStop(1, '#1e3a8a');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = Math.max(1, w * 0.04);
    roundRect(ctx, x + w * 0.08, y + w * 0.08, w * 0.84, h - w * 0.16, r * 0.6);
    ctx.stroke();
    ctx.fillStyle = 'rgba(248,250,252,0.35)';
    ctx.font = `${Math.round(w * 0.22)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (faceUp && c === UNKNOWN) {
      ctx.fillStyle = '#fde68a';
      ctx.font = `bold ${Math.round(w * 0.5)}px system-ui, sans-serif`;
      ctx.fillText('?', x + w / 2, y + h / 2);
    } else {
      ctx.fillText('♠♥', x + w / 2, y + h * 0.38);
      ctx.fillText('♦♣', x + w / 2, y + h * 0.62);
    }
  } else {
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = '#fdfcf7';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#d6d3c4';
    ctx.lineWidth = 1;
    ctx.stroke();

    const color = isRed(c) ? '#dc2626' : '#111827';
    const rank = RANK_LABELS[rankOf(c)];
    const suit = SUIT_SYMBOLS[suitOf(c)];
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `bold ${Math.round(w * 0.26)}px system-ui, sans-serif`;
    ctx.fillText(rank, x + w * 0.08, y + w * 0.06);
    ctx.font = `${Math.round(w * 0.22)}px system-ui, sans-serif`;
    ctx.fillText(suit, x + w * 0.09, y + w * 0.34);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(w * 0.56)}px system-ui, sans-serif`;
    ctx.fillText(suit, x + w * 0.56, y + h * 0.6);
  }

  if (highlight) {
    ctx.strokeStyle = highlight;
    ctx.lineWidth = Math.max(2, w * 0.05);
    roundRect(ctx, x - 2, y - 2, w + 4, h + 4, r + 2);
    ctx.stroke();
  }
  ctx.restore();
}

function emptySlot(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string, color = 'rgba(255,255,255,0.18)') {
  ctx.save();
  roundRect(ctx, x, y, w, h, w * 0.09);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = `${Math.round(w * 0.42)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
}

// -- Трасса ------------------------------------------------------------------

const trackPath = (() => {
  const p = new Path2D();
  p.moveTo(CENTERLINE[0].x, CENTERLINE[0].y);
  for (let i = 1; i < TRACK_LEN; i++) p.lineTo(CENTERLINE[i].x, CENTERLINE[i].y);
  p.closePath();
  return p;
})();

/** Декор на траве: крупные бледные масти, детерминированно вне трассы. */
const decor = (() => {
  const out: { x: number; y: number; s: number; size: number; rot: number }[] = [];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 260 && out.length < 90; i++) {
    const x = rnd() * WORLD_W;
    const y = rnd() * WORLD_H;
    let near = Infinity;
    for (let k = 0; k < TRACK_LEN; k += 3) {
      const dx = CENTERLINE[k].x - x;
      const dy = CENTERLINE[k].y - y;
      near = Math.min(near, dx * dx + dy * dy);
    }
    if (near < (TRACK_WIDTH * 1.3) ** 2) continue;
    out.push({ x, y, s: Math.floor(rnd() * 4), size: 50 + rnd() * 90, rot: rnd() * 6.28 });
  }
  return out;
})();

let grassPattern: CanvasPattern | null = null;
function getGrass(ctx: CanvasRenderingContext2D) {
  if (grassPattern) return grassPattern;
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2f7d3a';
  g.fillRect(0, 0, 160, 160);
  g.fillStyle = '#2a7234';
  g.fillRect(0, 0, 80, 160);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)';
    g.fillRect((i * 37) % 160, (i * 71) % 160, 3, 3);
  }
  grassPattern = ctx.createPattern(c, 'repeat');
  return grassPattern!;
}

export interface Skid {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  text: string;
  color: string;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export function drawWorld(
  ctx: CanvasRenderingContext2D,
  view: Rect,
  cam: Camera,
  s: GameState | null,
  carPos: { x: number; y: number; a: number } | null,
  skids: Skid[],
  particles: Particle[],
  time: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, view.w, view.h);
  ctx.clip();
  ctx.fillStyle = '#173d1f';
  ctx.fillRect(view.x, view.y, view.w, view.h);

  ctx.translate(view.x + view.w / 2, view.y + view.h / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  ctx.fillStyle = getGrass(ctx);
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  ctx.strokeStyle = '#0f2a15';
  ctx.lineWidth = 16;
  ctx.strokeRect(0, 0, WORLD_W, WORLD_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const d of decor) {
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.rot);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.font = `${Math.round(d.size)}px system-ui, sans-serif`;
    ctx.fillText(SUIT_SYMBOLS[d.s], 0, 0);
    ctx.restore();
  }

  // Бордюры: белое основание + красный пунктир
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#f1f5f9';
  ctx.lineWidth = TRACK_WIDTH + 22;
  ctx.stroke(trackPath);
  ctx.strokeStyle = '#dc2626';
  ctx.lineCap = 'butt';
  ctx.setLineDash([28, 28]);
  ctx.stroke(trackPath);
  ctx.setLineDash([]);
  ctx.lineCap = 'round';
  // Асфальт
  ctx.strokeStyle = '#3a3f47';
  ctx.lineWidth = TRACK_WIDTH;
  ctx.stroke(trackPath);
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = TRACK_WIDTH * 0.55;
  ctx.stroke(trackPath);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.setLineDash([36, 44]);
  ctx.stroke(trackPath);
  ctx.setLineDash([]);

  drawStartLine(ctx);

  // Следующий чекпоинт — мигающие стрелки на асфальте
  if (s) {
    const cpi = CHECKPOINTS[s.car.cp];
    const p = CENTERLINE[cpi];
    const q2 = CENTERLINE[(cpi + 1) % TRACK_LEN];
    const ang = Math.atan2(q2.y - p.y, q2.x - p.x);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang);
    ctx.globalAlpha = 0.35 + 0.25 * Math.sin(time * 6);
    ctx.fillStyle = '#fde047';
    for (const off of [-40, 0, 40]) {
      ctx.beginPath();
      ctx.moveTo(10, off);
      ctx.lineTo(-10, off - 14);
      ctx.lineTo(-10, off + 14);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // Следы шин
  ctx.strokeStyle = 'rgba(15,15,15,0.28)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const k of skids) {
    ctx.moveTo(k.x1, k.y1);
    ctx.lineTo(k.x2, k.y2);
  }
  ctx.stroke();

  if (s) {
    for (const tc of s.track) drawTrackCard(ctx, tc.c, tc.x, tc.y, tc.id, time);
  }

  if (s && carPos) {
    if (s.car.magnet > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(167,139,250,0.5)';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 10]);
      ctx.lineDashOffset = -time * 40;
      ctx.beginPath();
      ctx.arc(carPos.x, carPos.y, MAGNET_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    drawCar(ctx, carPos.x, carPos.y, carPos.a, s.car.nitro > 0, s.car.grip > 0, time);
  }

  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    ctx.fillStyle = p.color;
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawStartLine(ctx: CanvasRenderingContext2D) {
  const p = CENTERLINE[0];
  const q2 = CENTERLINE[1];
  const ang = Math.atan2(q2.y - p.y, q2.x - p.x);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  const cell = 12;
  const rows = Math.floor(TRACK_WIDTH / cell);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 2; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#111' : '#f8fafc';
      ctx.fillRect(-cell + c * cell, -TRACK_WIDTH / 2 + r * cell, cell, cell);
    }
  }
  ctx.restore();
}

function drawTrackCard(ctx: CanvasRenderingContext2D, c: number, x: number, y: number, id: number, time: number) {
  const bob = Math.sin(time * 3 + id) * 3;
  const w = 38;
  const h = 54;
  const color = c === UNKNOWN ? '#fde68a' : SUIT_COLORS[suitOf(c)];
  ctx.save();
  ctx.translate(x, y + bob);
  const pulse = 0.5 + 0.5 * Math.sin(time * 5 + id);
  const g = ctx.createRadialGradient(0, 0, 8, 0, 0, 48 + pulse * 8);
  g.addColorStop(0, color + 'aa');
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, 56, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(Math.sin(id * 1.7) * 0.35 + Math.sin(time * 2 + id) * 0.08);
  drawCard(ctx, c, -w / 2, -h / 2, w, h, true);
  ctx.restore();
}

export function drawCar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  a: number,
  nitro: boolean,
  grip: boolean,
  time: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);

  if (nitro) {
    const f = 0.7 + Math.random() * 0.5;
    const g = ctx.createLinearGradient(-26, 0, -26 - 40 * f, 0);
    g.addColorStop(0, '#fde047');
    g.addColorStop(0.4, '#fb923c');
    g.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.fillStyle = g;
    for (const oy of [-6, 6]) {
      ctx.beginPath();
      ctx.moveTo(-24, oy - 5);
      ctx.lineTo(-24 - 40 * f, oy);
      ctx.lineTo(-24, oy + 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, -22, -11, 50, 28, 8);
  ctx.fill();

  ctx.fillStyle = '#111';
  for (const [wx, wy] of [[-15, -14], [11, -14], [-15, 10], [11, 10]]) {
    roundRect(ctx, wx, wy, 11, 5, 2);
    ctx.fill();
  }

  const body = ctx.createLinearGradient(0, -12, 0, 12);
  body.addColorStop(0, grip ? '#86efac' : '#f87171');
  body.addColorStop(0.5, grip ? '#16a34a' : '#dc2626');
  body.addColorStop(1, grip ? '#14532d' : '#7f1d1d');
  ctx.fillStyle = body;
  roundRect(ctx, -24, -12, 48, 24, 8);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(-20, -2, 40, 4);

  ctx.fillStyle = '#0f172a';
  roundRect(ctx, 2, -9, 11, 18, 3);
  ctx.fill();
  ctx.fillStyle = '#1e293b';
  roundRect(ctx, -16, -8, 8, 16, 3);
  ctx.fill();

  ctx.fillStyle = '#111';
  ctx.fillRect(-26, -13, 4, 26);

  ctx.fillStyle = `rgba(254,240,138,${0.7 + 0.3 * Math.sin(time * 20)})`;
  ctx.fillRect(21, -10, 3, 5);
  ctx.fillRect(21, 5, 3, 5);
  ctx.restore();
}

// -- Миникарта и индикаторы --------------------------------------------------

export function drawMinimap(ctx: CanvasRenderingContext2D, r: Rect, s: GameState, car: { x: number; y: number }) {
  const k = Math.min(r.w / WORLD_W, r.h / WORLD_H);
  const ox = r.x + (r.w - WORLD_W * k) / 2;
  const oy = r.y + (r.h - WORLD_H * k) / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(8,15,12,0.72)';
  roundRect(ctx, r.x - 6, r.y - 6, r.w + 12, r.h + 12, 10);
  ctx.fill();
  ctx.translate(ox, oy);
  ctx.scale(k, k);
  ctx.strokeStyle = 'rgba(226,232,240,0.55)';
  ctx.lineWidth = TRACK_WIDTH * 0.6;
  ctx.lineJoin = 'round';
  ctx.stroke(trackPath);
  const st = CENTERLINE[0];
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(st.x - 40, st.y - 90, 80, 180);
  for (const tc of s.track) {
    ctx.fillStyle = tc.c === UNKNOWN ? '#fde68a' : SUIT_COLORS[suitOf(tc.c)];
    ctx.beginPath();
    ctx.arc(tc.x, tc.y, 60, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#ef4444';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 24;
  ctx.beginPath();
  ctx.arc(car.x, car.y, 80, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Стрелки у края экрана, указывающие на карты вне кадра. */
export function drawOffscreenArrows(ctx: CanvasRenderingContext2D, view: Rect, cam: Camera, s: GameState) {
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  for (const tc of s.track) {
    const sx = cx + (tc.x - cam.x) * cam.zoom;
    const sy = cy + (tc.y - cam.y) * cam.zoom;
    if (sx > view.x + 20 && sx < view.x + view.w - 20 && sy > view.y + 20 && sy < view.y + view.h - 20) continue;
    const ang = Math.atan2(sy - cy, sx - cx);
    const mx = view.w / 2 - 34;
    const my = view.h / 2 - 34;
    const t = Math.min(Math.abs(mx / Math.cos(ang)), Math.abs(my / Math.sin(ang)));
    const px = cx + Math.cos(ang) * t;
    const py = cy + Math.sin(ang) * t;
    const color = tc.c === UNKNOWN ? '#fde68a' : SUIT_COLORS[suitOf(tc.c)];
    ctx.save();
    ctx.translate(px, py);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tc.c === UNKNOWN ? '?' : SUIT_SYMBOLS[suitOf(tc.c)], 0, 1);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(28, 0);
    ctx.lineTo(19, -7);
    ctx.lineTo(19, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// -- HUD ---------------------------------------------------------------------

export interface Popup {
  text: string;
  color: string;
  born: number;
}

export interface HudInfo {
  serverScore: number;
  balance: string;
  ping: number;
  seq: number;
  serverTick: number;
  resyncs: number;
  popups: Popup[];
  now: number;
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = 'rgba(8,15,12,0.72)';
  roundRect(ctx, x, y, w, h, 10);
  ctx.fill();
}

export function drawHud(ctx: CanvasRenderingContext2D, view: Rect, s: GameState, info: HudInfo) {
  ctx.save();
  ctx.textBaseline = 'middle';

  // Время / круг — сверху по центру
  const left = Math.max(0, TIME_LIMIT_TICKS - s.tick) / TICK_HZ;
  const mm = Math.floor(left / 60);
  const ss = Math.floor(left % 60).toString().padStart(2, '0');
  const cx = view.x + view.w / 2;
  panel(ctx, cx - 120, view.y + 12, 240, 64);
  ctx.textAlign = 'center';
  ctx.fillStyle = left < 30 ? '#f87171' : '#f8fafc';
  ctx.font = 'bold 30px ui-monospace, Menlo, monospace';
  ctx.fillText(`${mm}:${ss}`, cx, view.y + 36);
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillStyle = '#cbd5e1';
  const best = s.bestLap ? ` · лучший ${(s.bestLap / TICK_HZ).toFixed(2)}с` : '';
  ctx.fillText(`Круг ${s.laps + 1}${best}`, cx, view.y + 62);

  // Баллы — справа сверху (серверные!)
  const rx = view.x + view.w - 232;
  panel(ctx, rx, view.y + 12, 220, 86);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText('ОЧКИ ЗАЕЗДА (сервер)', rx + 14, view.y + 28);
  ctx.fillStyle = '#fde047';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.fillText(String(info.serverScore), rx + 14, view.y + 52);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(`Баланс: `, rx + 14, view.y + 80);
  ctx.fillStyle = '#4ade80';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.fillText(`${Number(info.balance).toLocaleString('ru-RU')} ♦`, rx + 66, view.y + 80);

  // Всплывающие начисления от сервера
  let py = view.y + 116;
  for (const p of info.popups) {
    const age = (info.now - p.born) / 1000;
    ctx.globalAlpha = Math.max(0, 1 - age / 2.5);
    ctx.fillStyle = p.color;
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(p.text, view.x + view.w - 16, py - age * 10);
    py += 22;
  }
  ctx.globalAlpha = 1;

  // Скорость и баффы — снизу слева
  const speed = Math.hypot(s.car.vx, s.car.vy);
  const bx = view.x + 12;
  const by = view.y + view.h - 92;
  panel(ctx, bx, by, 250, 80);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 26px ui-monospace, Menlo, monospace';
  ctx.fillText(`${Math.round(speed * 0.36)}`, bx + 14, by + 26);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('км/ч', bx + 76, by + 30);
  if (s.car.off && s.car.grip === 0) {
    ctx.fillStyle = '#fbbf24';
    ctx.fillText('ТРАВА!', bx + 120, by + 28);
  }
  const buffs: [number, number, number][] = [
    [0, s.car.magnet, 5],
    [1, s.car.mult, 8],
    [2, s.car.nitro, 2.5],
    [3, s.car.grip, 5],
  ];
  buffs.forEach(([i, ticks, total], k) => {
    const x = bx + 14 + k * 58;
    const y = by + 50;
    const active = ticks > 0;
    ctx.globalAlpha = active ? 1 : 0.3;
    ctx.fillStyle = SUIT_COLORS[i];
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText(SUIT_SYMBOLS[i], x, y + 2);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(x + 20, y - 3, 30, 6);
    if (active) {
      ctx.fillStyle = SUIT_COLORS[i];
      ctx.fillRect(x + 20, y - 3, (30 * ticks) / (total * TICK_HZ), 6);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(BUFF_NAMES[i], x, y + 18);
  });

  // Сеть — снизу справа
  ctx.textAlign = 'right';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = 'rgba(226,232,240,0.6)';
  const lag = s.tick - info.serverTick;
  ctx.fillText(
    `ping ${info.ping}ms · seq ${info.seq} · сервер ${info.serverTick} / клиент ${s.tick} (+${lag})${info.resyncs ? ` · ресинк ${info.resyncs}` : ''}`,
    view.x + view.w - 12,
    view.y + view.h - 14,
  );
  ctx.restore();
}

// -- Стол косынки ------------------------------------------------------------

export interface DragState {
  src: Source;
  cards: number[];
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  moved: boolean;
}

export function drawBoard(
  ctx: CanvasRenderingContext2D,
  l: BoardLayout,
  s: GameState,
  drag: DragState | null,
  hoverTarget: Target | null,
  shake: { src: Source; until: number } | null,
  now: number,
) {
  const { rect, cardW: w, cardH: h } = l;
  ctx.save();
  const g = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
  g.addColorStop(0, '#0f5132');
  g.addColorStop(1, '#0a3622');
  ctx.fillStyle = g;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(rect.x, rect.y, 3, rect.h);

  ctx.fillStyle = '#ecfdf5';
  ctx.font = 'bold 17px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('♠ ♥ Косынка ♦ ♣', rect.x + l.pad, rect.y + l.pad + 8);
  ctx.textAlign = 'right';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(236,253,245,0.7)';
  ctx.fillText(
    `на трассе ${s.track.length} · в колоде ${s.deck.length} · сброс ${s.waste.length}`,
    rect.x + rect.w - l.pad,
    rect.y + l.pad + 8,
  );

  const hidden = (src: Source) =>
    drag && drag.moved && JSON.stringify(drag.src) === JSON.stringify(src);
  const shakeX = (src: Source) =>
    shake && shake.until > now && JSON.stringify(shake.src) === JSON.stringify(src)
      ? Math.sin(now / 20) * 5
      : 0;
  const dropColor = (t: Target) => {
    if (!drag || !drag.moved) return null;
    const valid = isValidDrop(s, drag.src, t);
    const hovered = hoverTarget && JSON.stringify(hoverTarget) === JSON.stringify(t);
    if (!valid) return null;
    return hovered ? '#fde047' : 'rgba(253,224,71,0.45)';
  };

  // Сброс (веер из трёх)
  if (s.waste.length === 0) {
    emptySlot(ctx, l.waste.x, l.waste.y, w, h, '⟳');
  } else {
    const shown = s.waste.slice(-3);
    shown.forEach((c, k) => {
      const isTop = k === shown.length - 1;
      if (isTop && hidden({ kind: 'waste' })) return;
      const dx = isTop ? shakeX({ kind: 'waste' }) : 0;
      drawCard(ctx, c, l.waste.x + k * l.wasteFan + dx, l.waste.y, w, h, true);
    });
  }
  // Дома
  const foundColor = dropColor({ kind: 'found' });
  for (let i = 0; i < 4; i++) {
    const f = l.found[i];
    const r = s.found[i];
    const src: Source = { kind: 'found', s: i };
    if (r === 0 || (hidden(src) && r === 1)) {
      emptySlot(ctx, f.x, f.y, w, h, SUIT_SYMBOLS[i], foundColor ?? 'rgba(255,255,255,0.18)');
    } else {
      const shownRank = hidden(src) ? r - 1 : r;
      drawCard(ctx, i * 13 + shownRank - 1, f.x + shakeX(src), f.y, w, h, true, foundColor);
    }
  }

  // Колонки
  for (let c = 0; c < 7; c++) {
    const col = s.cols[c];
    const x = l.colX[c];
    const st = l.colStep[c];
    const target: Target = { kind: 'col', col: c };
    const hl = dropColor(target);
    if (col.down.length === 0 && col.up.length === 0) {
      emptySlot(ctx, x, l.colY, w, h, 'K', hl ?? 'rgba(255,255,255,0.18)');
    }
    for (let k = 0; k < col.down.length; k++) {
      drawCard(ctx, UNKNOWN, x, l.colY + k * st.down, w, h, false);
    }
    const dragFrom =
      drag && drag.moved && drag.src.kind === 'col' && drag.src.col === c ? drag.src.idx : Infinity;
    for (let k = 0; k < col.up.length; k++) {
      if (k >= dragFrom) break;
      const isLast = k === col.up.length - 1 || k === dragFrom - 1;
      // Трясём всю стопку, начиная с карты, которую пытались сдвинуть.
      const shaking =
        shake && shake.until > now && shake.src.kind === 'col' && shake.src.col === c && k >= shake.src.idx;
      const dx = shaking ? Math.sin(now / 20) * 5 : 0;
      drawCard(ctx, col.up[k], x + dx, upCardY(l, c, col, k), w, h, true, isLast ? hl : null);
    }
    ctx.fillStyle = 'rgba(236,253,245,0.4)';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(c + 1), x + w / 2, l.colY - 9);
  }

  // Перетаскиваемая стопка — поверх всего
  if (drag && drag.moved) {
    const step = l.cardH * 0.27;
    drag.cards.forEach((c, k) => {
      drawCard(ctx, c, drag.x - drag.grabX, drag.y - drag.grabY + k * step, w, h, true);
    });
  }

  // Подсказки
  ctx.fillStyle = 'rgba(236,253,245,0.55)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(
    'Клик — авто-ход · перетаскивание · 1–7 — сброс в колонку · F — всё в дом',
    rect.x + l.pad,
    rect.y + rect.h - 6,
  );
  ctx.restore();
}

