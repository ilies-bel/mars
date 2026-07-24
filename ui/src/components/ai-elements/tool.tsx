import type { ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

// ---------------------------------------------------------------------------
// Shell-tool detection helpers
// ---------------------------------------------------------------------------

const SHELL_NAMES = new Set([
  "/bin/zsh",
  "/bin/bash",
  "/bin/sh",
  "bash",
  "zsh",
  "sh",
  "shell",
  "local_shell",
]);

function isShellName(name: string): boolean {
  return SHELL_NAMES.has(name);
}

/** Strip the `tool-` prefix and map known shell binary names to "Shell". */
function friendlyToolLabel(rawType: ToolUIPart["type"]): string {
  const name = rawType.replace(/^tool-/, "");
  return isShellName(name) ? "Shell" : name;
}

/**
 * Extract the effective command from shell input.
 * Unwraps wrappers like `/bin/zsh -lc '<inner>'` or `/bin/bash -c "inner"`.
 * Returns the raw `input.command` when no wrapper is detected.
 */
function extractInnerCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj["command"] !== "string") return undefined;
  const cmd = obj["command"];
  // Unwrap: {shell_binary} {flags} '<inner>' or "{inner}"
  const match = cmd.match(
    /^(?:\/bin\/[a-z]+|bash|zsh|sh)\s+(?:-\S+\s+)?(?:'([\s\S]+)'|"([\s\S]+)")$/,
  );
  if (match) return match[1] ?? match[2];
  return cmd;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const getStatusBadge = (status: ToolUIPart["state"]): ReactNode => {
  const labels: Record<ToolUIPart["state"], string> = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "approval-requested": "Awaiting approval",
    "approval-responded": "Approved",
    "output-available": "Completed",
    "output-error": "Error",
    "output-denied": "Denied",
  };
  const icons: Record<ToolUIPart["state"], ReactNode> = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "approval-requested": <ClockIcon className="size-4 animate-pulse" />,
    "approval-responded": <CheckCircleIcon className="size-4 text-success" />,
    "output-available": <CheckCircleIcon className="size-4 text-success" />,
    "output-error": <XCircleIcon className="size-4 text-destructive" />,
    "output-denied": <XCircleIcon className="size-4 text-destructive" />,
  };

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
};

// ---------------------------------------------------------------------------
// ToolHeader
// ---------------------------------------------------------------------------

export type ToolHeaderProps = {
  type: ToolUIPart["type"];
  state: ToolUIPart["state"];
  /** Tool input — used to extract and display the command for shell tools. */
  input?: unknown;
  className?: string;
};

export const ToolHeader = ({
  className,
  type,
  state,
  input,
}: ToolHeaderProps) => {
  const label = friendlyToolLabel(type);
  const isShell = label === "Shell";
  const command = isShell ? extractInnerCommand(input) : undefined;

  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full items-center justify-between gap-4 p-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {isShell ? (
          <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-medium text-sm">{label}</span>
        {command && (
          <span className="max-w-[32ch] truncate font-mono text-muted-foreground text-xs">
            {command}
          </span>
        )}
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

// ---------------------------------------------------------------------------
// ToolContent
// ---------------------------------------------------------------------------

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 text-popover-foreground outline-none",
      className,
    )}
    {...props}
  />
);

