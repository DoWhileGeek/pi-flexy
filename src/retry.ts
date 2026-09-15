import {
  createAssistantMessageEventStream, isRetryableAssistantError,
  type AssistantMessage, type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export const DEFAULT_FLEX_RETRIES = 2;
export const MAX_FLEX_RETRIES = 10;
export const FLEX_RETRY_BASE_DELAY_MS = 2000;
export const FLEX_RETRY_MAX_DELAY_MS = 30_000;

export type FlexRetryTerminalReason =
  | "success"
  | "budget-exhausted"
  | "partial-output"
  | "pass-through"
  | "aborted"
  | "internal-error"
  | "fallback-failed";

export interface FlexRetryCallbacks {
  onFallback?: () => void;
  onAttemptFailure?: (message: AssistantMessage, attempt: number, tier: "flex" | "default") => void;
  onRetryScheduled?: (attempt: number, maxRetries: number, delayMs: number) => void;
  onRetryStart?: (attempt: number, maxRetries: number) => void;
  onTerminal?: (reason: FlexRetryTerminalReason, retriesPerformed: number) => void;
}

export interface FlexRetryOptions extends FlexRetryCallbacks {
  maxRetries: number;
  fallback?: boolean;
  baseDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (message: AssistantMessage) => boolean;
  createError: (error: unknown) => AssistantMessage;
}

export function parseFlexRetries(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_FLEX_RETRIES ? value : undefined;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]|10)$/.test(value)) return undefined;
  return Number(value);
}

export function flexRetryDelayMs(attempt: number, baseDelayMs = FLEX_RETRY_BASE_DELAY_MS): number {
  return Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), FLEX_RETRY_MAX_DELAY_MS);
}

function invoke(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* Observability callbacks must not break provider streams. */ }
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Aborted")); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error("Aborted")); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function exhaustedMessage(message: AssistantMessage, attempts: number): AssistantMessage {
  return {
    ...message,
    content: [],
    stopReason: "error",
    errorMessage: `Flexy exhausted configured Flex retry budget after ${attempts} total stream attempt${attempts === 1 ? "" : "s"}. Standard processing was not used. See /flex audit.`,
  };
}

function partialOutputMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    stopReason: "error",
    errorMessage: "Flex stream failed after output started; automatic replay was suppressed. Standard processing was not used. See /flex audit.",
  };
}

function abortedMessage(message: AssistantMessage): AssistantMessage {
  return { ...message, stopReason: "aborted", errorMessage: "Flex retry cancelled." };
}

/**
 * Retry transient zero-output Flex failures inside one provider stream. Pi sees one
 * assistant turn, so steering queued during backoff cannot enter retry payloads.
 */
export function retryFlexStream(
  produce: (tier: "flex" | "default") => AssistantMessageEventStream,
  options: FlexRetryOptions,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  const maxRetries = parseFlexRetries(options.maxRetries) ?? DEFAULT_FLEX_RETRIES;
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? FLEX_RETRY_BASE_DELAY_MS);

  void (async () => {
    let started = false;
    let outputStarted = false;
    let retriesPerformed = 0;
    let attemptNumber = 0;
    let tier: "flex" | "default" = "flex";
    try {
      for (;;) {
        attemptNumber++;
        if (options.signal?.aborted) {
          const cancelled = abortedMessage(options.createError(new Error("Aborted")));
          invoke(() => options.onTerminal?.("aborted", retriesPerformed));
          outer.push({ type: "error", reason: "aborted", error: cancelled });
          outer.end();
          return;
        }
        const source = produce(tier);
        let failed: AssistantMessage | undefined;
        let failureReason: "error" | "aborted" = "error";

        for await (const event of source) {
          if (event.type === "start") {
            if (!started) {
              started = true;
              outer.push(event);
            }
          } else if (event.type === "done") {
            invoke(() => options.onTerminal?.("success", retriesPerformed));
            outer.push(event);
            outer.end();
            return;
          } else if (event.type === "error") {
            failed = event.error;
            failureReason = event.reason;
          } else {
            outputStarted = true;
            outer.push(event);
          }
        }

        failed ??= await source.result();
        if (failureReason !== "aborted" && failed.stopReason === "error") {
          invoke(() => options.onAttemptFailure?.(failed, attemptNumber, tier));
        }
        if (failureReason === "aborted" || failed.stopReason === "aborted" || options.signal?.aborted) {
          invoke(() => options.onTerminal?.("aborted", retriesPerformed));
          outer.push({ type: "error", reason: "aborted", error: abortedMessage(failed) });
          outer.end();
          return;
        }

        // Standard fallback gets exactly one attempt; never restart the Flex budget.
        if (tier === "default") {
          const terminal: AssistantMessage = { ...failed, stopReason: "error",
            errorMessage: "Flexy standard-tier fallback failed. Automatic attempts have ended. See /flex audit." };
          invoke(() => options.onTerminal?.("fallback-failed", retriesPerformed));
          outer.push({ type: "error", reason: "error", error: terminal });
          outer.end();
          return;
        }

        if (!isRetryableAssistantError(failed) || options.shouldRetry?.(failed) === false) {
          invoke(() => options.onTerminal?.("pass-through", retriesPerformed));
          outer.push({ type: "error", reason: "error", error: failed });
          outer.end();
          return;
        }

        if (outputStarted || failed.content.length > 0) {
          const terminal = partialOutputMessage(failed);
          invoke(() => options.onTerminal?.("partial-output", retriesPerformed));
          outer.push({ type: "error", reason: "error", error: terminal });
          outer.end();
          return;
        }

        if (retriesPerformed >= maxRetries) {
          if (options.fallback) {
            tier = "default";
            invoke(options.onFallback);
            continue;
          }
          const terminal = exhaustedMessage(failed, retriesPerformed + 1);
          invoke(() => options.onTerminal?.("budget-exhausted", retriesPerformed));
          outer.push({ type: "error", reason: "error", error: terminal });
          outer.end();
          return;
        }

        const nextAttempt = retriesPerformed + 1;
        const delayMs = flexRetryDelayMs(nextAttempt, baseDelayMs);
        invoke(() => options.onRetryScheduled?.(nextAttempt, maxRetries, delayMs));
        try {
          await abortableSleep(delayMs, options.signal);
        } catch {
          const terminal = abortedMessage(failed);
          invoke(() => options.onTerminal?.("aborted", retriesPerformed));
          outer.push({ type: "error", reason: "aborted", error: terminal });
          outer.end();
          return;
        }
        retriesPerformed = nextAttempt;
        invoke(() => options.onRetryStart?.(nextAttempt, maxRetries));
      }
    } catch (error) {
      const terminal = options.createError(error);
      invoke(() => options.onTerminal?.("internal-error", retriesPerformed));
      outer.push({ type: "error", reason: terminal.stopReason === "aborted" ? "aborted" : "error", error: terminal });
      outer.end();
    }
  })();

  return outer;
}
