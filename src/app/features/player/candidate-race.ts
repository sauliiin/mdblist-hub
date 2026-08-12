/**
 * Outcome of probing one stream away from the visible player.
 *
 * `'timeout'` is deliberately distinct from `'failed'`: a real media error
 * (bad container, 404, decode failure) means the link is genuinely broken,
 * but a probe that never fired `playing` in time is ambiguous — under 16
 * concurrent muted downloads a perfectly good but slower mirror can miss the
 * window on bandwidth contention alone. `player.ts` gives `'timeout'`
 * candidates one retry with less contention before writing them off too.
 */
export type ProbeOutcome = 'ready' | 'failed' | 'decoy' | 'timeout';

/** Stops all network and media work owned by one probe. */
export interface ProbeHandle {
  cancel(): void;
}

export type ProbeLauncher<T> = (
  candidate: T,
  settle: (outcome: ProbeOutcome) => void,
) => ProbeHandle;

export interface CandidateRaceCallbacks<T> {
  started?(candidate: T, started: number, total: number): void;
  rejected?(candidate: T, outcome: Exclude<ProbeOutcome, 'ready'>): void;
  winner(candidate: T): void;
  exhausted(): void;
}

/**
 * Keeps a fixed-size window of probes alive and promotes the first candidate
 * that is genuinely ready. A failed slot is immediately filled from the tail,
 * so one slow host never serialises the whole source list.
 */
export class CandidateRace<T> implements ProbeHandle {
  private readonly active = new Map<number, ProbeHandle>();
  private next = 0;
  private stopped = false;
  private readonly candidates: readonly T[];
  private readonly concurrency: number;
  private readonly launch: ProbeLauncher<T>;
  private readonly callbacks: CandidateRaceCallbacks<T>;

  constructor(
    candidates: readonly T[],
    concurrency: number,
    launch: ProbeLauncher<T>,
    callbacks: CandidateRaceCallbacks<T>,
  ) {
    this.candidates = candidates;
    this.concurrency = concurrency;
    this.launch = launch;
    this.callbacks = callbacks;
  }

  start(): void {
    if (!this.candidates.length) {
      this.stopped = true;
      this.callbacks.exhausted();
      return;
    }

    this.fill();
  }

  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const handle of this.active.values()) handle.cancel();
    this.active.clear();
  }

  private fill(): void {
    const limit = Math.max(1, this.concurrency);
    while (!this.stopped && this.active.size < limit && this.next < this.candidates.length) {
      this.launchOne(this.next++);
    }

    if (!this.stopped && !this.active.size && this.next >= this.candidates.length) {
      this.stopped = true;
      this.callbacks.exhausted();
    }
  }

  private launchOne(index: number): void {
    const candidate = this.candidates[index];
    // Reserve the slot before calling user code: a synthetic/test probe is
    // allowed to settle synchronously from inside `launch`.
    let handle: ProbeHandle = { cancel() {} };
    this.active.set(index, handle);
    this.callbacks.started?.(candidate, index + 1, this.candidates.length);

    let settled = false;
    const settle = (outcome: ProbeOutcome) => {
      if (settled || this.stopped) return;
      settled = true;

      this.active.get(index)?.cancel();
      this.active.delete(index);

      if (outcome === 'ready') {
        this.stopped = true;
        for (const other of this.active.values()) other.cancel();
        this.active.clear();
        this.callbacks.winner(candidate);
        return;
      }

      this.callbacks.rejected?.(candidate, outcome);
      this.fill();
    };

    handle = this.launch(candidate, settle);
    if (settled || this.stopped) {
      handle.cancel();
    } else {
      this.active.set(index, handle);
    }
  }
}
