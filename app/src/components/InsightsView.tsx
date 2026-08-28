import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  loadInsightsData,
  filterByDateRange,
  withinRange,
  computeReached,
  buildFunnel,
  buildKpis,
  buildStageConversion,
  buildRateBreakdown,
  buildDeathsByStage,
  clusterRejectionReasons,
  buildWeeklyVelocity,
  DATE_RANGES,
  GROUP_BYS,
  SORT_MODES,
  type InsightsData,
  type WeeklyVelocity,
} from '../lib/insights';
import { formatDate } from '../lib/dateUtils';
import {
  getInsightsPrefs,
  saveInsightsPrefs,
  getWhimsyLevel,
  DEFAULT_INSIGHTS_ORDER,
  type InsightsPrefs,
  type InsightsPanelId,
  type WhimsyLevel,
} from '../lib/settings';

type LoadState = 'loading' | 'ready' | 'error' | 'empty';

const PANEL_TITLES: Record<InsightsPanelId, string> = {
  kpis: 'At a glance',
  funnel: 'Funnel',
  conversion: 'Stage conversion',
  breakdown: 'Effectiveness',
  deaths: 'Deaths by stage',
  reasons: 'Rejection reasons',
  velocity: 'Weekly velocity',
  lessons: 'Lessons log',
};

/** Horizontal bar chart, inline SVG — no charting library. Bar width is proportional to the
 * row's share of the chart's own max, so small datasets still read clearly. */
