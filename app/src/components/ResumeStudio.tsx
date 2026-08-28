import { useEffect, useRef, useState } from 'react';
import {
  recordResumeBuilt,
  resolveFileName,
  saveResumeContent,
  type ResumeContent,
  type ResumeCertificationEntry,
} from '../lib/resume';
import {
  acknowledgeResumeBuild,
  getResumeBuildState,
  RESUME_BUILD_STAGES,
  RESUME_BUILD_PHRASES,
  startResumeBuild,
  useResumeBuild,
} from '../lib/resumeBuildStore';
import BuildProgress from './BuildProgress';
import {
  buildResumeDocx,
  downloadBlob,
  renderResumePrintHtml,
  resolveResumeStyle,
  RESUME_LAYOUTS,
  RESUME_COLORS,
  DEFAULT_RESUME_STYLE,
  type ResumeStyle,
  type ResumeLayoutId,
  type ResumeColorId,
} from '../lib/resumeDocx';
import { getResumeStyleSettings, upsertSetting } from '../lib/settings';
import { getProfile } from '../lib/profile';
import { parseListInput, formatListInput } from '../lib/profile';
import type { FwApplication } from '../lib/types';

interface Props {
  application: FwApplication;
  onBuilt?: () => void;
}

const emptyContent: ResumeContent = {
  contact: { name: null, email: null, phone: null, linkedin: null, location: null, other: null },
  summary: '',
  experience: [],
  skills: [],
  education: [],
  certifications: [],
};

