import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { getTimingSettings, getWhimsyLevel, type WhimsyLevel } from '../lib/settings';
import { buildTodayQueue, type QueueItem } from '../lib/todayQueue';
import { markGhosted, snoozeNextAction } from '../lib/applications';
import DraftPanel from './DraftPanel';
import type { FwApplication, FwEvent } from '../lib/types';

type LoadState = 'loading' | 'ready' | 'error';

const KIND_LABEL: Record<QueueItem['kind'], string> = {
  thank_you: 'Thank-you',
  ghost: 'Gone quiet',
  nudge: 'Nudge',
  stale_to_apply: 'Still queued',
};

const KIND_ICON: Record<QueueItem['kind'], string> = {
  thank_you: '✉️',
  ghost: '👻',
  nudge: '🔔',
  stale_to_apply: '📥',
};

const GENTLE_EMPTY_LINES = [
  "Nothing's due. The pipeline is quiet in the good way.",
  'All caught up — nothing needs you right now.',
  'Queue is clear. Everything active is on schedule.',
];

function emptyStateCopy(whimsy: WhimsyLevel): string {
  if (whimsy === 'off') return 'Nothing is due right now.';
  // "gentle" and "full" both get warm-but-plain copy here — the spec is explicit that
  // whimsy never touches rejection-adjacent UI, and it stays understated even elsewhere.
  return GENTLE_EMPTY_LINES[0];
}

export default function TodayQueue() {
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [whimsy, setWhimsy] = useState<WhimsyLevel>('gentle');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draftFor, setDraftFor] = useState<{ application: FwApplication; type: 'nudge' | 'thank_you' } | null>(
    null
  );

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [appsRes, eventsRes, timing, whimsyLevel] = await Promise.all([
        supabase.from('fw_applications').select('*'),
        supabase.from('fw_events').select('*'),
        getTimingSettings(),
        getWhimsyLevel(),
      ]);
      if (appsRes.error) throw appsRes.error;
      if (eventsRes.error) throw eventsRes.error;

      const queue = buildTodayQueue(
        (appsRes.data ?? []) as FwApplication[],
        (eventsRes.data ?? []) as FwEvent[],
        timing
      );
      setItems(queue);
      setWhimsy(whimsyLevel);
      setState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load the queue.');
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleMarkGhosted(item: QueueItem) {
    setBusyId(item.application.id);
    try {
      await markGhosted(item.application);
      await load();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not update that application.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleSnooze(item: QueueItem, days: number) {
    setBusyId(item.application.id);
    try {
      await snoozeNextAction(item.application, days);
      await load();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not snooze that item.');
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'loading') {
    return <p className="text-sm text-text-dim">Loading today's queue…</p>;
  }

  if (state === 'error') {
    return (
      <div className="rounded-xl border border-danger/40 bg-surface p-6 text-sm text-danger">
        {errorMessage ?? 'Something went wrong loading the queue.'}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-surface px-6 py-16 text-center">
        <p className="text-2xl" aria-hidden="true">
          🌿
        </p>
        <p className="mt-3 text-sm text-text-dim">{emptyStateCopy(whimsy)}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div
          key={`${item.kind}-${item.application.id}`}
          className="flex items-start justify-between gap-4 rounded-xl border border-border bg-surface p-4"
        >
          <div className="flex gap-3">
            <span className="text-xl" aria-hidden="true">
              {KIND_ICON[item.kind]}
            </span>
            <div>
              <p className="text-xs uppercase tracking-wide text-text-dim">
                {KIND_LABEL[item.kind]}
              </p>
              <p className="mt-0.5 font-medium text-text">{item.headline}</p>
              <p className="mt-0.5 text-sm text-text-dim">{item.detail}</p>
              <a
                href={`/company?id=${item.application.id}`}
                className="mt-1 inline-block text-xs text-accent hover:underline"
              >
                Open dossier →
              </a>
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-2">
            {item.kind === 'ghost' && (
              <button
                type="button"
                disabled={busyId === item.application.id}
                onClick={() => handleMarkGhosted(item)}
                className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
              >
                Mark ghosted
              </button>
            )}
            {(item.kind === 'nudge' || item.kind === 'stale_to_apply') && (
              <button
                type="button"
                onClick={() => setDraftFor({ application: item.application, type: 'nudge' })}
                className="rounded-lg bg-accent px-3 py-1.5 text-center text-xs font-medium text-bg transition-opacity hover:opacity-90"
              >
                Draft nudge
              </button>
            )}
            {item.kind === 'thank_you' && (
              <button
                type="button"
                onClick={() => setDraftFor({ application: item.application, type: 'thank_you' })}
                className="rounded-lg bg-accent px-3 py-1.5 text-center text-xs font-medium text-bg transition-opacity hover:opacity-90"
              >
                Draft thank-you
              </button>
            )}
            <button
              type="button"
              disabled={busyId === item.application.id}
              onClick={() => handleSnooze(item, 3)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-dim transition-colors hover:text-text disabled:opacity-50"
            >
              Snooze 3d
            </button>
          </div>
        </div>
      ))}

      {draftFor && (
        <DraftPanel
          type={draftFor.type}
          context={{ application_id: draftFor.application.id }}
          subjectLabel={`${draftFor.application.company} — ${draftFor.application.title ?? 'Role'}`}
          onClose={() => setDraftFor(null)}
          onSent={load}
        />
      )}
    </div>
  );
}
