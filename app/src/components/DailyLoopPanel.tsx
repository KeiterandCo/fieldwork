import { useState, type FormEvent } from 'react';
import {
  fileAsToApply,
  recordPass,
  runDailyLoop,
  runSourcedDailyLoop,
  type DailyLoopCandidateInput,
  type DailyLoopResult,
} from '../lib/intake';
import BuildProgress from './BuildProgress';
import VerdictCardView from './VerdictCardView';

interface CandidateRow {
  company: string;
  title: string;
  jd_text: string;
  url: string;
}

const EMPTY_ROW: CandidateRow = { company: '', title: '', jd_text: '', url: '' };

type RunState = 'idle' | 'loading' | 'ready' | 'error';
type RowFileState = 'idle' | 'filing' | 'filed' | 'discarded';

/** How many postings one sourcing run should try to bring back. The daily_loop function
 * clamps to 20, so don't offer more than it will honor. */
const SOURCE_COUNTS = [10, 15, 20];

const SOURCE_STAGES = [
  'Searching the web for live roles…',
  'Triaging what came back…',
  'Scoring each posting…',
];

/** Playful rotating lines for the sourcing bar (module-level so the rotation timer is
 * stable). */
const SOURCE_PHRASES = [
  'Combing the job boards…',
  'Ignoring the staffing-agency reposts…',
  'Checking who is actually still hiring…',
  'Throwing out the postings that died in March…',
  'Reading the fine print on comp…',
  'Measuring each one against your record…',
  'Lining up the honest ones…',
];

const SCORE_STAGES = [
  'Reading the job descriptions…',
  'Checking each posting is live…',
  'Scoring against your record…',
];

/** Playful rotating lines for the paste-mode scoring bar. */
const SCORE_PHRASES = [
  'Reading the job descriptions…',
  'Checking these are still open…',
  'Weighing them against your record…',
  'Looking for the catch…',
  'Being honest about the gaps…',
  'Writing the verdicts…',
];

/** [Run daily loop]: paste in N candidate roles, score them all in one call, then review
 * each resulting verdict card and file or discard it individually. The daily_loop edge
 * function deliberately does not write anything itself — see its file header — so every
 * write here is a direct result of a click on a card the user reviewed. */
