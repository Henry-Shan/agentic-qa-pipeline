"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import { useLive } from "@/lib/use-live";
import { useDisplayName } from "@/lib/display-names";
import {
  guardReport,
  REPORT_GONE_MESSAGE,
  REPORT_GONE_REDIRECT_MS,
} from "@/lib/report-gone";
import type { QaEvent, QaExamination, QaReport, QaRun } from "@/lib/types";
import { StatusPill } from "@/components/status-pill";
import { Pipeline } from "@/components/pipeline";
import { ConfirmDestroy, TrashIcon } from "@/components/confirm-delete";
import { ReportContext } from "@/components/task/report-context";
import { GroundingChips } from "@/components/task/grounding-chips";
import { ExaminationCard } from "@/components/task/examination-card";
import { NeedsHumanCard } from "@/components/task/needs-human-card";
import { EventLog } from "@/components/task/event-log";
import { HeroTabs, type HeroTab } from "@/components/task/hero-tabs";
import { PreviewEmbed } from "@/components/task/preview-embed";
import { ReplayPlayer } from "@/components/task/replay-player";
import { ResultCard } from "@/components/task/result-card";
import { RerunTask } from "@/components/task/rerun-task";
import { SteerBox } from "@/components/task/steer-box";
import { TerminalPanel } from "@/components/task/terminal-panel";
import { CopySession } from "@/components/task/copy-session";

interface Props {
  initialReport: QaReport;
  initialRun: QaRun | null;
  initialEvents: QaEvent[];
  initialExamination?: QaExamination | null;
  userEmail: string;
}

