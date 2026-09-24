import './style.css';
import {
  CENTERLINE,
  GameState,
  INPUT,
  ScoreEvent,
  SUIT_SYMBOLS,
  TICK_HZ,
  TRACK_LEN,
  UNKNOWN,
  suitOf,
} from '@sim';
import { ApiError, Me, api, hasToken, setToken } from './api';
import {
  BoardLayout,
  Rect,
  Source,
  Target,
  autoAction,
  flushToFoundations,
  hitSource,
  hitTarget,
  isValidDrop,
  layoutBoard,
  moveAction,
  sourceCards,
  upCardY,
  wasteTopPos,
} from './board';
import { RaceClient } from './net';
import {
  Camera,
  DragState,
  Particle,
  Popup,
  SUIT_COLORS,
  Skid,
  drawBoard,
  drawHud,
  drawMinimap,
  drawOffscreenArrows,
  drawWorld,
} from './render';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const overlay = document.getElementById('overlay') as HTMLDivElement;

let W = 0;
let H = 0;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// -- Состояние приложения ----------------------------------------------------

let me: Me | null = null;
let race: RaceClient | null = null;
let resultsShown = false;
const cam: Camera = { x: CENTERLINE[0].x, y: CENTERLINE[0].y, zoom: 0.6 };
let skids: Skid[] = [];
let particles: Particle[] = [];
let popups: Popup[] = [];
let drag: DragState | null = null;
let hoverTarget: Target | null = null;
let shake: { src: Source; until: number } | null = null;
const keys = new Set<string>();

const REASONS: Record<string, string> = {
  pickup: 'карта подобрана',
  lap: 'круг!',
  foundation: 'в дом',
  tableau: 'на стол',
  flip: 'карта открыта',
  unfoundation: 'из дома',
  recycle: 'сброс вернулся на трассу',
  win: 'ПАСЬЯНС СОШЁЛСЯ!',
};

// -- Раскладка экрана --------------------------------------------------------

function layout(): { world: Rect; board: Rect } {
  if (W >= 900) {
    const bw = Math.round(Math.min(640, Math.max(420, W * 0.4)));
    return { world: { x: 0, y: 0, w: W - bw, h: H }, board: { x: W - bw, y: 0, w: bw, h: H } };
  }
  const bh = Math.round(Math.max(300, H * 0.48));
  return { world: { x: 0, y: 0, w: W, h: H - bh }, board: { x: 0, y: H - bh, w: W, h: bh } };
}

// -- Ввод --------------------------------------------------------------------

function inputMask(): number {
  let m = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) m |= INPUT.UP;
  if (keys.has('KeyS') || keys.has('ArrowDown')) m |= INPUT.DOWN;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) m |= INPUT.LEFT;
  if (keys.has('KeyD') || keys.has('ArrowRight')) m |= INPUT.RIGHT;
  return m;
}

function tryAction(src: Source, action: ReturnType<typeof autoAction>) {
  if (!race) return;
  if (!action || race.queue([action]) === 0) {
    shake = { src, until: performance.now() + 300 };
  }
}

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  if (!race || race.finished || e.repeat) return;

  const s = race.previewState();
  if (e.code === 'Space') {
    tryAction({ kind: 'waste' }, autoAction(s, { kind: 'waste' }));
  } else if (/^Digit[1-7]$/.test(e.code)) {
    const col = Number(e.code.slice(5)) - 1;
    tryAction({ kind: 'waste' }, { t: 'w2t', to: col });
  } else if (e.code === 'KeyF') {
    const acts = flushToFoundations(s);
    if (acts.length) race.queue(acts);
  } else if (e.code === 'Escape') {
    showEndDialog();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function boardLayoutNow(): BoardLayout | null {
  if (!race) return null;
  return layoutBoard(layout().board, race.previewState());
}

canvas.addEventListener('pointerdown', (e) => {
  const l = boardLayoutNow();
  if (!race || !l || race.finished) return;
  const s = race.previewState();
  const src = hitSource(l, s, e.offsetX, e.offsetY);
  if (!src) return;
  const cards = sourceCards(s, src);
  let cx = 0;
  let cy = 0;
  if (src.kind === 'waste') ({ x: cx, y: cy } = wasteTopPos(l, s));
  else if (src.kind === 'found') ({ x: cx, y: cy } = l.found[src.s]);
  else {
    cx = l.colX[src.col];
    cy = upCardY(l, src.col, s.cols[src.col], src.idx);
  }
  drag = { src, cards, x: e.offsetX, y: e.offsetY, grabX: e.offsetX - cx, grabY: e.offsetY - cy, moved: false };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y) > 6) drag.moved = true;
  if (drag.moved) {
    drag.x = e.offsetX;
    drag.y = e.offsetY;
    const l = boardLayoutNow();
    hoverTarget = l ? hitTarget(l, e.offsetX - drag.grabX + l.cardW / 2, e.offsetY - drag.grabY + l.cardH / 3) : null;
  }
});