// ---------------------------------------------------------------------------
// ToolInput
// ---------------------------------------------------------------------------

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const command = extractInnerCommand(input);

  // Any tool that supplies input.command gets a clean command block.
  if (command !== undefined) {
    return (
      <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Command
        </h4>
        <pre className="overflow-x-auto rounded-md bg-accent/50 p-3 text-xs">
          <code>{command}</code>
        </pre>
      </div>
    );
  }

  // Other tools: render as a key → value definition list.
  if (typeof input === "object" && input !== null) {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > 0) {
      return (
        <div
          className={cn("space-y-2 overflow-hidden p-4", className)}
          {...props}
        >
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Parameters
          </h4>
          <dl className="space-y-1 text-xs">
            {entries.map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="shrink-0 font-medium text-muted-foreground">
                  {key}
                </dt>
                <dd className="min-w-0 truncate font-mono">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      );
    }
  }

  // Fallback: pretty-printed JSON for genuinely unknown shapes.
  return (
    <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Parameters
      </h4>
      <pre className="overflow-x-auto rounded-md bg-accent/50 p-3 text-xs">
        <code>{JSON.stringify(input, null, 2)}</code>
      </pre>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ToolOutput
// ---------------------------------------------------------------------------

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ReactNode;
  errorText: ToolUIPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  return (
    <div className={cn("space-y-2 p-4", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-accent/50 text-foreground",
        )}
      >
        {errorText && <div className="p-3">{errorText}</div>}
        {output && <div className="p-3">{output}</div>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ToolGroup — collapses a run of consecutive tool calls into one compact unit
// ---------------------------------------------------------------------------

/** Minimal per-tool data that ToolGroup needs to render its entries. */
export type ToolGroupEntryData = {
  id: string;
  toolType: ToolUIPart["type"];
  state: ToolUIPart["state"];
  input: unknown;
  output?: ReactNode;
  errorText?: string;
};

type AggregateStatus = "running" | "error" | "done";

function aggregateToolState(tools: ToolGroupEntryData[]): AggregateStatus {
  const states = tools.map((t) => t.state);
  if (states.some((s) => s === "output-error" || s === "output-denied"))
    return "error";
  if (
    states.some(
      (s) =>
        s === "input-streaming" ||
        s === "input-available" ||
        s === "approval-requested",
    )
  )
    return "running";
  return "done";
}

function groupSummaryLabel(tools: ToolGroupEntryData[]): string {
  const count = tools.length;
  const allShell = tools.every((t) =>
    isShellName(t.toolType.replace(/^tool-/, "")),
  );
  if (allShell)
    return `Ran ${count} shell command${count === 1 ? "" : "s"}`;
  return `${count} tool${count === 1 ? "" : "s"}`;
}

const aggregateStatusBadge = (status: AggregateStatus): ReactNode => {
  if (status === "running") {
    return (
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        <ClockIcon className="size-4 animate-pulse" />
        Running
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        <XCircleIcon className="size-4 text-destructive" />
        Error
      </Badge>
    );
  }
  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      <CheckCircleIcon className="size-4 text-success" />
      Done
    </Badge>
  );
};

/**
 * Renders one or more tool calls as a compact, collapsible unit.
 *
 * - Single tool: rendered directly as a `Tool` block (no "Ran 1 …" wrapper).
 * - Multiple tools: collapsed by default into one outer block with an aggregate
 *   status header ("Ran 12 shell commands / 3 tools"). Expanding reveals
 *   individual tool rows, each independently collapsible.
 *
 * The outer content uses `forceMount` so individual rows are always present
 * in the DOM (required for SSR and screen-reader accessibility).
 */
export const ToolGroup = ({ tools }: { tools: ToolGroupEntryData[] }) => {
  if (tools.length === 1) {
    const t = tools[0]!;
    return (
      <Tool>
        <ToolHeader type={t.toolType} state={t.state} input={t.input} />
        <ToolContent>
          <ToolInput input={t.input} />
          <ToolOutput output={t.output} errorText={t.errorText} />
        </ToolContent>
      </Tool>
    );
  }

  const aggStatus = aggregateToolState(tools);
  const summary = groupSummaryLabel(tools);

  return (
    <Collapsible className="not-prose mb-4 w-full rounded-md border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-4 p-3">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium text-sm">{summary}</span>
          {aggregateStatusBadge(aggStatus)}
        </div>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      {/* forceMount keeps individual rows in the DOM when the group is collapsed,
          enabling SSR, screen readers, and status-badge visibility for tests. */}
      <CollapsibleContent
        forceMount
        className="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 text-popover-foreground outline-none"
      >
        <div className="divide-y">
          {tools.map((t) => (
            <Tool
              key={t.id}
              className="not-prose mb-0 w-full rounded-none border-0"
            >
              <ToolHeader type={t.toolType} state={t.state} input={t.input} />
              <ToolContent>
                <ToolInput input={t.input} />
                <ToolOutput output={t.output} errorText={t.errorText} />
              </ToolContent>
            </Tool>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
