import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { getApplication, insertEvent, setStatus } from '../lib/applications';
import { listEvents, listJds, listContactsForApp, listPrepDocs, listDraftsForApp } from '../lib/dossier';
import { dateInputToDate, formatDate, localDateString } from '../lib/dateUtils';
import { STATUS_LABEL, STATUS_ORDER } from '../lib/pipeline';
import ResumeStudio from './ResumeStudio';
import PrepPanel from './PrepPanel';
import DraftPanel from './DraftPanel';
import HistoryPanel from './HistoryPanel';
import BuildProgress from './BuildProgress';
import { parseResumeEventBody } from '../lib/resume';
import {
  acknowledgeResumeBuild,
  RESUME_BUILD_STAGES,
  RESUME_BUILD_PHRASES,
  startResumeBuild,
  useResumeBuild,
} from '../lib/resumeBuildStore';
import type {
  FwApplication,
  FwContact,
  FwDraft,
  FwEvent,
  FwEventType,
  FwJd,
  FwPrepDoc,
  FwStatus,
} from '../lib/types';

type Tab = 'overview' | 'jd' | 'resume' | 'contacts' | 'prep' | 'history';
type LoadState = 'loading' | 'ready' | 'error' | 'not_found';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview / Timeline' },
  { key: 'jd', label: 'Job description' },
  { key: 'resume', label: 'Resume' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'prep', label: 'Prep' },
  { key: 'history', label: 'History' },
];

const EVENT_TYPES: FwEventType[] = [
  'applied',
  'screen',
  'round',
  'debrief',
  'rejection',
  'nudge',
  'thank_you',
  'note',
  'offer',
];

/** Event types that imply a pipeline stage: logging one auto-moves the application there,
 * FORWARD only (per fw_status enum order — a late-logged screen never downgrades a card
 * that's already interviewing). 'rejection' is deliberately absent: the Pipeline rejection
 * flow captures a stated reason for the lessons log, and a lessons-less rejected status
 * would defeat it. */
const EVENT_STATUS_TARGET: Partial<Record<FwEventType, FwStatus>> = {
  applied: 'applied',
  screen: 'phone_screen',
  round: 'interviewing',
  offer: 'offer',
};

interface Props {
  applicationId: string;
}

/** "$240k – $260k" style compensation label from the stored min/max. */
function formatComp(min: number | null, max: number | null): string | null {
  const fmt = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);
  if (min != null && max != null) return min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
  if (min != null) return `${fmt(min)}+`;
  if (max != null) return `up to ${fmt(max)}`;
  return null;
}

const VERDICT_LABEL: Record<string, string> = {
  yes: 'Yes',
  soft_yes: 'Soft yes',
  soft_no: 'Soft no',
  no: 'No',
};