canvas.addEventListener('pointerup', () => {
  if (!drag || !race) {
    drag = null;
    return;
  }
  const s = race.previewState();
  const d = drag;
  drag = null;
  if (!d.moved) {
    tryAction(d.src, autoAction(s, d.src));
  } else if (hoverTarget && isValidDrop(s, d.src, hoverTarget)) {
    tryAction(d.src, moveAction(s, d.src, hoverTarget));
  }
  hoverTarget = null;
});

// -- Эффекты -----------------------------------------------------------------

function onServerEvents(events: ScoreEvent[]) {
  const now = performance.now();
  for (const e of events) {
    popups.push({
      text: `${e.amount > 0 ? '+' : ''}${e.amount} ${REASONS[e.reason] ?? e.reason}`,
      color: e.amount >= 0 ? (e.reason === 'win' ? '#fde047' : '#86efac') : '#f87171',
      born: now,
    });
  }
  if (popups.length > 8) popups = popups.slice(-8);
}

let prevTrack: GameState['track'] = [];
function spawnPickupParticles(s: GameState) {
  const ids = new Set(s.track.map((t) => t.id));
  for (const t of prevTrack) {
    if (ids.has(t.id)) continue;
    const color = t.c === UNKNOWN ? '#fde68a' : SUIT_COLORS[suitOf(t.c)];
    const sym = t.c === UNKNOWN ? '?' : SUIT_SYMBOLS[suitOf(t.c)];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      particles.push({ x: t.x, y: t.y, vx: Math.cos(a) * 220, vy: Math.sin(a) * 220, life: 1, text: sym, color });
    }
  }
  prevTrack = s.track;
}

let lastSkid: { x: number; y: number } | null = null;
function trackSkids(s: GameState) {
  const c = s.car;
  const fx = Math.cos(c.a);
  const fy = Math.sin(c.a);
  const lat = Math.abs(-c.vx * fy + c.vy * fx);
  if (lat > 55) {
    const p = { x: c.x - fx * 18, y: c.y - fy * 18 };
    if (lastSkid) {
      const nx = -fy * 10;
      const ny = fx * 10;
      skids.push({ x1: lastSkid.x + nx, y1: lastSkid.y + ny, x2: p.x + nx, y2: p.y + ny });
      skids.push({ x1: lastSkid.x - nx, y1: lastSkid.y - ny, x2: p.x - nx, y2: p.y - ny });
      if (skids.length > 800) skids = skids.slice(-800);
    }
    lastSkid = p;
  } else {
    lastSkid = null;
  }
}

// -- Главный цикл ------------------------------------------------------------