function HBarChart({
  rows,
  color = 'var(--accent)',
  formatValue,
}: {
  rows: { label: string; value: number }[];
  color?: string;
  formatValue?: (v: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-40 shrink-0 truncate text-xs text-text-dim" title={r.label}>
            {r.label}
          </span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-surface-2">
            <div
              className="h-full rounded transition-all"
              style={{ width: `${(r.value / max) * 100}%`, backgroundColor: color }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-xs text-text-dim">
            {formatValue ? formatValue(r.value) : r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Simple SVG line chart for weekly velocity. */
function LineChart({ points }: { points: WeeklyVelocity[] }) {
  if (points.length === 0) return null;
  const width = 640;
  const height = 140;
  const padding = 24;
  const max = Math.max(1, ...points.map((p) => p.count));
  const stepX = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = padding + i * stepX;
    const y = height - padding - (p.count / max) * (height - padding * 2);
    return { x, y, ...p };
  });

  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Applications submitted per week">
      <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="var(--border)" strokeWidth={1} />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {coords.map((c) => (
        <circle key={c.weekStart} cx={c.x} cy={c.y} r={3} fill="var(--accent)" />
      ))}
      {coords.length > 0 && (
        <>
          <text x={coords[0].x} y={height - 6} fontSize={9} fill="var(--text-dim)" textAnchor="start">
            {formatDate(coords[0].weekStart)}
          </text>
          <text x={coords[coords.length - 1].x} y={height - 6} fontSize={9} fill="var(--text-dim)" textAnchor="end">
            {formatDate(coords[coords.length - 1].weekStart)}
          </text>
        </>
      )}
    </svg>
  );
}

function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-text">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-text-dim">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Small labelled <select> used across the control bar and panel headers. */
function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-dim">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const TOP_N_OPTIONS = [
  { id: '5', label: 'Top 5' },
  { id: '10', label: 'Top 10' },
  { id: '20', label: 'Top 20' },
  { id: '0', label: 'All' },
];

export default function InsightsView() {
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [data, setData] = useState<InsightsData>({ applications: [], lessons: [], events: [] });
  const [prefs, setPrefs] = useState<InsightsPrefs | null>(null);
  const [whimsy, setWhimsy] = useState<WhimsyLevel>('gentle');
  const [customizing, setCustomizing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [loaded, loadedPrefs, whimsyLevel] = await Promise.all([
          loadInsightsData(),
          getInsightsPrefs(),
          getWhimsyLevel(),
        ]);
        setData(loaded);
        setPrefs(loadedPrefs);
        setWhimsy(whimsyLevel);
        setState(loaded.applications.length === 0 ? 'empty' : 'ready');
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load insights.');
        setState('error');
      }
    })();
  }, []);

  /** Merge a prefs change into state and persist it (fire-and-forget — a failed save must
   * never revert the on-screen control). */
  function updatePrefs(patch: Partial<InsightsPrefs>) {
    setPrefs((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      saveInsightsPrefs(next).catch(() => {});
      return next;
    });
  }

  function movePanel(id: InsightsPanelId, dir: -1 | 1) {
    setPrefs((prev) => {
      if (!prev) return prev;
      const order = [...prev.order];
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return prev;
      [order[i], order[j]] = [order[j], order[i]];
      const next = { ...prev, order };
      saveInsightsPrefs(next).catch(() => {});
      return next;
    });
  }

  function togglePanel(id: InsightsPanelId) {
    setPrefs((prev) => {
      if (!prev) return prev;
      const hidden = prev.hidden.includes(id)
        ? prev.hidden.filter((h) => h !== id)
        : [...prev.hidden, id];
      const next = { ...prev, hidden };
      saveInsightsPrefs(next).catch(() => {});
      return next;
    });
  }

  // Everything downstream is derived from the raw data + the current prefs (range/groupBy/
  // sort/topN). Recomputed only when those change.
  const derived = useMemo(() => {
    if (!prefs) return null;
    const apps = filterByDateRange(data.applications, prefs.range);
    const lessons = data.lessons.filter((l) => withinRange(l.date, prefs.range));
    const reached = computeReached(apps, data.events, lessons);
    const topN = prefs.topN;
    const rankBars = (rows: { label: string; value: number }[]) => {
      const sorted = [...rows].sort((a, b) =>
        prefs.sort === 'name' ? a.label.localeCompare(b.label) : b.value - a.value
      );
      return topN > 0 ? sorted.slice(0, topN) : sorted;
    };
    return {
      apps,
      lessons,
      kpis: buildKpis(apps, reached, data.events),
      funnel: buildFunnel(apps),
      conversion: buildStageConversion(apps, reached),
      breakdown: buildRateBreakdown(apps, reached, prefs.groupBy, { sort: prefs.sort, topN }),
      deaths: buildDeathsByStage(apps, lessons),
      reasons: clusterRejectionReasons(lessons),
      velocity: buildWeeklyVelocity(apps),
      rankBars,
    };
  }, [data, prefs]);

  if (state === 'loading' || !prefs || !derived) {
    return <p className="text-sm text-text-dim">Loading insights…</p>;
  }

  if (state === 'error') {
    return (
      <div className="rounded-xl border border-danger/40 bg-surface p-6 text-sm text-danger">
        {errorMessage ?? 'Something went wrong loading insights.'}
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-surface px-6 py-16 text-center">
        <p className="text-2xl" aria-hidden="true">📊</p>
        <p className="mt-3 text-sm text-text-dim">
          Nothing to chart yet — once applications are logged, the KPIs, funnel, conversion,
          effectiveness, reasons, and pace will show up here.
        </p>
      </div>
    );
  }

  const groupByLabel = GROUP_BYS.find((g) => g.id === prefs.groupBy)?.label ?? 'Source';
  const inRange = prefs.range === 'all' ? '' : ' in range';

  // --- Panel renderers, keyed by id so the order/visibility prefs drive layout. ---
  const panels: Record<InsightsPanelId, ReactNode> = {
    kpis: (
      <Section
        key="kpis"
        title={PANEL_TITLES.kpis}
        subtitle={`Headline rates across ${derived.apps.filter((a) => a.status !== 'to_apply').length} applications${inRange || ' on file'}.`}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {derived.kpis.map((k) => (
            <div key={k.key} className="rounded-lg border border-border bg-bg p-3">
              <p className="text-2xl font-semibold text-text">{k.value}</p>
              <p className="mt-0.5 text-xs font-medium text-text">{k.label}</p>
              <p className="mt-0.5 text-[11px] leading-tight text-text-dim">{k.hint}</p>
            </div>
          ))}
        </div>
      </Section>
    ),
    funnel: (
      <Section
        key="funnel"
        title={PANEL_TITLES.funnel}
        subtitle={`Current distribution across ${derived.apps.length} applications${inRange || ' on file'}.`}
      >
        <HBarChart rows={derived.funnel.map((f) => ({ label: f.label, value: f.count }))} />
      </Section>
    ),
    conversion: (
      <Section
        key="conversion"
        title={PANEL_TITLES.conversion}
        subtitle="How many applications reached each stage, and the step-to-step conversion where the pipeline leaks."
      >
        {derived.conversion.counts[0]?.count === 0 ? (
          <p className="text-sm text-text-dim">No applications have reached the applied stage in range.</p>
        ) : (
          <>
            <HBarChart rows={derived.conversion.counts.map((c) => ({ label: c.label, value: c.count }))} />
            <div className="mt-4 flex flex-wrap gap-2">
              {derived.conversion.steps.map((s) => (
                <span
                  key={`${s.fromLabel}-${s.toLabel}`}
                  className="rounded-full border border-border bg-bg px-2.5 py-1 text-xs text-text-dim"
                >
                  {s.fromLabel} → {s.toLabel}:{' '}
                  <span className="font-medium text-text">{Math.round(s.rate * 100)}%</span>
                </span>
              ))}
            </div>
          </>
        )}
      </Section>
    ),
    breakdown: (
      <Section
        key="breakdown"
        title={`${PANEL_TITLES.breakdown} by ${groupByLabel.toLowerCase()}`}
        subtitle="Response rate (reached a phone screen or deeper) and win rate, grouped and ranked by your controls above."
        action={
          <Select
            label="Group by"
            value={prefs.groupBy}
            options={GROUP_BYS}
            onChange={(groupBy) => updatePrefs({ groupBy })}
          />
        }
      >
        {derived.breakdown.length === 0 ? (
          <p className="text-sm text-text-dim">No applied applications to group in range.</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {derived.breakdown.map((row) => (
              <div key={row.key} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-xs text-text-dim" title={row.label}>
                  {row.label}
                </span>
                <div className="h-4 flex-1 overflow-hidden rounded bg-surface-2" title={`${Math.round(row.responseRate * 100)}% response`}>
                  <div
                    className="h-full rounded bg-accent transition-all"
                    style={{ width: `${Math.max(2, row.responseRate * 100)}%` }}
                  />
                </div>
                <span className="w-40 shrink-0 text-right text-xs text-text-dim">
                  n={row.total} · {Math.round(row.responseRate * 100)}% resp
                  {row.won > 0 ? ` · ${Math.round(row.winRate * 100)}% win` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    ),
    deaths: (
      <Section
        key="deaths"
        title={PANEL_TITLES.deaths}
        subtitle="Where rejections concentrate, by the stage reached right before the rejection was logged."
      >
        {derived.deaths.stages.length === 0 ? (
          <p className="text-sm text-text-dim">No rejections logged with a stage on file in range.</p>
        ) : (
          <HBarChart
            rows={derived.rankBars(derived.deaths.stages.map((d) => ({ label: d.stage, value: d.count })))}
            color="var(--danger)"
          />
        )}
        <p className="mt-3 text-xs text-text-dim">
          Also on file: {derived.deaths.ghosted} ghosted, {derived.deaths.withdrawn} withdrawn (these
          don't carry a stage-reached reason today).
        </p>
      </Section>
    ),
    reasons: (
      <Section
        key="reasons"
        title={PANEL_TITLES.reasons}
        subtitle="Rough keyword grouping over the lessons log's stated reasons — not ML, just buckets."
      >
        {derived.reasons.length === 0 ? (
          <p className="text-sm text-text-dim">No rejection reasons logged in range.</p>
        ) : (
          <HBarChart
            rows={derived.rankBars(derived.reasons.map((r) => ({ label: r.bucket, value: r.count })))}
            color="var(--accent-2)"
          />
        )}
      </Section>
    ),
    velocity: (
      <Section
        key="velocity"
        title={PANEL_TITLES.velocity}
        subtitle="Applications submitted per week, from date applied."
      >
        {derived.velocity.length === 0 ? (
          <p className="text-sm text-text-dim">No dated applications in range.</p>
        ) : (
          <LineChart points={derived.velocity} />
        )}
      </Section>
    ),
    lessons: (
      <Section
        key="lessons"
        title={PANEL_TITLES.lessons}
        subtitle={
          whimsy === 'off'
            ? 'Every rejection logged, as evidence.'
            : 'The pattern library, one entry at a time — evidence, not just a list.'
        }
      >
        {derived.lessons.length === 0 ? (
          <p className="text-sm text-text-dim">Nothing logged in range.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {[...derived.lessons].reverse().map((l) => (
              <div key={l.id} className="rounded-lg border border-border bg-bg p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-text">
                    {l.company ?? 'Unknown company'} — {l.role ?? 'Untitled role'}
                  </p>
                  <p className="text-xs text-text-dim">{formatDate(l.date)}</p>
                </div>
                <p className="mt-1 text-xs text-text-dim">Reached: {l.stage_reached ?? '—'}</p>
                {l.stated_reason && <p className="mt-1 text-text">Stated: {l.stated_reason}</p>}
                {l.real_signal && <p className="mt-1 text-text-dim">Real signal: {l.real_signal}</p>}
                {l.adjustment && <p className="mt-1 text-text-dim">Adjustment: {l.adjustment}</p>}
              </div>
            ))}
          </div>
        )}
      </Section>
    ),
  };

  const visiblePanels = prefs.order.filter((id) => !prefs.hidden.includes(id));

  return (
    <div className="flex flex-col gap-6">
      {/* Global control bar — date range + ranking controls + customize toggle. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-border bg-surface p-4">
        <Select
          label="Range"
          value={prefs.range}
          options={DATE_RANGES}
          onChange={(range) => updatePrefs({ range })}
        />
        <Select
          label="Show"
          value={String(prefs.topN) as '0' | '5' | '10' | '20'}
          options={TOP_N_OPTIONS as { id: '0' | '5' | '10' | '20'; label: string }[]}
          onChange={(v) => updatePrefs({ topN: Number(v) })}
        />
        <Select label="Sort" value={prefs.sort} options={SORT_MODES} onChange={(sort) => updatePrefs({ sort })} />
        <button
          type="button"
          onClick={() => setCustomizing((c) => !c)}
          aria-expanded={customizing}
          className={`ml-auto rounded-lg border px-3 py-1.5 text-xs transition-colors ${
            customizing ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text hover:bg-surface-2'
          }`}
        >
          {customizing ? 'Done' : 'Customize panels'}
        </button>
      </div>

      {/* Customize panel: show/hide + reorder, persisted to settings. */}
      {customizing && (
        <div className="rounded-xl border border-accent/30 bg-surface p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-text">Panels</p>
            <button
              type="button"
              onClick={() => updatePrefs({ order: [...DEFAULT_INSIGHTS_ORDER], hidden: [] })}
              className="text-xs text-text-dim transition-colors hover:text-text"
            >
              Reset to default
            </button>
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            {prefs.order.map((id, i) => {
              const shown = !prefs.hidden.includes(id);
              return (
                <li key={id} className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-1.5">
                  <label className="flex flex-1 items-center gap-2 text-sm text-text">
                    <input type="checkbox" checked={shown} onChange={() => togglePanel(id)} className="accent-accent" />
                    <span className={shown ? '' : 'text-text-dim line-through'}>{PANEL_TITLES[id]}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => movePanel(id, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${PANEL_TITLES[id]} up`}
                    className="rounded px-1.5 py-0.5 text-text-dim transition-colors hover:text-text disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => movePanel(id, 1)}
                    disabled={i === prefs.order.length - 1}
                    aria-label={`Move ${PANEL_TITLES[id]} down`}
                    className="rounded px-1.5 py-0.5 text-text-dim transition-colors hover:text-text disabled:opacity-30"
                  >
                    ▼
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {visiblePanels.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface p-6 text-sm text-text-dim">
          Every panel is hidden. Open “Customize panels” to bring some back.
        </p>
      ) : (
        visiblePanels.map((id) => panels[id])
      )}
    </div>
  );
}
