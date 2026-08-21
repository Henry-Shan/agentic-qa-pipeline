"use client";

// Send a task back to the worker (contracts §Claim).
//
// Setting the report to `queued` is the whole mechanism — the claim loop takes
// the oldest queued report, so the next poll picks this up and produces a fresh
// run, worktree, branch and preview.
//
// This is deliberately two-click. A re-run spends a real Claude run and opens
// another PR, so it must not be something you can do by brushing past a button
// while looking for a preview that failed to load.

import { useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

export function RerunTask({
  reportId,
  label = "Re-run this task",
}: {
  reportId: number;
  label?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">(
    "idle",
  );
  const supabase = getBrowserClient();

  if (state === "sent") {
    return (
      <span className="text-[12px] font-medium text-qa">
        Queued — the worker picks it up within a few seconds.
      </span>
    );
  }

  const send = async () => {
    setState("sending");
    const { error } = await supabase
      .from("qa_reports")
      .update({ status: "queued", assignee: null })
      .eq("id", reportId);
    if (error) {
      setState("failed");
      return;
    }
    // The event is what makes a re-run legible on the timeline afterwards —
    // otherwise a second run appears with no explanation for why it exists.
    await supabase
      .from("qa_events")
      .insert({
        report_id: reportId,
        type: "system",
        message: "re-run requested from the task page",
      });
    setState("sent");
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      {armed ? (
        <>
          <button
            type="button"
            onClick={() => void send()}
            disabled={state === "sending"}
            className="btn"
          >
            {state === "sending" ? "Queueing…" : "Yes, re-run it"}
          </button>
          <button
            type="button"
            onClick={() => setArmed(false)}
            className="btn btn-quiet"
          >
            Cancel
          </button>
          <span className="text-[11.5px] text-ink-3">
            Starts a fresh run and opens another PR.
          </span>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="btn btn-quiet"
        >
          {label}
        </button>
      )}
      {state === "failed" ? (
        <span className="text-[11.5px] text-red">
          Could not queue it — try again.
        </span>
      ) : null}
    </span>
  );
}
