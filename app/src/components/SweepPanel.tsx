import { useState, type FormEvent } from 'react';
import { runSweep, type SweepMailItem, type SweepResult } from '../lib/sweep';

interface ItemRow {
  from: string;
  subject: string;
  snippet: string;
}

const EMPTY_ROW: ItemRow = { from: '', subject: '', snippet: '' };

type RunState = 'idle' | 'loading' | 'ready' | 'error';

const CLASSIFICATION_LABEL: Record<SweepResult['classification'], string> = {
  rejection: 'Rejection',
  interview_invite: 'Interview invite',
  other: 'Other / no match',
};

/** [Sweep now] — Phase 4 per SPEC.md §5/§9. There is no mail-provider OAuth app wired up for
 * this project (see the sweep edge function's file header), so this panel is a manual
 * pasting surface: paste in a handful of email summaries (from/subject/snippet) gathered
 * from wherever — the existing Claude Code mail-sweep job, a manual glance at the inbox —
 * and the edge function classifies each against the open pipeline and writes
 * rejections/lessons or surfaces interview invites as a note, same as an automated run
 * would once real mail access exists. */
export default function SweepPanel() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ItemRow[]>([{ ...EMPTY_ROW }]);
  const [runState, setRunState] = useState<RunState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<SweepResult[]>([]);

  function updateRow(i: number, patch: Partial<ItemRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, { ...EMPTY_ROW }]);
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleRun(e: FormEvent) {
    e.preventDefault();
    const items: SweepMailItem[] = rows
      .filter((r) => r.from.trim() && r.subject.trim())
      .map((r) => ({
        from: r.from.trim(),
        subject: r.subject.trim(),
        snippet: r.snippet.trim(),
        received_at: new Date().toISOString(),
      }));

    if (items.length === 0) {
      setErrorMessage('Add at least one email with a from address and subject.');
      setRunState('error');
      return;
    }

    setRunState('loading');
    setErrorMessage(null);
    setResults([]);
    try {
      const scored = await runSweep(items);
      setResults(scored);
      setRunState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Sweep failed.');
      setRunState('error');
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-medium text-text hover:text-accent"
      >
        {open ? '▾' : '▸'} Sweep now
      </button>
      <p className="mt-1 text-xs text-text-dim">
        No mailbox is connected yet (Phase 4 needs a mail-provider OAuth app) — paste
        in email summaries by hand for now. Each gets matched against the open pipeline;
        rejections log automatically, interview invites get surfaced for you to confirm.
      </p>

      {open && (
        <div className="mt-4 flex flex-col gap-4">
          <form onSubmit={handleRun} className="flex flex-col gap-3">
            {rows.map((row, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-border p-3">
                <input
                  value={row.from}
                  onChange={(e) => updateRow(i, { from: e.target.value })}
                  placeholder="From (e.g. recruiting@acme.com)"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={row.subject}
                  onChange={(e) => updateRow(i, { subject: e.target.value })}
                  placeholder="Subject"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <textarea
                  value={row.snippet}
                  onChange={(e) => updateRow(i, { snippet: e.target.value })}
                  rows={2}
                  placeholder="Snippet / body (optional but helps classification)"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="justify-self-start text-xs text-text-dim hover:text-danger"
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
                {runState === 'loading' ? 'Sweeping…' : 'Run sweep'}
              </button>
            </div>

            {runState === 'error' && errorMessage && <p className="text-sm text-danger">{errorMessage}</p>}
          </form>

          {results.length > 0 && (
            <div className="flex flex-col gap-2">
              {results.map((r, i) => (
                <div key={i} className="rounded-lg border border-border bg-bg p-3 text-sm">
                  <p className="font-medium text-text">
                    {r.item.subject}{' '}
                    <span className="font-normal text-text-dim">— {r.item.from}</span>
                  </p>
                  <p className="mt-1 text-xs text-text-dim">
                    {CLASSIFICATION_LABEL[r.classification]} · confidence {r.confidence}
                    {r.application_id ? ' · matched' : ' · no match'}
                  </p>
                  <p className="mt-1 text-xs text-text-dim">{r.reasoning}</p>
                  <p className="mt-1 text-xs text-accent">{r.error ? r.error : r.action}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