let lastFrame = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const { world, board } = layout();
  ctx.clearRect(0, 0, W, H);

  if (race) {
    race.update(now, inputMask());
    const s = race.predicted;
    spawnPickupParticles(s);
    trackSkids(s);

    const carPos = { x: s.car.x + race.correction.x, y: s.car.y + race.correction.y, a: s.car.a };
    const speed = Math.hypot(s.car.vx, s.car.vy);
    const baseZoom = Math.min(1.1, Math.max(0.5, world.h / 1150));
    const targetZoom = baseZoom * (1 - Math.min(speed, 840) / 3200);
    cam.zoom += (targetZoom - cam.zoom) * Math.min(1, dt * 2);
    const tx = carPos.x + s.car.vx * 0.35;
    const ty = carPos.y + s.car.vy * 0.35;
    cam.x += (tx - cam.x) * Math.min(1, dt * 5);
    cam.y += (ty - cam.y) * Math.min(1, dt * 5);

    for (const p of particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.life -= dt * 1.4;
    }
    particles = particles.filter((p) => p.life > 0);
    popups = popups.filter((p) => now - p.born < 2500);

    drawWorld(ctx, world, cam, s, carPos, skids, particles, now / 1000);
    drawOffscreenArrows(ctx, world, cam, s);
    const mmW = Math.min(220, world.w * 0.28);
    drawMinimap(ctx, { x: world.x + 18, y: world.y + 18, w: mmW, h: mmW * 0.7 }, s, carPos);
    drawHud(ctx, world, s, {
      serverScore: race.confirmed.score,
      balance: race.balance,
      ping: race.ping,
      seq: race.seq,
      serverTick: race.confirmed.tick,
      resyncs: race.resyncs,
      popups,
      now,
    });

    const view = race.previewState();
    drawBoard(ctx, layoutBoard(board, view), view, drag, hoverTarget, shake, now);

    if (race.finished && !resultsShown) {
      resultsShown = true;
      void showResults();
    }
  } else {
    // Меню: камера медленно едет по трассе
    const t = (now / 1000) * 14;
    const p = CENTERLINE[Math.floor(t) % TRACK_LEN];
    cam.x += (p.x - cam.x) * 0.02;
    cam.y += (p.y - cam.y) * 0.02;
    cam.zoom = 0.55;
    drawWorld(ctx, { x: 0, y: 0, w: W, h: H }, cam, null, null, [], [], now / 1000);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// -- Экраны ------------------------------------------------------------------

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmt(n: string | number) {
  return Number(n).toLocaleString('ru-RU');
}

function showAuth(error = '') {
  race = null;
  overlay.className = 'show';
  overlay.innerHTML = `
    <div class="card auth">
      <h1 class="logo"><span class="r">♥</span> Cars <span class="amp">&amp;</span> Cards <span class="r">♦</span></h1>
      <p class="sub">Гонки с видом сверху + косынка. Все баллы считает сервер.</p>
      <form id="auth-form">
        <input name="nickname" placeholder="Ник" autocomplete="username" required minlength="3" maxlength="20" />
        <input name="password" type="password" placeholder="Пароль" autocomplete="current-password" required minlength="4" />
        <div class="err">${esc(error)}</div>
        <div class="row">
          <button type="submit" data-mode="login">Войти</button>
          <button type="submit" data-mode="register" class="ghost">Регистрация</button>
        </div>
      </form>
    </div>`;
  const form = document.getElementById('auth-form') as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = ((e as SubmitEvent).submitter as HTMLButtonElement)?.dataset.mode ?? 'login';
    const fd = new FormData(form);
    const nick = String(fd.get('nickname'));
    const pass = String(fd.get('password'));
    try {
      const res = mode === 'register' ? await api.register(nick, pass) : await api.login(nick, pass);
      setToken(res.access_token);
      await showMenu();
    } catch (err) {
      showAuth(err instanceof ApiError ? (err.details ?? err.message) : 'Сервер недоступен');
    }
  });
}

async function showMenu() {
  race = null;
  drag = null;
  overlay.className = 'show';
  try {
    me = await api.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setToken(null);
      return showAuth();
    }
    return showAuth('Сервер недоступен — запущен ли backend?');
  }
  const [lb, pts] = await Promise.all([api.leaderboard(), api.myPoints()]).catch(() => [null, null] as const);

  const lbRows = (rows: { nickname: string; balance: string; bestScore: number }[], key: 'balance' | 'bestScore') =>
    rows
      .map(
        (r, i) =>
          `<tr class="${r.nickname === me!.nickname ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.nickname)}</td><td class="num">${fmt(r[key])}</td></tr>`,
      )
      .join('') || '<tr><td colspan="3" class="muted">пока пусто</td></tr>';

  const reasons = (pts?.byReason ?? [])
    .sort((a, b) => b.total - a.total)
    .map((r) => `<li><span>${esc(REASONS[r.reason] ?? r.reason)} ×${r.count}</span><b class="${r.total < 0 ? 'neg' : ''}">${r.total > 0 ? '+' : ''}${fmt(r.total)}</b></li>`)
    .join('') || '<li class="muted">Ещё ничего не нафармлено</li>';

  overlay.innerHTML = `
    <div class="card menu">
      <h1 class="logo"><span class="r">♥</span> Cars <span class="amp">&amp;</span> Cards <span class="r">♦</span></h1>
      <div class="profile">
        <div><div class="muted">Игрок</div><div class="big">${esc(me.nickname)}</div></div>
        <div><div class="muted">Баланс баллов</div><div class="big green">${fmt(me.balance)} ♦</div></div>
        <div><div class="muted">Рекорд заезда</div><div class="big">${fmt(me.bestScore)}</div></div>
        <div><div class="muted">Заездов</div><div class="big">${me.racesPlayed}</div></div>
      </div>
      <div class="row">
        <button id="start">${me.activeRaceId ? 'Новый заезд' : '▶ Старт заезда'}</button>
        ${me.activeRaceId ? '<button id="resume" class="ghost">Продолжить заезд</button>' : ''}
        <button id="logout" class="ghost small">Выйти</button>
      </div>
      <div class="cols">
        <div>
          <h3>Топ по балансу</h3>
          <table>${lbRows(lb?.byBalance ?? [], 'balance')}</table>
          <h3>Лучший заезд</h3>
          <table>${lbRows(lb?.byBestRace ?? [], 'bestScore')}</table>
        </div>
        <div>
          <h3>Откуда баллы (журнал сервера)</h3>
          <ul class="ledger">${reasons}</ul>
          <h3>Как играть</h3>
          <ul class="help">
            <li><kbd>W A S D</kbd> / стрелки — руль и газ</li>
            <li>Собирай карты на трассе — они падают в сброс пасьянса</li>
            <li>Кликай/перетаскивай карты: в дом по мастям от туза, на столе — по убыванию с чередованием цвета</li>
            <li><kbd>Пробел</kbd> — авто-ход верхней карты сброса, <kbd>1–7</kbd> — в колонку, <kbd>F</kbd> — всё в дом</li>
            <li>Бонусы мастей: <b style="color:${SUIT_COLORS[0]}">♠ магнит</b>, <b style="color:${SUIT_COLORS[1]}">♥ очки ×2</b>, <b style="color:${SUIT_COLORS[2]}">♦ нитро</b>, <b style="color:${SUIT_COLORS[3]}">♣ сцепление</b></li>
            <li>Круг +50, карта +5, в дом +10, пасьянс сошёлся +500 и бонус за время. <kbd>Esc</kbd> — завершить</li>
          </ul>
        </div>
      </div>
    </div>`;
  document.getElementById('start')!.addEventListener('click', () => void startRace());
  document.getElementById('resume')?.addEventListener('click', () => void resumeRace(me!.activeRaceId!));
  document.getElementById('logout')!.addEventListener('click', () => {
    setToken(null);
    showAuth();
  });
}