export default function ResumeStudio({ application, onBuilt }: Props) {
  // The build lifecycle lives in the module-level store so it survives this component
  // unmounting on a dossier tab switch — the fetch keeps running and the result still lands.
  const build = useResumeBuild(application.id);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [content, setContent] = useState<ResumeContent>(emptyContent);
  const [atsKeywords, setAtsKeywords] = useState<string[]>([]);
  const [skillsInput, setSkillsInput] = useState('');
  // Whether we have a resume loaded into the editor (from a build or a past save).
  const [hasContent, setHasContent] = useState(false);
  const [downloadState, setDownloadState] = useState<'idle' | 'working' | 'done'>('idle');
  const [printState, setPrintState] = useState<'idle' | 'working'>('idle');
  const [style, setStyle] = useState<ResumeStyle>(DEFAULT_RESUME_STYLE);

  // Restore the last persisted build (fw_applications.resume_content) so a past resume can
  // be viewed, re-edited, and re-exported without regenerating. Skipped when the store is
  // already driving a build/ready state — that content wins and is pulled in below.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (getResumeBuildState(application.id).phase !== 'idle') return;
    const saved = application.resume_content;
    if (saved) {
      setContent(saved);
      setSkillsInput(formatListInput(saved.skills ?? []));
      setHasContent(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application.id]);

  // Pull a completed build into the editor exactly once per build. Runs on mount too, so
  // returning to the Resume tab after a build finished on another tab lands the fresh draft
  // (with a brief snap-to-100 on the progress bar first).
  const consumedBuildId = useRef(0);
  useEffect(() => {
    if (build.phase !== 'ready' || !build.content || build.buildId === consumedBuildId.current) {
      return;
    }
    consumedBuildId.current = build.buildId;
    const built = build.content;
    const ats = build.atsKeywords;
    const timer = window.setTimeout(() => {
      setContent(built);
      setAtsKeywords(ats);
      setSkillsInput(formatListInput(built.skills));
      setHasContent(true);
      acknowledgeResumeBuild(application.id);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [build, application.id]);

  // Restore the last-used layout+color from fw_settings (keys `resume_layout` /
  // `resume_color`, falling back to the legacy `resume_template` mapping for users who
  // saved a pick before the split); values are validated so stale/unknown ids silently
  // fall back to the default.
  useEffect(() => {
    let cancelled = false;
    getResumeStyleSettings()
      .then((raw) => {
        if (!cancelled) setStyle(resolveResumeStyle(raw));
      })
      .catch(() => {
        /* fall back to default style */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function selectLayout(layout: ResumeLayoutId) {
    setStyle((s) => ({ ...s, layout }));
    // Persist fire-and-forget — a failed save should never block the export flow.
    upsertSetting('resume_layout', layout).catch(() => {});
  }

  function selectColor(color: ResumeColorId) {
    setStyle((s) => ({ ...s, color }));
    upsertSetting('resume_color', color).catch(() => {});
  }

  function handleBuild() {
    setErrorMessage(null);
    // The store owns the build; the header button and the cross-tab indicator share it.
    startResumeBuild(application.id);
  }

  function updateContact(field: keyof ResumeContent['contact'], value: string) {
    setContent((c) => ({ ...c, contact: { ...c.contact, [field]: value || null } }));
  }

  function updateExperience(index: number, patch: Partial<ResumeContent['experience'][number]>) {
    setContent((c) => ({
      ...c,
      experience: c.experience.map((job, i) => (i === index ? { ...job, ...patch } : job)),
    }));
  }

  function removeExperience(index: number) {
    setContent((c) => ({ ...c, experience: c.experience.filter((_, i) => i !== index) }));
  }

  function addExperience() {
    setContent((c) => ({
      ...c,
      experience: [...c.experience, { title: '', company: '', dates: '', location: '', bullets: [] }],
    }));
  }

  function updateHighlightHeading(value: string) {
    setContent((c) => ({
      ...c,
      highlight: { heading: value, items: c.highlight?.items ?? [] },
    }));
  }

  function updateHighlightItem(index: number, patch: Partial<{ title: string; body: string }>) {
    setContent((c) => {
      if (!c.highlight) return c;
      return {
        ...c,
        highlight: {
          ...c.highlight,
          items: c.highlight.items.map((it, i) => (i === index ? { ...it, ...patch } : it)),
        },
      };
    });
  }

  function removeHighlightItem(index: number) {
    setContent((c) => {
      if (!c.highlight) return c;
      return { ...c, highlight: { ...c.highlight, items: c.highlight.items.filter((_, i) => i !== index) } };
    });
  }

  function addHighlightItem() {
    setContent((c) => ({
      ...c,
      highlight: {
        heading: c.highlight?.heading || 'Selected Impact',
        items: [...(c.highlight?.items ?? []), { title: '', body: '' }],
      },
    }));
  }

  function updateEducation(index: number, patch: Partial<ResumeContent['education'][number]>) {
    setContent((c) => ({
      ...c,
      education: c.education.map((ed, i) => (i === index ? { ...ed, ...patch } : ed)),
    }));
  }

  function removeEducation(index: number) {
    setContent((c) => ({ ...c, education: c.education.filter((_, i) => i !== index) }));
  }

  function addEducation() {
    setContent((c) => ({ ...c, education: [...c.education, { credential: '', institution: '', dates: '' }] }));
  }

  function updateCertification(index: number, patch: Partial<ResumeCertificationEntry>) {
    setContent((c) => ({
      ...c,
      certifications: (c.certifications ?? []).map((cert, i) => (i === index ? { ...cert, ...patch } : cert)),
    }));
  }

  function removeCertification(index: number) {
    setContent((c) => ({ ...c, certifications: (c.certifications ?? []).filter((_, i) => i !== index) }));
  }

  function addCertification() {
    setContent((c) => ({
      ...c,
      certifications: [...(c.certifications ?? []), { name: '', issuer: null, date: null }],
    }));
  }

  function currentContent(): ResumeContent {
    return { ...content, skills: parseListInput(skillsInput) };
  }

  // Signature of the last export we logged to the timeline, so repeated exports of an
  // unchanged resume (e.g. re-opening the print dialog) don't spam duplicate snapshot events.
  const lastRecordedSig = useRef<string | null>(null);
  async function recordExport(filename: string, finalContent: ResumeContent): Promise<void> {
    const sig = `${filename} ${JSON.stringify(finalContent)}`;
    if (sig === lastRecordedSig.current) {
      // Same content already snapshotted — just keep the row's copy current, no new entry.
      saveResumeContent(application.id, finalContent).catch(() => {});
      return;
    }
    lastRecordedSig.current = sig;
    await recordResumeBuilt(application.id, filename, finalContent);
  }

  async function handleDownload() {
    setDownloadState('working');
    setErrorMessage(null);
    try {
      const finalContent = currentContent();
      const profile = await getProfile();
      const filename = resolveFileName(profile?.file_name_pattern, application, finalContent.contact.name);
      const blob = await buildResumeDocx(finalContent, style);
      downloadBlob(blob, filename);
      await recordExport(filename, finalContent);
      setDownloadState('done');
      onBuilt?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not build the .docx file.');
      setDownloadState('idle');
    }
  }

  function handlePrint() {
    setPrintState('working');
    const finalContent = currentContent();
    // Give React a tick to paint #resume-print-root before invoking the print dialog.
    setTimeout(() => {
      window.print();
      setPrintState('idle');
      // Log the snapshot AFTER printing so the timeline keeps this exported version too — the
      // text, never the document. Not gated on the dialog's outcome (the browser doesn't tell
      // us), and deliberately no onBuilt reload so the print root can't unmount mid-print.
      void recordExport(printFileName(finalContent), finalContent);
    }, 50);
  }

  /** Filename label for a Print / Save PDF export — same pattern as the .docx path but .pdf. */
  function printFileName(finalContent: ResumeContent): string {
    const base = resolveFileName(
      undefined,
      application,
      finalContent.contact.name
    ).replace(/\.docx$/i, '');
    return `${base}.pdf`;
  }

  const buildError = build.phase === 'error' ? build.error : null;
  const showBuilding = build.phase === 'building' || (build.phase === 'ready' && !hasContent);

  if (showBuilding || !hasContent) {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-sm">
        {application.resume_filename && (
          <p className="mb-3 text-text">
            Last built: <span className="font-medium">{application.resume_filename}</span>
          </p>
        )}
        {(errorMessage || buildError) && (
          <p className="mb-3 text-danger">{errorMessage ?? buildError}</p>
        )}
        {showBuilding ? (
          <BuildProgress
            stages={RESUME_BUILD_STAGES}
            phrases={RESUME_BUILD_PHRASES}
            done={build.phase === 'ready'}
            startedAt={build.startedAt}
          />
        ) : (
          <button
            type="button"
            onClick={handleBuild}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Build resume
          </button>
        )}
      </div>
    );
  }

  const finalContent = currentContent();

  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
        Every AI action reads the career record; nothing generated may exceed it. Review and
        edit everything below before exporting.
      </p>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text">Contact</h3>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['name', 'email', 'phone', 'linkedin', 'location', 'other'] as const).map((field) => (
            <label key={field} className="flex flex-col gap-1 text-xs capitalize text-text-dim">
              {field}
              <input
                value={content.contact[field] ?? ''}
                onChange={(e) => updateContact(field, e.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text">Summary</h3>
        <textarea
          value={content.summary}
          onChange={(e) => setContent((c) => ({ ...c, summary: e.target.value }))}
          rows={4}
          className="mt-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">Experience</h3>
          <button
            type="button"
            onClick={addExperience}
            className="text-xs text-accent hover:underline"
          >
            + Add entry
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-4">
          {content.experience.map((job, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  value={job.title}
                  onChange={(e) => updateExperience(i, { title: e.target.value })}
                  placeholder="Title"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={job.company}
                  onChange={(e) => updateExperience(i, { company: e.target.value })}
                  placeholder="Company"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={job.dates}
                  onChange={(e) => updateExperience(i, { dates: e.target.value })}
                  placeholder="Dates"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={job.location ?? ''}
                  onChange={(e) => updateExperience(i, { location: e.target.value })}
                  placeholder="Location"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
              </div>
              <label className="mt-2 flex flex-col gap-1 text-xs text-text-dim">
                Bullets (one per line)
                <textarea
                  value={job.bullets.join('\n')}
                  onChange={(e) => updateExperience(i, { bullets: e.target.value.split('\n') })}
                  rows={Math.max(3, job.bullets.length)}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
              <button
                type="button"
                onClick={() => removeExperience(i)}
                className="mt-2 text-xs text-danger hover:underline"
              >
                Remove entry
              </button>
            </div>
          ))}
          {content.experience.length === 0 && (
            <p className="text-sm text-text-dim">No experience entries — add one above.</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">Highlights</h3>
          <button
            type="button"
            onClick={addHighlightItem}
            className="text-xs text-accent hover:underline"
          >
            + Add item
          </button>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs text-text-dim">
          Section heading (e.g. Selected Impact, Flagship Products)
          <input
            value={content.highlight?.heading ?? ''}
            onChange={(e) => updateHighlightHeading(e.target.value)}
            placeholder="Selected Impact"
            className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <div className="mt-3 flex flex-col gap-3">
          {(content.highlight?.items ?? []).map((item, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <input
                value={item.title}
                onChange={(e) => updateHighlightItem(i, { title: e.target.value })}
                placeholder="Title (product, initiative, win)"
                className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <textarea
                value={item.body}
                onChange={(e) => updateHighlightItem(i, { body: e.target.value })}
                placeholder="1-2 sentences, from the career record"
                rows={2}
                className="mt-2 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => removeHighlightItem(i)}
                className="mt-2 text-xs text-danger hover:underline"
              >
                Remove item
              </button>
            </div>
          ))}
          {(content.highlight?.items ?? []).length === 0 && (
            <p className="text-sm text-text-dim">No highlight items — add one above.</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text">Skills (comma separated)</h3>
        <input
          value={skillsInput}
          onChange={(e) => setSkillsInput(e.target.value)}
          className="mt-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">Education</h3>
          <button type="button" onClick={addEducation} className="text-xs text-accent hover:underline">
            + Add entry
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-3">
          {content.education.map((ed, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-3">
              <input
                value={ed.credential}
                onChange={(e) => updateEducation(i, { credential: e.target.value })}
                placeholder="Credential"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <input
                value={ed.institution ?? ''}
                onChange={(e) => updateEducation(i, { institution: e.target.value })}
                placeholder="Institution"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <input
                  value={ed.dates ?? ''}
                  onChange={(e) => updateEducation(i, { dates: e.target.value })}
                  placeholder="Dates"
                  className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <button type="button" onClick={() => removeEducation(i)} className="shrink-0 text-xs text-danger hover:underline">
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">Certifications &amp; Clearance</h3>
          <button type="button" onClick={addCertification} className="text-xs text-accent hover:underline">
            + Add entry
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-3">
          {(content.certifications ?? []).map((cert, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-3">
              <input
                value={cert.name}
                onChange={(e) => updateCertification(i, { name: e.target.value })}
                placeholder="Credential (e.g. TS/SCI, AI-900)"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <input
                value={cert.issuer ?? ''}
                onChange={(e) => updateCertification(i, { issuer: e.target.value || null })}
                placeholder="Issuer / detail"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <input
                  value={cert.date ?? ''}
                  onChange={(e) => updateCertification(i, { date: e.target.value || null })}
                  placeholder="Date"
                  className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <button type="button" onClick={() => removeCertification(i)} className="shrink-0 text-xs text-danger hover:underline">
                  Remove
                </button>
              </div>
            </div>
          ))}
          {(content.certifications ?? []).length === 0 && (
            <p className="text-sm text-text-dim">No certifications — add one above (or rebuild from the record).</p>
          )}
        </div>
      </section>

      {atsKeywords.length > 0 && (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h3 className="text-sm font-medium text-text">ATS keywords matched</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {atsKeywords.map((k) => (
              <span key={k} className="rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-text-dim">
                {k}
              </span>
            ))}
          </div>
        </section>
      )}

      {(errorMessage || buildError) && (
        <p className="text-sm text-danger">{errorMessage ?? buildError}</p>
      )}

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text">Layout</h3>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {RESUME_LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              onClick={() => selectLayout(layout.id)}
              aria-pressed={style.layout === layout.id}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                style.layout === layout.id
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:bg-surface-2'
              }`}
            >
              <span className={`block text-sm font-medium ${style.layout === layout.id ? 'text-accent' : 'text-text'}`}>
                {layout.label}
              </span>
              <span className="block text-xs text-text-dim">{layout.description}</span>
            </button>
          ))}
        </div>
        <h3 className="mt-4 text-sm font-medium text-text">Color</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {RESUME_COLORS.map((color) => (
            <button
              key={color.id}
              type="button"
              onClick={() => selectColor(color.id)}
              aria-pressed={style.color === color.id}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                style.color === color.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text hover:bg-surface-2'
              }`}
            >
              <span
                aria-hidden="true"
                className="h-4 w-4 rounded-full border border-black/10"
                style={{ backgroundColor: `#${color.accent}` }}
              />
              {color.label}
            </button>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={downloadState === 'working'}
          onClick={handleDownload}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {downloadState === 'working' ? 'Building…' : 'Download .docx'}
        </button>
        <button
          type="button"
          onClick={handlePrint}
          className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:bg-surface-2"
        >
          Print / Save PDF
        </button>
        <button
          type="button"
          onClick={handleBuild}
          className="rounded-lg border border-border px-4 py-2 text-sm text-text-dim transition-colors hover:text-text"
        >
          Rebuild from record
        </button>
        {downloadState === 'done' && <span className="text-sm text-success">Downloaded.</span>}
      </div>

      {/* Hidden except in print media — see #resume-print-root rules in global.css. */}
      <div dangerouslySetInnerHTML={{ __html: renderResumePrintHtml(finalContent, style) }} />
    </div>
  );
}
