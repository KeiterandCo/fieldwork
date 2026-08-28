import type { FwVerdict } from '../lib/types';

export interface VerdictCardData {
  verdict: FwVerdict;
  comp_min: number | null;
  comp_max: number | null;
  remote_type: string | null;
  location: string | null;
  pain_line: string | null;
  gaps: string[];
  reasoning: string;
  liveness_note?: string | null;
}

/** Color coding + copy per verdict. Per SPEC.md §7, whimsy never touches a "no" or
 * "soft_no" verdict — those two stay plain and factual, same border/bg treatment as any
 * other informational card, no cute copy, no icon. */
const VERDICT_META: Record<FwVerdict, { label: string; border: string; bg: string; text: string }> = {
  yes: { label: 'Yes', border: 'border-success/40', bg: 'bg-success/10', text: 'text-success' },
  soft_yes: { label: 'Soft yes', border: 'border-accent/40', bg: 'bg-accent/10', text: 'text-accent' },
  soft_no: { label: 'Soft no', border: 'border-border', bg: 'bg-surface', text: 'text-text-dim' },
  no: { label: 'No', border: 'border-danger/40', bg: 'bg-danger/10', text: 'text-danger' },
};

function formatComp(min: number | null, max: number | null): string {
  if (min == null && max == null) return 'Not stated';
  if (min != null && max != null) return `$${min.toLocaleString()} – $${max.toLocaleString()}`;
  return `$${(min ?? max ?? 0).toLocaleString()}+`;
}

interface Props {
  card: VerdictCardData;
  heading: string;
  subheading?: string;
  onFile?: () => void;
  onDiscard?: () => void;
  filing?: boolean;
  filed?: boolean;
  discarded?: boolean;
}

export default function VerdictCardView({
  card,
  heading,
  subheading,
  onFile,
  onDiscard,
  filing,
  filed,
  discarded,
}: Props) {
  const meta = VERDICT_META[card.verdict];

  return (
    <div className={`rounded-xl border ${meta.border} ${meta.bg} p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={`text-xs font-medium uppercase tracking-wide ${meta.text}`}>{meta.label}</p>
          <p className="mt-1 font-medium text-text">{heading}</p>
          {subheading && <p className="text-sm text-text-dim">{subheading}</p>}
        </div>
        {!filed && !discarded && (onFile || onDiscard) && (
          <div className="flex shrink-0 gap-2">
            {onDiscard && (
              <button
                type="button"
                onClick={onDiscard}
                disabled={filing}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-dim transition-colors hover:text-text disabled:opacity-50"
              >
                Discard
              </button>
            )}
            {onFile && (
              <button
                type="button"
                onClick={onFile}
                disabled={filing}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {filing ? 'Filing…' : 'File as to_apply'}
              </button>
            )}
          </div>
        )}
        {filed && <p className="shrink-0 text-xs font-medium text-success">Filed</p>}
        {discarded && <p className="shrink-0 text-xs text-text-dim">Discarded</p>}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-text-dim">Comp</dt>
          <dd className="text-text">{formatComp(card.comp_min, card.comp_max)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-text-dim">Remote</dt>
          <dd className="text-text">{card.remote_type ?? 'Not stated'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-text-dim">Location</dt>
          <dd className="text-text">{card.location ?? '—'}</dd>
        </div>
      </dl>

      {card.pain_line && <p className="mt-3 text-sm italic text-text-dim">"{card.pain_line}"</p>}

      {card.gaps.length > 0 && (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-text-dim">Gaps</p>
          <ul className="mt-1 list-inside list-disc text-sm text-text">
            {card.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}

      {card.reasoning && <p className="mt-3 whitespace-pre-wrap text-sm text-text">{card.reasoning}</p>}

      {card.liveness_note && <p className="mt-3 text-xs text-text-dim">Liveness check: {card.liveness_note}</p>}
    </div>
  );
}
