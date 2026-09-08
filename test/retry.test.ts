import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream, isRetryableAssistantError,
  type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { flexRetryDelayMs, parseFlexRetries, retryFlexStream } from "../src/retry.ts";

function message(stopReason: AssistantMessage["stopReason"], errorMessage?: string, text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function source(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  stream.end();
  return stream;
}

function failed(text = "We're currently processing too many requests — please try again later."): AssistantMessageEventStream {
  const pending = message("pending");
  const error = message("error", text);
  return source([{ type: "start", partial: pending }, { type: "error", reason: "error", error }]);
}

function succeeded(text = "done"): AssistantMessageEventStream {
  const pending = message("pending");
  const partial = message("pending", undefined, text);
  const final = message("stop", undefined, text);
  return source([
    { type: "start", partial: pending },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: text, partial },
    { type: "text_end", contentIndex: 0, content: text, partial },
    { type: "done", reason: "stop", message: final },
  ]);
}

function internalError(): AssistantMessage { return message("error", "Flexy internal stream wrapper failed."); }

async function collect(stream: AssistantMessageEventStream): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

test("retry count parser and capped exponential delays stay bounded", () => {
  for (const value of [0, 1, 10, "0", "2", "10"]) assert.equal(parseFlexRetries(value), Number(value));
  for (const value of [-1, 11, 1.5, "", "01", "-1", "11", "2.0", null]) assert.equal(parseFlexRetries(value), undefined);
  assert.deepEqual([1, 2, 3, 4, 5, 10].map(attempt => flexRetryDelayMs(attempt)), [2000, 4000, 8000, 16000, 30000, 30000]);
});

test("zero-output transient failures retry inside one stream without leaking failed terminals", async () => {
  let calls = 0;
  const scheduled: number[] = [];
  const started: number[] = [];
  const terminal: string[] = [];
  const stream = retryFlexStream(() => ++calls < 3 ? failed() : succeeded(), {
    maxRetries: 2,
    baseDelayMs: 0,
    createError: internalError,
    onRetryScheduled: attempt => scheduled.push(attempt),
    onRetryStart: attempt => started.push(attempt),
    onTerminal: reason => terminal.push(reason),
  });
  const { events, result } = await collect(stream);
  assert.equal(calls, 3);
  assert.deepEqual(scheduled, [1, 2]);
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(terminal, ["success"]);
  assert.equal(events.filter(event => event.type === "start").length, 1);
  assert.equal(events.filter(event => event.type === "error").length, 0);
  assert.equal(events.filter(event => event.type === "done").length, 1);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content[0]?.type, "text");
});

test("exhausted configured budget emits one non-retryable terminal failure", async () => {
  let calls = 0;
  const terminal: string[] = [];
  const { events, result } = await collect(retryFlexStream(() => { calls++; return failed(); }, {
    maxRetries: 1,
    baseDelayMs: 0,
    createError: internalError,
    onTerminal: reason => terminal.push(reason),
  }));
  assert.equal(calls, 2, "one retry means two total attempts");
  assert.deepEqual(terminal, ["budget-exhausted"]);
  assert.equal(events.filter(event => event.type === "error").length, 1);
  assert.match(result.errorMessage!, /2 total stream attempts/);
  assert.doesNotMatch(result.errorMessage!, /too many requests/i);
  assert.equal(isRetryableAssistantError(result), false, "Pi must not add generic retries after Flexy budget");
});

test("zero retries fails after initial attempt and partial output is never replayed", async () => {
  let calls = 0;
  const zero = await collect(retryFlexStream(() => { calls++; return failed(); }, {
    maxRetries: 0, baseDelayMs: 0, createError: internalError,
  }));
  assert.equal(calls, 1);
  assert.match(zero.result.errorMessage!, /1 total stream attempt\./);
  assert.equal(isRetryableAssistantError(zero.result), false);

  calls = 0;
  const pending = message("pending");
  const partial = message("pending", undefined, "half");
  const error = message("error", "too many requests", "half");
  const partialResult = await collect(retryFlexStream(() => {
    calls++;
    return source([
      { type: "start", partial: pending },
      { type: "text_delta", contentIndex: 0, delta: "half", partial },
      { type: "error", reason: "error", error },
    ]);
  }, { maxRetries: 3, baseDelayMs: 0, createError: internalError }));
  assert.equal(calls, 1);
  assert.match(partialResult.result.errorMessage!, /output started/);
  assert.equal(isRetryableAssistantError(partialResult.result), false);
});

test("non-transient failures pass through unchanged; abort during backoff starts no retry", async () => {
  const deterministic = await collect(retryFlexStream(() => failed("unsupported model"), {
    maxRetries: 2, baseDelayMs: 0, createError: internalError,
  }));
  assert.equal(deterministic.result.errorMessage, "unsupported model");

  const controller = new AbortController();
  let calls = 0;
  const aborted = await collect(retryFlexStream(() => { calls++; return failed(); }, {
    maxRetries: 2,
    baseDelayMs: 50,
    signal: controller.signal,
    createError: internalError,
    onRetryScheduled: () => controller.abort(),
  }));
  assert.equal(calls, 1);
  assert.equal(aborted.result.stopReason, "aborted");
  assert.equal(aborted.result.errorMessage, "Flex retry cancelled.");
});