export default function DailyLoopPanel() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CandidateRow[]>([{ ...EMPTY_ROW }]);
  const [runState, setRunState] = useState<RunState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<DailyLoopResult[]>([]);
  const [rowFileState, setRowFileState] = useState<Record<number, RowFileState>>({});
  const [rowFileError, setRowFileError] = useState<Record<number, string>>({});
  const [sourceCount, setSourceCount] = useState(10);
  const [runMode, setRunMode] = useState<'source' | 'paste' | null>(null);
  // Drives BuildProgress off real elapsed time, so the bar survives a re-render mid-run.
  const [startedAt, setStartedAt] = useState<number | null>(null);

  function updateRow(i: number, patch: Partial<CandidateRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, { ...EMPTY_ROW }]);
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSourceRun() {
    setRunMode('source');
    setStartedAt(Date.now());
    setRunState('loading');
    setErrorMessage(null);
    setResults([]);
    setRowFileState({});
    setRowFileError({});
    try {
      const scored = await runSourcedDailyLoop(sourceCount);
      setResults(scored);
      setRunState('ready');
      if (scored.length === 0) {
        setErrorMessage('The web search came back empty this run — try again later or paste candidates below.');
        setRunState('error');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Sourcing failed.');
      setRunState('error');
    }
  }

  async function handleRun(e: FormEvent) {
    e.preventDefault();
    const candidates: DailyLoopCandidateInput[] = rows
      .filter((r) => r.company.trim() && (r.jd_text.trim() || r.url.trim()))
      .map((r) => ({
        company: r.company.trim(),
        title: r.title.trim() || undefined,
        jd_text: r.jd_text.trim() || undefined,
        url: r.url.trim() || undefined,
      }));

    if (candidates.length === 0) {
      setErrorMessage('Add at least one candidate with a company and either JD text or a URL.');
      setRunState('error');
      return;
    }

    setRunMode('paste');
    setStartedAt(Date.now());
    setRunState('loading');
    setErrorMessage(null);
    setResults([]);
    setRowFileState({});
    setRowFileError({});
    try {
      const scored = await runDailyLoop(candidates);
      setResults(scored);
      setRunState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Daily loop failed.');
      setRunState('error');
    }
  }

  async function handleFile(i: number, result: DailyLoopResult) {
    if (!result.verdict) return;
    setRowFileState((prev) => ({ ...prev, [i]: 'filing' }));
    setRowFileError((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
    try {
      await fileAsToApply({
        company: result.company,
        title: result.title,
        card: {
          verdict: result.verdict,
          comp_min: result.comp_min ?? null,
          comp_max: result.comp_max ?? null,
          remote_type: result.remote_type ?? null,
          pain_line: result.pain_line ?? null,
          gaps: result.gaps ?? [],
          jd_text: result.jd_text ?? '',
          live_checked_at: result.live_checked_at ?? null,
        },
        url: result.url,
        source: 'daily_loop',
      });
      setRowFileState((prev) => ({ ...prev, [i]: 'filed' }));
    } catch (err) {
      setRowFileError((prev) => ({
        ...prev,
        [i]: err instanceof Error ? err.message : 'Could not file this one.',
      }));
      setRowFileState((prev) => ({ ...prev, [i]: 'idle' }));
    }
  }

  /** Discarding writes a `passed` row rather than just dimming the card. daily_loop dedupes
   * against fw_applications with no status filter, so that row is what keeps this posting
   * out of the next sourcing run — without it, everything you discard comes straight back. */
  async function handleDiscard(i: number, result: DailyLoopResult) {
    setRowFileState((prev) => ({ ...prev, [i]: 'discarded' }));
    setRowFileError((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
    try {
      await recordPass({
        company: result.company,
        title: result.title,
        verdict: result.verdict ?? null,
        source: 'daily_loop',
      });
    } catch (err) {
      // The card is already gone from view; surface why it may return tomorrow.
      setRowFileError((prev) => ({
        ...prev,
        [i]:
          (err instanceof Error ? err.message : 'Could not record the pass.') +
          ' — this role may be recommended again.',
      }));
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-medium text-text hover:text-accent"
      >
        {open ? '▾' : '▸'} Run daily loop
      </button>
      <p className="mt-1 text-xs text-text-dim">
        Search the web for new roles matching your target titles, or paste in candidates
        you've already found. Everything gets deduped against the pipeline and scored —
        nothing files until you review and click.
      </p>

      {open && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
            <button
              type="button"
              onClick={handleSourceRun}
              disabled={runState === 'loading'}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {runState === 'loading' ? 'Searching & scoring…' : 'Source from the web'}
            </button>
            <select
              value={sourceCount}
              onChange={(e) => setSourceCount(Number(e.target.value))}
              disabled={runState === 'loading'}
              aria-label="How many roles to source"
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
            >
              {SOURCE_COUNTS.map((n) => (
                <option key={n} value={n}>
                  Up to {n} roles
                </option>
              ))}
            </select>
            <p className="text-xs text-text-dim">
              Searches for live postings matching your target titles, then scores each one.
              Closed postings and anything already in the pipeline — including roles you've
              passed on — get skipped. Takes a minute or two.
            </p>
          </div>

          {runState === 'loading' && (
            <BuildProgress
              stages={runMode === 'source' ? SOURCE_STAGES : SCORE_STAGES}
              phrases={runMode === 'source' ? SOURCE_PHRASES : SCORE_PHRASES}
              startedAt={startedAt}
            />
          )}

          <form onSubmit={handleRun} className="flex flex-col gap-3">
            {rows.map((row, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
                <input
                  value={row.company}
                  onChange={(e) => updateRow(i, { company: e.target.value })}
                  placeholder="Company"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={row.title}
                  onChange={(e) => updateRow(i, { title: e.target.value })}
                  placeholder="Title"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={row.url}
                  onChange={(e) => updateRow(i, { url: e.target.value })}
                  placeholder="URL (optional)"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent sm:col-span-2"
                />
                <textarea
                  value={row.jd_text}
                  onChange={(e) => updateRow(i, { jd_text: e.target.value })}
                  rows={3}
                  placeholder="JD text (optional if URL is fetchable)"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent sm:col-span-2"
                />
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="justify-self-start text-xs text-text-dim hover:text-danger sm:col-span-2"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={addRow}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-dim transition-colors hover:text-text"
              >
                + Add another
              </button>
              <button
                type="submit"
                disabled={runState === 'loading'}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {runState === 'loading' ? 'Scoring…' : 'Score candidates'}
              </button>
            </div>

            {runState === 'error' && errorMessage && <p className="text-sm text-danger">{errorMessage}</p>}
          </form>

          {results.length > 0 && (
            <div className="flex flex-col gap-3">
              {results.map((result, i) => {
                const key = `${result.company}-${result.title ?? ''}-${i}`;
                if (result.duplicate) {
                  return (
                    <div key={key} className="rounded-xl border border-border bg-bg p-3 text-sm text-text-dim">
                      {result.company} — {result.title ?? 'Untitled role'}: already in the pipeline, skipped.
                    </div>
                  );
                }
                if (result.expired) {
                  return (
                    <div key={key} className="rounded-xl border border-border bg-bg p-3 text-sm text-text-dim">
                      {result.company} — {result.title ?? 'Untitled role'}: posting is closed, skipped.
                      {result.liveness_note ? ` ${result.liveness_note}` : ''}
                    </div>
                  );
                }
                if (result.error || !result.verdict) {
                  return (
                    <div key={key} className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                      {result.company} — {result.title ?? 'Untitled role'}: {result.error ?? 'No verdict returned.'}
                    </div>
                  );
                }
                return (
                  <div key={key} className="flex flex-col gap-1">
                    <VerdictCardView
                      card={{
                        verdict: result.verdict,
                        comp_min: result.comp_min ?? null,
                        comp_max: result.comp_max ?? null,
                        remote_type: result.remote_type ?? null,
                        location: result.location ?? null,
                        pain_line: result.pain_line ?? null,
                        gaps: result.gaps ?? [],
                        reasoning: result.reasoning ?? '',
                        liveness_note: result.liveness_note,
                      }}
                      heading={`${result.company} — ${result.title ?? 'Untitled role'}`}
                      onFile={() => handleFile(i, result)}
                      onDiscard={() => handleDiscard(i, result)}
                      filing={rowFileState[i] === 'filing'}
                      filed={rowFileState[i] === 'filed'}
                      discarded={rowFileState[i] === 'discarded'}
                    />
                    {rowFileError[i] && <p className="text-sm text-danger">{rowFileError[i]}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
