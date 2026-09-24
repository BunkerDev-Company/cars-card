// Клиент заезда: предсказание + сверка с авторитетным сервером.
//
// Каждый кадр клиент продвигает локальную копию симуляции (predicted) по
// реальному времени и копит нажатые клавиши в буфер. Буфер пачками уходит
// на сервер; сервер переигрывает ввод и возвращает своё состояние
// (confirmed). После ответа predicted = confirmed + ещё не отправленный ввод.
// Всё, что клиент «насчитал» сам, — только картинка; баллы и карты решает сервер.

import {
  Action,
  GameState,
  ScoreEvent,
  TICK_MS,
  TimedAction,
  applyAction,
  cloneState,
  simulateBatch,
  simulateTick,
} from '@sim';
import { ApiError, BatchResult, RaceView, api } from './api';

const MAX_BATCH = 120;
const SEND_INTERVAL_MS = 100;

export class RaceClient {
  confirmed: GameState;
  predicted: GameState;
  seq: number;
  balance: string;
  ping = 0;
  resyncs = 0;
  /** Смещение отрисовки машины после коррекции — плавно гасится. */
  correction = { x: 0, y: 0 };

  onServerEvents?: (events: ScoreEvent[]) => void;
  onLocalEvents?: (events: ScoreEvent[]) => void;

  private buf: { inputs: number[]; actions: TimedAction[] } = { inputs: [], actions: [] };
  private queued: Action[] = [];
  private inFlight = false;
  private lastSend = 0;
  private t0: number;
  private resyncing = false;

  constructor(
    public readonly id: string,
    view: RaceView,
    balance: string,
  ) {
    this.confirmed = view.state;
    this.predicted = cloneState(view.state);
    this.seq = view.seq;
    this.balance = balance;
    this.t0 = performance.now() - view.state.tick * TICK_MS;
  }

  get finished(): boolean {
    return this.confirmed.status !== 'running';
  }

  /**
   * Ставит ходы в очередь на следующий тик. Ходы проверяются на копии
   * предсказанного состояния последовательно, чтобы цепочка (например,
   * «всё в дом») была валидной целиком. Возвращает число принятых ходов.
   */
  queue(actions: Action[]): number {
    const test = cloneState(this.predicted);
    for (const a of this.queued) applyAction(test, a, []);
    let accepted = 0;
    for (const a of actions) {
      if (applyAction(test, a, [])) {
        this.queued.push(a);
        accepted++;
      }
    }
    return accepted;
  }

  /** Состояние с учётом ещё не применённых ходов — для подсказок UI. */
  previewState(): GameState {
    if (this.queued.length === 0) return this.predicted;
    const s = cloneState(this.predicted);
    for (const a of this.queued) applyAction(s, a, []);
    return s;
  }

  update(now: number, input: number) {
    let target = Math.floor((now - this.t0) / TICK_MS);
    // Вкладка спала — не догоняем пропущенное время рывком, а «ставим на паузу».
    if (target - this.predicted.tick > 30) {
      this.t0 = now - this.predicted.tick * TICK_MS;
      target = this.predicted.tick + 1;
    }

    const local: ScoreEvent[] = [];
    while (!this.resyncing && this.predicted.tick < target && this.predicted.status === 'running') {
      const acts = this.queued;
      this.queued = [];
      const i = this.buf.inputs.length;
      this.buf.inputs.push(input);
      for (const a of acts) this.buf.actions.push({ i, a });
      simulateTick(this.predicted, input, acts, local);
    }
    // Ход «завершить» мог прийти уже после остановки симуляции (например, timeout).
    if (this.predicted.status !== 'running') this.queued = [];
    if (local.length) this.onLocalEvents?.(local);

    this.decayCorrection();
    this.flush(now);
  }

  endRace() {
    this.queue([{ t: 'end' }]);
  }

  private decayCorrection() {
    this.correction.x *= 0.85;
    this.correction.y *= 0.85;
    if (Math.abs(this.correction.x) < 0.1) this.correction.x = 0;
    if (Math.abs(this.correction.y) < 0.1) this.correction.y = 0;
  }

  private flush(now: number) {
    if (this.inFlight || this.resyncing || this.buf.inputs.length === 0) return;
    const ended = this.predicted.status !== 'running';
    if (!ended && this.buf.inputs.length < 6 && now - this.lastSend < SEND_INTERVAL_MS) return;

    const n = Math.min(this.buf.inputs.length, MAX_BATCH);
    const inputs = this.buf.inputs.slice(0, n);
    const actions = this.buf.actions.filter((a) => a.i < n);
    this.buf = {
      inputs: this.buf.inputs.slice(n),
      actions: this.buf.actions.filter((a) => a.i >= n).map((a) => ({ i: a.i - n, a: a.a })),
    };

    this.inFlight = true;
    this.lastSend = now;
    const seq = this.seq + 1;
    const sentAt = performance.now();
    api
      .sendBatch(this.id, seq, inputs, actions)
      .then((res) => {
        this.ping = Math.round(performance.now() - sentAt);
        this.ack(res);
      })
      .catch((err: unknown) => this.fail(err))
      .finally(() => {
        this.inFlight = false;
      });
  }

  private ack(res: BatchResult) {
    this.seq = res.seq;
    this.balance = res.balance;
    this.confirmed = res.state;
    this.rebuild();
    if (res.events.length) this.onServerEvents?.(res.events);
  }

  /** predicted = confirmed + неотправленный ввод. */
  private rebuild() {
    const p = cloneState(this.confirmed);
    simulateBatch(p, this.buf.inputs, this.buf.actions, []);
    const dx = this.predicted.car.x - p.car.x;
    const dy = this.predicted.car.y - p.car.y;
    // Небольшое расхождение сглаживаем, большое — честный телепорт.
    if (dx * dx + dy * dy < 200 * 200) {
      this.correction.x += dx;
      this.correction.y += dy;
    }
    this.predicted = p;
  }

  private fail(err: unknown) {
    const status = err instanceof ApiError ? err.status : 0;
    // 409/429 — рассинхронизация с сервером, сеть — повторим после ресинка.
    const delay = status === 0 ? 1000 : 0;
    this.resyncing = true;
    setTimeout(() => void this.resync(), delay);
  }

  private async resync() {
    try {
      const view = await api.getRace(this.id);
      this.resyncs++;
      this.confirmed = view.state;
      this.predicted = cloneState(view.state);
      this.seq = view.seq;
      this.buf = { inputs: [], actions: [] };
      this.queued = [];
      this.t0 = performance.now() - view.state.tick * TICK_MS;
      this.resyncing = false;
    } catch {
      setTimeout(() => void this.resync(), 1500);
    }
  }
}