export default function DossierTabs({ applicationId }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [jdExpanded, setJdExpanded] = useState<Record<string, boolean>>({});

  const [application, setApplication] = useState<FwApplication | null>(null);
  const [events, setEvents] = useState<FwEvent[]>([]);
  const [jds, setJds] = useState<FwJd[]>([]);
  const [contacts, setContacts] = useState<FwContact[]>([]);
  const [prepDocs, setPrepDocs] = useState<FwPrepDoc[]>([]);
  const [drafts, setDrafts] = useState<FwDraft[]>([]);

  const [logType, setLogType] = useState<FwEventType>('note');
  // Local calendar date — toISOString() would give the UTC date (tomorrow, in the evening).
  const [logDate, setLogDate] = useState(() => localDateString());
  const [logBody, setLogBody] = useState('');
  const [logging, setLogging] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [rejectionHint, setRejectionHint] = useState(false);
  const [showCoverLetterDraft, setShowCoverLetterDraft] = useState(false);

  // Application questions: poster-written free-text prompts on the application form.
  // Each question runs the standard draft flow (generate → edit → copy → saved fw_drafts
  // row) with the question passed as extra_context; repeat for as many questions as the
  // application has, each saving its own row.
  const [questionText, setQuestionText] = useState('');
  const [showQuestionDraft, setShowQuestionDraft] = useState(false);

  // The resume build lives in a module-level store so it survives tab switches. The header
  // button, the Resume tab, the cross-tab progress bar, and the "draft ready" toast all read
  // it. Starting a build here (not via a mount-time flag) means there is one build code path.
  const build = useResumeBuild(applicationId);

  function handleHeaderBuildResume() {
    if (build.phase === 'building') return;
    setTab('resume');
    startResumeBuild(applicationId);
  }

  const load = useCallback(async () => {
    setState('loading');
    try {
      const app = await getApplication(applicationId);
      if (!app) {
        setState('not_found');
        return;
      }
      const [ev, jd, ct, prep, dr] = await Promise.all([
        listEvents(applicationId),
        listJds(applicationId),
        listContactsForApp(applicationId),
        listPrepDocs(applicationId),
        listDraftsForApp(applicationId),
      ]);
      setApplication(app);
      setEvents(ev);
      setJds(jd);
      setContacts(ct);
      setPrepDocs(prep);
      setDrafts(dr);
      setState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load this dossier.');
      setState('error');
    }
  }, [applicationId]);

  /** Refetch just the events + drafts without the full loading state — used after a draft
   * panel closes so a newly generated cover letter / answer shows up in History and the
   * timeline immediately, without tearing down the whole dossier (which would close the
   * modal mid-flow). */
  const refreshQuietly = useCallback(async () => {
    try {
      const [ev, dr] = await Promise.all([listEvents(applicationId), listDraftsForApp(applicationId)]);
      setEvents(ev);
      setDrafts(dr);
    } catch {
      // Non-fatal — History refreshes on the next full load regardless.
    }
  }, [applicationId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleLogEvent(e: FormEvent) {
    e.preventDefault();
    setLogging(true);
    setLogError(null);
    setRejectionHint(false);
    try {
      // dateInputToDate: today keeps the current local time; other days anchor at local
      // noon, so "2026-07-13" never stores as UTC midnight (= JUL 12 evening local).
      await insertEvent(applicationId, logType, logBody || null, dateInputToDate(logDate));

      // Event-driven pipeline move: same setStatus path the Pipeline drag uses (status
      // update + status_change event), forward-only per the fw_status enum order.
      const target = application ? EVENT_STATUS_TARGET[logType] : undefined;
      if (
        application &&
        target &&
        STATUS_ORDER.indexOf(target) > STATUS_ORDER.indexOf(application.status)
      ) {
        await setStatus(applicationId, target, application.status);
      }
      if (logType === 'rejection') setRejectionHint(true);

      setLogBody('');
      await load();
    } catch (err) {
      setLogError(err instanceof Error ? err.message : 'Could not log that event.');
    } finally {
      setLogging(false);
    }
  }

  if (state === 'loading') {
    return <p className="text-sm text-text-dim">Loading dossier…</p>;
  }

  if (state === 'not_found') {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-sm text-text-dim">
        No application found with that id.
      </div>
    );
  }

  if (state === 'error' || !application) {
    return (
      <div className="rounded-xl border border-danger/40 bg-surface p-6 text-sm text-danger">
        {errorMessage ?? 'Something went wrong loading this dossier.'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-text-dim">
            {STATUS_LABEL[application.status as FwStatus] ?? application.status}
          </p>
          <h1 className="mt-1 text-xl font-semibold text-text">{application.company}</h1>
          <p className="text-sm text-text-dim">{application.title ?? 'Untitled role'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCoverLetterDraft(true)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-text transition-colors hover:bg-surface-2"
          >
            Draft cover letter
          </button>
          <button
            type="button"
            disabled={build.phase === 'building'}
            onClick={handleHeaderBuildResume}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {build.phase === 'building' ? 'Building…' : 'Build resume'}
          </button>
        </div>
      </div>

      <div className="flex gap-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t.key
                ? 'border-accent text-text'
                : 'border-transparent text-text-dim hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Cross-tab build indicator: the Resume tab renders its own bar, so this shows the
          same continuous progress everywhere else while a build runs in the background. */}
      {build.phase === 'building' && tab !== 'resume' && (
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="mb-2 text-xs uppercase tracking-wide text-text-dim">Building resume</p>
          <BuildProgress stages={RESUME_BUILD_STAGES} phrases={RESUME_BUILD_PHRASES} startedAt={build.startedAt} />
        </div>
      )}

      {tab === 'overview' && (
        <div className="flex flex-col gap-6">
          <form
            onSubmit={handleLogEvent}
            className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4"
          >
            <label className="flex flex-col gap-1 text-xs text-text-dim">
              Type
              <select
                value={logType}
                onChange={(e) => setLogType(e.target.value as FwEventType)}
                className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-dim">
              Date
              <input
                type="date"
                value={logDate}
                onChange={(e) => setLogDate(e.target.value)}
                className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-text-dim">
              Note
              <input
                value={logBody}
                onChange={(e) => setLogBody(e.target.value)}
                placeholder="Optional detail…"
                className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
            </label>
            <button
              type="submit"
              disabled={logging}
              className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {logging ? 'Logging…' : 'Log event'}
            </button>
            {logError && <p className="w-full text-sm text-danger">{logError}</p>}
            {rejectionHint && (
              <p className="w-full text-xs text-text-dim">
                Rejection logged. Drag the card to Rejected in the{' '}
                <a href="/pipeline" className="text-accent hover:underline">
                  Pipeline
                </a>{' '}
                to record the stated reason for the lessons log.
              </p>
            )}
          </form>

          <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
            <div>
              <h3 className="text-sm font-medium text-text">Application questions</h3>
              <p className="mt-0.5 text-xs text-text-dim">
                Paste a free-text question from the application form and draft an answer from
                your career record plus this role's context. Repeat for each question: every
                answer saves as its own draft.
              </p>
            </div>
            <p className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
              Every AI action reads the career record; nothing generated may exceed it. Review
              and edit the answer before pasting it into the application.
            </p>
            <textarea
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              rows={3}
              placeholder="Paste the application question…"
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={!questionText.trim()}
              onClick={() => setShowQuestionDraft(true)}
              className="self-start rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Draft answer
            </button>
          </section>

          {events.length === 0 ? (
            <p className="text-sm text-text-dim">No events logged yet for this application.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {events.map((ev) => {
                // Resume-export notes carry the full resume text as a snapshot; the timeline
                // stays terse and shows only the filename line (full text lives in History).
                const resumeSnapshot = parseResumeEventBody(ev.body);
                const displayBody = resumeSnapshot
                  ? `Resume built: ${resumeSnapshot.filename}`
                  : ev.body;
                return (
                  <li
                    key={ev.id}
                    className="rounded-lg border border-border bg-surface p-3 text-sm"
                  >
                    <p className="text-xs uppercase tracking-wide text-text-dim">
                      {formatDate(ev.occurred_at)} · {ev.type}
                    </p>
                    {displayBody && <p className="mt-1 text-text">{displayBody}</p>}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}

      {tab === 'jd' && (
        <div className="flex flex-col gap-4">
          {jds.length === 0 ? (
            <p className="text-sm text-text-dim">No JD on file for this application.</p>
          ) : (
            jds.map((jd) => (
              <div key={jd.id} className="rounded-xl border border-border bg-surface p-4">
                {/* Scannable facts grid — the chunk of raw JD text is collapsed below. */}
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-dim">Role title</dt>
                    <dd className="mt-0.5 text-sm text-text">{application?.title ?? 'Untitled role'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-dim">Comp</dt>
                    <dd className="mt-0.5 text-sm text-text">
                      {formatComp(application?.comp_min ?? null, application?.comp_max ?? null) ?? 'Not posted'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-dim">Location</dt>
                    <dd className="mt-0.5 text-sm capitalize text-text">
                      {application?.remote_type ?? 'Unknown'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-dim">Verdict</dt>
                    <dd className="mt-0.5 text-sm text-text">
                      {application?.verdict ? VERDICT_LABEL[application.verdict] ?? application.verdict : 'Not scored'}
                    </dd>
                  </div>
                  {jd.url && (
                    <div className="sm:col-span-2">
                      <dt className="text-xs uppercase tracking-wide text-text-dim">Posting</dt>
                      <dd className="mt-0.5">
                        <a
                          href={jd.url}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-sm text-accent hover:underline"
                        >
                          {jd.url}
                        </a>
                        {jd.live_checked_at && (
                          <span className="ml-2 text-xs text-text-dim">
                            checked {formatDate(jd.live_checked_at)}
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                </dl>

                {jd.pain_line && (
                  <div className="mt-4">
                    <p className="text-xs uppercase tracking-wide text-text-dim">Fit</p>
                    <p className="mt-1 text-sm italic text-text-dim">"{jd.pain_line}"</p>
                  </div>
                )}

                {Array.isArray(jd.gaps) && jd.gaps.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs uppercase tracking-wide text-text-dim">Gaps</p>
                    <ul className="mt-1 list-inside list-disc text-sm text-text">
                      {(jd.gaps as unknown[]).map((g, i) => (
                        <li key={i}>{String(g)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {jd.raw_text && (
                  <div className="mt-4 border-t border-border pt-3">
                    <button
                      type="button"
                      onClick={() => setJdExpanded((prev) => ({ ...prev, [jd.id]: !prev[jd.id] }))}
                      className="text-sm font-medium text-text hover:text-accent"
                    >
                      {jdExpanded[jd.id] ? '▾ Full job description' : '▸ Full job description'}
                    </button>
                    {jdExpanded[jd.id] && (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-text">{jd.raw_text}</p>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'resume' && <ResumeStudio application={application} onBuilt={load} />}

      {tab === 'contacts' && (
        <div className="flex flex-col gap-3">
          {contacts.length === 0 ? (
            <p className="text-sm text-text-dim">
              No contacts linked to this application yet.
            </p>
          ) : (
            contacts.map((c) => (
              <div key={c.id} className="rounded-xl border border-border bg-surface p-4 text-sm">
                <p className="font-medium text-text">{c.name}</p>
                <p className="text-text-dim">{c.role_title ?? '—'}</p>
                <p className="mt-1 text-xs text-text-dim capitalize">Warmth: {c.warmth}</p>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'prep' && (
        <PrepPanel applicationId={applicationId} prepDocs={prepDocs} onRefresh={load} />
      )}

      {tab === 'history' && (
        <HistoryPanel
          application={application}
          drafts={drafts}
          prepDocs={prepDocs}
          events={events}
          onOpenTab={setTab}
        />
      )}

      {showQuestionDraft && (
        <DraftPanel
          type="application_question"
          context={{ application_id: applicationId, extra_context: questionText.trim() }}
          subjectLabel={`Application question: ${application.company}`}
          bodyPrefix={`Q: ${questionText.trim()}\n\n`}
          onClose={() => {
            setShowQuestionDraft(false);
            setQuestionText('');
            refreshQuietly();
          }}
        />
      )}

      {showCoverLetterDraft && (
        <DraftPanel
          type="cover_letter"
          context={{ application_id: applicationId }}
          subjectLabel={`Cover letter — ${application.company}`}
          onClose={() => {
            setShowCoverLetterDraft(false);
            refreshQuietly();
          }}
        />
      )}

      {/* One-shot notification when a background build finishes and the user is elsewhere. On
          the Resume tab the review UI is already showing, so no toast is needed there. */}
      {build.phase === 'ready' && build.unseen && tab !== 'resume' && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-xl border border-accent/40 bg-surface px-4 py-3 shadow-lg"
        >
          <span aria-hidden="true" className="text-lg">📄</span>
          <div className="text-sm">
            <p className="font-medium text-text">Resume draft ready</p>
            <p className="text-xs text-text-dim">Built in the background.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              acknowledgeResumeBuild(applicationId);
              setTab('resume');
            }}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90"
          >
            View
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => acknowledgeResumeBuild(applicationId)}
            className="text-text-dim transition-colors hover:text-text"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