export function TaskView({
  initialReport,
  initialRun,
  initialEvents,
  initialExamination = null,
  userEmail,
}: Props) {
  const router = useRouter();
  const [report, setReport] = useState<QaReport>(initialReport);
  const [run, setRun] = useState<QaRun | null>(initialRun);
  const [events, setEvents] = useState<QaEvent[]>(initialEvents);
  const [examination, setExamination] = useState<QaExamination | null>(
    initialExamination,
  );
  const [confirmingDestroy, setConfirmingDestroy] = useState(false);
  const [destroyBusy, setDestroyBusy] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);
  // The report row was hard-deleted (by this tab or another) — every write on
  // this page would now fail its FK, so the page retires itself and goes home.
  const [gone, setGone] = useState(false);
  // Optimistic reveal of the "After the fix" tab: the upload finishes before
  // realtime delivers the qa_runs row, and re-running the replay overwrites the
  // same path (so the version bump is what forces the player to re-fetch).
  const [afterSavedRunId, setAfterSavedRunId] = useState<number | null>(null);
  const [afterVersion, setAfterVersion] = useState(0);
  // Re-watch the steps execute live even though a recording already exists.
  const [rerunLive, setRerunLive] = useState(false);
  const reporter = useDisplayName(report.reporter_email);
  const reportId = initialReport.id;
  const previewLive = run?.preview_status === "live";
  // A task's https preview address is permanent: the dev server behind it sleeps
  // (worker restart, MAX_PREVIEWS eviction) but the link keeps working — the
  // worker's wake service boots it on the next request. So the link is offered
  // whenever the task has one, live or not. A localhost URL is only useful on the
  // worker's own machine, so it is shown only while it is actually up.
  const previewUrl = run?.preview_url?.startsWith("https://")
    ? run.preview_url
    : previewLive
      ? (run?.preview_url ?? null)
      : null;
  // The interactive embed still waits for a server that is genuinely up — there
  // is NO offline placeholder (contracts § Task page layout).
  const livePreviewUrl = previewLive ? previewUrl : null;
  // rrweb recording filed with the report = "Before (the report)".
  const hasBefore = Boolean(report.replay_path);
  // The latest run's after-the-fix recording, saved or just uploaded here.
  const hasAfter =
    Boolean(run?.after_replay_path) ||
    (run !== null && afterSavedRunId === run.id);

  // Blocked → prominent amber card above the log carrying the assignment and,
  // when the worker has written one, the needs_human hand-off (contracts
  // § Needs-a-human). Latest such event wins (events are id-sorted).
  const blocked = report.status === "blocked";
  let needsHuman: QaEvent | null = null;
  if (blocked) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event && event.type === "needs_human") {
        needsHuman = event;
        break;
      }
    }
  }

  // "Delete everything": queue a `destroy` message (the worker tears down the
  // run, PR, worktree, and row) and cancel the report. Supabase returns errors
  // as values, not throws — BOTH writes must be checked or failures vanish
  // silently, and a report already deleted underneath us reads as "gone"
  // rather than an error (the outcome the user wanted anyway). On success we
  // navigate home immediately (the worker cleanup continues in the
  // background); on failure the button re-enables and the error shows below.
  async function destroyEverything() {
    if (destroyBusy) return;
    setDestroyBusy(true);
    setDestroyError(null);
    setConfirmingDestroy(false);
    const supabase = getBrowserClient();
    const queued = await guardReport(() =>
      supabase
        .from("qa_messages")
        .insert({
          report_id: reportId,
          kind: "destroy",
          author_email: userEmail,
          body: "",
        }),
    );
    if (queued.status === "gone") {
      router.replace("/");
      return;
    }
    if (queued.status === "error") {
      setDestroyBusy(false);
      setDestroyError(`Delete failed — ${queued.message}`);
      return;
    }
    const cancelled = await guardReport(
      () =>
        supabase
          .from("qa_reports")
          .update({ status: "cancelled" })
          .eq("id", reportId)
          .select("id")
          .maybeSingle(),
      { requireRow: true },
    );
    if (cancelled.status === "error") {
      setDestroyBusy(false);
      setDestroyError(`Delete failed — ${cancelled.message}`);
      return;
    }
    // Keep the button in its "Deleting…" state while the router swaps pages.
    router.replace("/");
  }

  const refetch = useCallback(async () => {
    const supabase = getBrowserClient();
    const [reportRes, runRes, eventsRes] = await Promise.all([
      supabase.from("qa_reports").select("*").eq("id", reportId).maybeSingle(),
      supabase
        .from("qa_runs")
        .select("*")
        .eq("report_id", reportId)
        .order("id", { ascending: false })
        .limit(1),
      supabase
        .from("qa_events")
        .select("*")
        .eq("report_id", reportId)
        .order("id", { ascending: false })
        .limit(500),
    ]);
    // maybeSingle(): no row AND no error means the report was deleted.
    if (reportRes.data) setReport(reportRes.data as QaReport);
    else if (!reportRes.error) setGone(true);
    const latestRun = (runRes.data ?? [])[0] as QaRun | undefined;
    if (latestRun) setRun(latestRun);
    if (eventsRes.data)
      setEvents((eventsRes.data as QaEvent[]).slice().reverse());
  }, [reportId]);

  // Realtime carries most updates, but the moments that reveal the tabs — the
  // preview coming up, the after-recording landing — are exactly when a missed
  // event costs a manual refresh. While work is in flight, poll as a floor.
  const inFlight =
    report.status === "running" ||
    report.status === "rework" ||
    report.status === "pr_ready" ||
    report.status === "preview";
  useEffect(() => {
    if (!inFlight) return;
    const id = window.setInterval(() => void refetch(), 8_000);
    return () => window.clearInterval(id);
  }, [inFlight, refetch]);

  useLive(
    `qa-task-${reportId}`,
    [
      { table: "qa_reports", filter: `id=eq.${reportId}` },
      { table: "qa_runs", filter: `report_id=eq.${reportId}` },
      { table: "qa_events", filter: `report_id=eq.${reportId}` },
      { table: "qa_examinations", filter: `report_id=eq.${reportId}` },
    ],
    (table, row) => {
      if (table === "qa_reports") {
        setReport(row as unknown as QaReport);
      } else if (table === "qa_examinations") {
        // Newest examination wins — a rework produces another one.
        const next = row as unknown as QaExamination;
        setExamination((prev) => (prev && prev.id > next.id ? prev : next));
      } else if (table === "qa_runs") {
        const next = row as unknown as QaRun;
        setRun((prev) => (prev && prev.id > next.id ? prev : next));
      } else {
        const event = row as unknown as QaEvent;
        setEvents((prev) =>
          prev.some((e) => e.id === event.id)
            ? prev
            : [...prev, event].sort((a, b) => a.id - b.id),
        );
      }
    },
    () => void refetch(),
    // The worker hard-deletes the report at the end of a destroy — retire the
    // page instead of leaving one whose every button fails its FK.
    (table, oldRow) => {
      if (table === "qa_reports" && Number(oldRow.id) === reportId)
        setGone(true);
    },
  );

  // Deleted report: say so quietly, then hand the user back to the board.
  useEffect(() => {
    if (!gone) return;
    const timer = setTimeout(
      () => router.replace("/"),
      REPORT_GONE_REDIRECT_MS,
    );
    return () => clearTimeout(timer);
  }, [gone, router]);

  if (gone) {
    return (
      <div className="card py-10 text-center">
        <p className="text-[13px] font-semibold">{REPORT_GONE_MESSAGE}</p>
        <p className="mt-1 text-[12.5px] text-ink-3">
          Taking you back to the board…
        </p>
        <Link
          href="/"
          className="mt-3 inline-block text-[12.5px] font-semibold text-qa hover:underline"
        >
          ← All reports
        </Link>
      </div>
    );
  }

  // Two tabs only: what the tester saw, and the same actions re-taken on the
  // fixed build. The live preview is a LINK, not a tab — you go there to poke
  // at the app yourself, which is a different job from watching the fix work.
  //
  // "After the fix" has two forms of the same thing. Before a recording exists
  // it embeds the preview, which re-executes the tester's steps live (you watch
  // the actions being taken and see the result) and records them as it goes;
  // once that recording exists it plays back, with a link to run it again.
  const canReplayLive = Boolean(livePreviewUrl);
  const showLiveRerun = canReplayLive && (!hasAfter || rerunLive);

  const heroTabs: HeroTab[] = [];
  if (hasBefore) {
    heroTabs.push({
      id: "before",
      label: "Before",
      // `steps` is only a FALLBACK: recordings made before the qa-step markers
      // existed get their marks derived from the report's own click_trail.
      content: (
        <ReplayPlayer
          reportId={reportId}
          label="before · what the tester saw"
          steps={report.click_trail ?? []}
        />
      ),
    });
  }
  if (hasAfter || canReplayLive) {
    heroTabs.push({
      id: "after",
      label: "After the fix",
      eager: showLiveRerun,
      content: showLiveRerun ? (
        <div className="flex flex-col gap-2">
          <PreviewEmbed
            key={livePreviewUrl ?? "preview"}
            previewUrl={livePreviewUrl ?? ""}
            report={report}
            runId={run?.id ?? null}
            onAfterReplay={() => {
              setAfterSavedRunId(run?.id ?? null);
              setAfterVersion((v) => v + 1);
              setRerunLive(false);
            }}
          />
          <p className="px-1 text-[12px] text-ink-3">
            Your steps are being re-taken on the fixed build — watch the result.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <ReplayPlayer
            key={`after-${run?.id ?? 0}-${afterVersion}`}
            reportId={reportId}
            src="after"
            label="after the fix · your steps, re-taken on the fixed build"
          />
          {canReplayLive ? (
            <button
              type="button"
              onClick={() => setRerunLive(true)}
              className="self-start px-1 text-[12px] font-medium text-qa hover:underline"
            >
              Run it again on the fixed build
            </button>
          ) : null}
        </div>
      ),
    });
  }
  const heroDefault = hasBefore ? "before" : (heroTabs[0]?.id ?? "");

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-3">
          <Link href="/" className="text-[13px] font-semibold text-qa">
            ← All reports
          </Link>
          {previewUrl ? (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={
                previewLive
                  ? "The fixed build for this task, at its own permanent address"
                  : "This preview is asleep — opening it starts it back up, which takes about a minute"
              }
              className="btn"
            >
              {previewLive ? "Open live preview ↗" : "Start preview ↗"}
            </a>
          ) : null}
        </span>
        <span className="font-mono text-[11.5px] text-ink-3">
          task #{report.id}
          {report.reporter_email ? (
            <>
              {" · "}
              <span title={report.reporter_email}>filed by {reporter}</span>
            </>
          ) : null}
          {report.assignee ? (
            <>
              {" · "}
              <span
                className="font-semibold text-qa"
                title={`Assigned to ${report.assignee}`}
              >
                assigned · {report.assignee}
              </span>
            </>
          ) : null}
          {run?.branch ? ` · branch ${run.branch}` : ""}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 text-base font-semibold">{report.title}</h1>
        <StatusPill
          status={report.status}
          runStatus={run?.status}
          previewStatus={run?.preview_status}
          previewUrl={run?.preview_url}
        />
      </div>
      <Pipeline status={report.status} detail />

      <ReportContext report={report} />

      {/* Hero — full content width, top-center, a segmented switch over
          [Before (the report) | After the fix | Live preview]
          (contracts § Task page layout). Each tab appears only when its content
          exists; with nothing to show there is NO hero and no offline
          placeholder. Live preview is mounted eagerly so its auto-replay — and
          therefore the after-the-fix capture — runs even when "Before" leads. */}
      {/* Reached the preview stage with no address anyone can open. Say so plainly
          and offer the way out, instead of a page that simply lacks a button. */}
      {report.status === "preview" && !previewUrl ? (
        <div className="mt-5 rounded-lg border border-line bg-paper-2 px-4 py-3">
          <div className="text-[13px] font-semibold">
            Can't load the preview
          </div>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            This task has no preview address that works from here — the build
            never came up, or it only ever existed on the machine that produced
            it.
          </p>
          <div className="mt-2.5">
            <RerunTask reportId={report.id} />
          </div>
        </div>
      ) : null}

      {heroTabs.length > 0 ? (
        <div className="mt-5">
          <HeroTabs tabs={heroTabs} defaultTab={heroDefault} />
        </div>
      ) : (
        // Silence here reads as a broken page — people look for the Before/After
        // toggle and find nothing. Say why there is nothing to show.
        <div className="mt-5 rounded-lg border border-line bg-paper-2 px-4 py-3 text-[12.5px] text-ink-3">
          <span className="font-semibold text-ink-2">
            No replay for this task.
          </span>{" "}
          {hasBefore || hasAfter
            ? "The recording is still uploading — reload in a moment."
            : "It was filed without a recording, so there are no steps to replay. Use Start recording in the 🐛 widget before reproducing a bug and the Before/After tabs appear here."}
        </div>
      )}

      <div className="mt-5 grid gap-5 md:grid-cols-[3fr_2fr]">
        <div className="min-w-0">
          {blocked ? (
            <NeedsHumanCard report={report} event={needsHuman} />
          ) : null}
          {examination ? <ExaminationCard exam={examination} /> : null}
          {run?.grounding?.length ? (
            <>
              <div className="cap-label">
                How Claude located it — full-stack trace
              </div>
              <GroundingChips chips={run.grounding} />
            </>
          ) : null}
          <div className="cap-label mt-4">Claude&apos;s log</div>
          <EventLog events={events} />
        </div>

        <div className="min-w-0">
          <div className="cap-label">Result</div>
          <ResultCard run={run} />
          <div className="cap-label mt-4">Terminal</div>
          <TerminalPanel reportId={reportId} />

          <div className="mb-1.5 mt-4 flex flex-wrap items-center justify-between gap-2">
            <div className="cap-label mb-0">Talk to Claude — anytime</div>
            {run ? <CopySession sessionId={run.session_id} /> : null}
          </div>
          <SteerBox
            reportId={report.id}
            status={report.status}
            assignee={report.assignee}
            userEmail={userEmail}
            onReportGone={() => setGone(true)}
          />

          <div className="relative mt-5">
            <button
              onClick={() => setConfirmingDestroy((v) => !v)}
              disabled={destroyBusy}
              aria-busy={destroyBusy}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red/40 bg-stage px-3.5 py-2 text-[12.5px] font-semibold text-red transition-colors hover:bg-red-soft disabled:opacity-50"
            >
              {destroyBusy ? (
                <>
                  <span className="spinner" aria-hidden />
                  Deleting…
                </>
              ) : (
                <>
                  <TrashIcon size={13} />
                  Delete everything
                </>
              )}
            </button>
            {destroyError ? (
              <p
                role="alert"
                className="mt-1.5 text-[11.5px] font-medium leading-[1.45] text-red"
              >
                {destroyError}
              </p>
            ) : null}
            {confirmingDestroy ? (
              <ConfirmDestroy
                className="absolute bottom-full right-0 z-20 mb-2 w-[250px]"
                busy={destroyBusy}
                onConfirm={() => void destroyEverything()}
                onCancel={() => setConfirmingDestroy(false)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