function beginRace(client: RaceClient) {
  race = client;
  resultsShown = false;
  skids = [];
  particles = [];
  popups = [];
  prevTrack = client.predicted.track;
  lastSkid = null;
  cam.x = client.predicted.car.x;
  cam.y = client.predicted.car.y;
  client.onServerEvents = onServerEvents;
  overlay.className = '';
  overlay.innerHTML = '';
  canvas.focus();
}

async function startRace() {
  try {
    const view = await api.startRace();
    beginRace(new RaceClient(view.id, view, me?.balance ?? '0'));
  } catch (err) {
    alert(err instanceof ApiError ? err.message : 'Не удалось начать заезд');
  }
}

async function resumeRace(id: string) {
  try {
    const view = await api.getRace(id);
    if (view.status !== 'running') return void showMenu();
    beginRace(new RaceClient(view.id, view, me?.balance ?? '0'));
  } catch {
    void showMenu();
  }
}

function showEndDialog() {
  if (!race || race.finished) return;
  overlay.className = 'show dim';
  overlay.innerHTML = `
    <div class="card small-card">
      <h2>Завершить заезд?</h2>
      <p class="muted">Уже начисленные баллы останутся на балансе.</p>
      <div class="row">
        <button id="cont" class="ghost">Продолжить</button>
        <button id="end">Завершить</button>
      </div>
    </div>`;
  document.getElementById('cont')!.addEventListener('click', () => {
    overlay.className = '';
    overlay.innerHTML = '';
  });
  document.getElementById('end')!.addEventListener('click', () => {
    race?.endRace();
    overlay.className = '';
    overlay.innerHTML = '';
  });
}

async function showResults() {
  if (!race) return;
  const s = race.confirmed;
  const title =
    s.status === 'won' ? '🏆 Пасьянс сошёлся!' : s.status === 'timeout' ? '⏱ Время вышло' : '🏁 Заезд завершён';
  const inFound = s.found.reduce((a, b) => a + b, 0);
  overlay.className = 'show dim';
  overlay.innerHTML = `
    <div class="card small-card">
      <h2>${title}</h2>
      <div class="profile">
        <div><div class="muted">Очки заезда</div><div class="big yellow">${fmt(s.score)}</div></div>
        <div><div class="muted">Баланс</div><div class="big green">${fmt(race.balance)} ♦</div></div>
        <div><div class="muted">Круги</div><div class="big">${s.laps}</div></div>
        <div><div class="muted">Лучший круг</div><div class="big">${s.bestLap ? (s.bestLap / TICK_HZ).toFixed(2) + 'с' : '—'}</div></div>
        <div><div class="muted">Карт в доме</div><div class="big">${inFound}/52</div></div>
      </div>
      <p class="muted">Итог подтверждён сервером: он переиграл весь ваш ввод.</p>
      <div class="row">
        <button id="again">Ещё заезд</button>
        <button id="menu" class="ghost">В меню</button>
      </div>
    </div>`;
  document.getElementById('again')!.addEventListener('click', () => void startRace());
  document.getElementById('menu')!.addEventListener('click', () => void showMenu());
}

// Хук для e2e-тестов в dev-режиме (автопилот читает предсказанное состояние).
if (import.meta.env.DEV) {
  (window as unknown as { __cc: unknown }).__cc = {
    get race() {
      return race;
    },
  };
}

if (hasToken()) void showMenu();
else showAuth();
