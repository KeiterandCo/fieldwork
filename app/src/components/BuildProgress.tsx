import { useEffect, useState } from 'react';

interface Props {
  /** Stage labels advanced through on a timer while the long call is awaited. Used as the
   * label only when `phrases` isn't supplied. */
  stages: string[];
  /** Flip to true when the awaited call resolves — the bar snaps to 100%. */
  done?: boolean;
  /**
   * Epoch ms the build started. When provided, progress is derived from real elapsed time
   * instead of a self-incrementing counter, so the bar stays continuous across the remounts
   * a dossier tab switch causes. Omit for a self-contained bar.
   */
  startedAt?: number | null;
  /**
   * Playful, rotating status lines (think Claude's thinking verbs). When supplied they cycle
   * as the label every few seconds, giving the wait some personality. Pass a stable
   * module-level array so the rotation timer isn't reset on every render.
   */
  phrases?: string[];
}

/** How often the bar eases forward, in ms. */
const TICK_MS = 200;
/** How long each simulated stage lasts before advancing, in ms. */
const STAGE_MS = 6000;
/** How often the whimsical phrase rotates, in ms. */
const PHRASE_MS = 2400;
/** The bar eases toward this ceiling and holds until `done` snaps it to 100. */
const HOLD_AT = 90;
/** Time constant for the elapsed-based ease, in ms (larger = slower approach to the hold). */
const EASE_TAU = 9000;

/**
 * Simulated progress for a single long await (the edge functions report no real
 * progress). The bar eases toward ~90% and holds; the label either advances through
 * `stages` or, when `phrases` is given, rotates through playful lines. No numeric
 * percentage is shown — the motion is the signal.
 */
export default function BuildProgress({ stages, done = false, startedAt = null, phrases }: Props) {
  const [progress, setProgress] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const [phraseIndex, setPhraseIndex] = useState(0);
  // When driven by startedAt, this holds the current clock so elapsed can be recomputed.
  const [now, setNow] = useState(() => Date.now());

  const timed = startedAt != null;
  const rotating = !!phrases && phrases.length > 1;

  useEffect(() => {
    if (done) return;
    if (timed) {
      const clock = window.setInterval(() => setNow(Date.now()), TICK_MS);
      return () => window.clearInterval(clock);
    }
    const bar = window.setInterval(() => {
      setProgress((p) => Math.min(HOLD_AT, p + (HOLD_AT - p) * 0.035 + 0.05));
    }, TICK_MS);
    const stage = window.setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, stages.length - 1));
    }, STAGE_MS);
    return () => {
      window.clearInterval(bar);
      window.clearInterval(stage);
    };
  }, [done, timed, stages.length]);

  // Whimsical phrase rotation runs on its own cadence (faster than stages), independent of
  // the timed/self-incrementing bar.
  useEffect(() => {
    if (done || !rotating || !phrases) return;
    const id = window.setInterval(() => {
      setPhraseIndex((i) => (i + 1) % phrases.length);
    }, PHRASE_MS);
    return () => window.clearInterval(id);
  }, [done, rotating, phrases]);

  let width: number;
  let activeStage: number;
  if (done) {
    width = 100;
    activeStage = stages.length - 1;
  } else if (timed) {
    const elapsed = Math.max(0, now - (startedAt ?? now));
    width = HOLD_AT * (1 - Math.exp(-elapsed / EASE_TAU));
    activeStage = Math.min(Math.floor(elapsed / STAGE_MS), stages.length - 1);
  } else {
    width = progress;
    activeStage = Math.min(stageIndex, stages.length - 1);
  }

  const label = done
    ? 'Done.'
    : rotating && phrases
      ? phrases[phraseIndex % phrases.length]
      : stages[activeStage] ?? 'Working…';

  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite">
      {/* Keying on the label replays the fade each time it changes. */}
      <p key={label} className="phrase-fade text-sm text-text-dim">
        {label}
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
