// FILE: ToolCallDetailsDialog.tsx
// Purpose: Inline details content for command and file-change transcript rows.
// Layer: Chat presentation component
// Exports: ToolCallDetailsContent
// Depends on: WorkLogEntry.toolDetails

import type { ReactNode } from "react";
import { createMarkdownCodeFence, formatShellTranscript } from "~/lib/toolCallDetailsFormatting";
import { cn } from "~/lib/utils";
import type { TimestampFormat } from "../../appSettings";
import type { WorkLogToolDetails, WorkLogToolOutputDetails } from "../../lib/toolCallDetails";
import type { WorkLogLiveActivity } from "../../workLog";
import {
  formatLiveActivityElapsed,
  formatLiveActivityProgress,
  formatLiveActivityStateLabel,
  useLiveActivityNow,
} from "../../lib/liveActivityPresentation";
import { formatTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";

const DETAIL_HEADER_CLASS_NAME = "border-b border-border/45 px-3 py-2 text-[10px] font-medium";
const DETAIL_CODE_BLOCK_CLASS_NAME =
  "max-h-[min(46vh,30rem)] overflow-auto whitespace-pre-wrap break-words font-chat-code text-[11px] leading-relaxed text-foreground/88";
const TOOL_DETAILS_MARKDOWN_CLASS_NAME =
  "text-[length:var(--app-font-size-ui,12px)] leading-relaxed";

export function ToolCallDetailsContent({
  details,
  activity,
  timestampFormat,
}: {
  details: WorkLogToolDetails | undefined;
  activity?: WorkLogLiveActivity | undefined;
  timestampFormat: TimestampFormat;
}) {
  if (!details && !activity) {
    return (
      <div className="rounded-lg border border-border/45 bg-background/60 px-3 py-2 text-sm text-muted-foreground">
        No detailed payload was available for this tool call.
      </div>
    );
  }

  return (
    <>
      {activity ? (
        <LiveActivityMetadata activity={activity} timestampFormat={timestampFormat} />
      ) : null}

      {details?.command ? (
        <div className="space-y-2">
          <MarkdownToolCodeBlock language="bash">
            {formatShellTranscript(details.command, details.output)}
          </MarkdownToolCodeBlock>
          {details.output ? <ToolOutputMetadata output={details.output} /> : null}
        </div>
      ) : null}

      {details?.files?.length ? (
        <ToolDetailSection title="Files">
          <div className="flex flex-wrap gap-1.5">
            {details.files.map((file) => (
              <span
                key={file}
                className="max-w-full rounded-md border border-border/45 bg-background/70 px-2 py-1 font-chat-code text-[11px] text-foreground/82"
                title={file}
              >
                {file}
              </span>
            ))}
          </div>
        </ToolDetailSection>
      ) : null}

      {details?.diff ? (
        <ToolDetailSection title="Diff">
          <DiffCodeBlock>{details.diff}</DiffCodeBlock>
        </ToolDetailSection>
      ) : null}

      {details?.edits?.length ? (
        <ToolDetailSection title="Edits">
          <div className="space-y-3">
            {details.edits.map((edit, index) => (
              <div
                key={`${edit.path ?? "edit"}:${index}`}
                className="overflow-hidden rounded-lg border border-border/45 bg-background/58"
              >
                {edit.path ? (
                  <div className="border-b border-border/45 px-3 py-2 font-chat-code text-[11px] text-muted-foreground/72">
                    {edit.path}
                  </div>
                ) : null}
                <div className="grid gap-0 md:grid-cols-2">
                  {edit.oldText !== undefined ? (
                    <TextChangeBlock title="Before" tone="remove">
                      {edit.oldText}
                    </TextChangeBlock>
                  ) : null}
                  {edit.newText !== undefined ? (
                    <TextChangeBlock title="After" tone="add">
                      {edit.newText}
                    </TextChangeBlock>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </ToolDetailSection>
      ) : null}

      {details?.content ? (
        <ToolDetailSection title="Written Content">
          <MarkdownToolCodeBlock language="text">{details.content}</MarkdownToolCodeBlock>
        </ToolDetailSection>
      ) : null}

      {details?.output && !details.command ? <ToolOutputSection output={details.output} /> : null}
    </>
  );
}

function formatActivityTimestamp(value: string, timestampFormat: TimestampFormat): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return formatTimestamp(value, timestampFormat);
}

function LiveActivityMetadata({
  activity,
  timestampFormat,
}: {
  activity: WorkLogLiveActivity;
  timestampFormat: TimestampFormat;
}) {
  const stateLabel = formatLiveActivityStateLabel(activity.state);
  const nowMs = useLiveActivityNow(activity);
  const elapsed = formatLiveActivityElapsed(activity, nowMs);
  const progress =
    activity.progress !== undefined ? formatLiveActivityProgress(activity.progress) : null;

  return (
    <ToolDetailSection title="Activity">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 text-[11px]">
        <dt className="text-muted-foreground/56">Status</dt>
        <dd className="text-foreground/84">{stateLabel}</dd>
        {activity.startedAt ? (
          <>
            <dt className="text-muted-foreground/56">Started</dt>
            <dd className="text-foreground/84">
              <time dateTime={activity.startedAt} title={activity.startedAt}>
                {formatActivityTimestamp(activity.startedAt, timestampFormat)}
              </time>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground/56">Last activity</dt>
        <dd className="text-foreground/84">
          <time dateTime={activity.lastActivityAt} title={activity.lastActivityAt}>
            {formatActivityTimestamp(activity.lastActivityAt, timestampFormat)}
          </time>
        </dd>
        {elapsed ? (
          <>
            <dt className="text-muted-foreground/56">Elapsed</dt>
            <dd className="tabular-nums text-foreground/84">{elapsed}</dd>
          </>
        ) : null}
        {progress ? (
          <>
            <dt className="text-muted-foreground/56">Progress</dt>
            <dd className="tabular-nums text-foreground/84">{progress}</dd>
          </>
        ) : null}
        {activity.detail ? (
          <>
            <dt className="text-muted-foreground/56">Detail</dt>
            <dd className="break-words text-foreground/84">{activity.detail}</dd>
          </>
        ) : null}
      </dl>
    </ToolDetailSection>
  );
}

function MarkdownToolCodeBlock(props: { language: string; children: string }) {
  return (
    <ChatMarkdown
      text={createMarkdownCodeFence(props.language, props.children)}
      cwd={undefined}
      className={TOOL_DETAILS_MARKDOWN_CLASS_NAME}
    />
  );
}

function ToolDetailSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-medium text-muted-foreground/56">{props.title}</h3>
      {props.children}
    </section>
  );
}

function ToolOutputMetadata({ output }: { output: WorkLogToolOutputDetails }) {
  if (output.exitCode === undefined && !output.truncated) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/68">
      {output.exitCode !== undefined ? (
        <span className="rounded-full border border-border/45 px-2 py-0.5">
          Exit code {output.exitCode}
        </span>
      ) : null}
      {output.truncated ? (
        <span className="rounded-full border border-amber-500/30 bg-amber-500/8 px-2 py-0.5 text-amber-200/90">
          Truncated
        </span>
      ) : null}
    </div>
  );
}

function ToolOutputSection({ output }: { output: WorkLogToolOutputDetails }) {
  return (
    <ToolDetailSection title="Output">
      <div className="space-y-3">
        {output.output ? (
          <MarkdownToolCodeBlock language="text">{output.output}</MarkdownToolCodeBlock>
        ) : null}
        {output.stdout ? (
          <LabeledCodeBlock title="Stdout" tone="output">
            {output.stdout}
          </LabeledCodeBlock>
        ) : null}
        {output.stderr ? (
          <LabeledCodeBlock title="Stderr" tone="error">
            {output.stderr}
          </LabeledCodeBlock>
        ) : null}
        <ToolOutputMetadata output={output} />
      </div>
    </ToolDetailSection>
  );
}

function LabeledCodeBlock(props: { title: string; tone: "output" | "error"; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/45 bg-background/58">
      <div
        className={cn(
          DETAIL_HEADER_CLASS_NAME,
          props.tone === "error" ? "text-rose-200/88" : "text-muted-foreground/60",
        )}
      >
        {props.title}
      </div>
      <ToolCodeBlock bare>{props.children}</ToolCodeBlock>
    </div>
  );
}

function TextChangeBlock(props: { title: string; tone: "add" | "remove"; children: string }) {
  return (
    <div
      className={cn(
        "min-w-0 border-border/45 md:[&:not(:first-child)]:border-l",
        props.tone === "add" ? "bg-emerald-500/5" : "bg-rose-500/5",
      )}
    >
      <div
        className={cn(
          DETAIL_HEADER_CLASS_NAME,
          props.tone === "add" ? "text-emerald-200/82" : "text-rose-200/82",
        )}
      >
        {props.title}
      </div>
      <ToolCodeBlock bare>{props.children}</ToolCodeBlock>
    </div>
  );
}

function ToolCodeBlock(props: { children: string; tone?: "default" | "command"; bare?: boolean }) {
  return (
    <pre
      className={cn(
        DETAIL_CODE_BLOCK_CLASS_NAME,
        props.tone === "command" && "text-sky-100/92",
        props.bare
          ? "px-3 py-2.5"
          : "rounded-lg border border-border/45 bg-background/70 px-3 py-2.5",
      )}
    >
      {props.children}
    </pre>
  );
}

function DiffCodeBlock({ children }: { children: string }) {
  const lines = children.split(/\r?\n/);
  return (
    <pre className="max-h-[min(52vh,34rem)] overflow-auto rounded-lg border border-border/45 bg-background/70 px-0 py-2 font-chat-code text-[11px] leading-relaxed">
      {lines.map((line, index) => (
        <span
          key={`${index}:${line.slice(0, 24)}`}
          className={cn(
            "block min-w-max whitespace-pre-wrap break-words px-3",
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-emerald-500/8 text-emerald-100/92"
              : null,
            line.startsWith("-") && !line.startsWith("---")
              ? "bg-rose-500/8 text-rose-100/92"
              : null,
            line.startsWith("@@") ? "text-sky-200/90" : null,
            /^(diff --git|index |--- |\+\+\+ )/.test(line) ? "text-muted-foreground/62" : null,
          )}
        >
          {line.length > 0 ? line : " "}
        </span>
      ))}
    </pre>
  );
}
