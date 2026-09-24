/**
 * LLM provider layer.
 *
 * Every provider is reduced to one streaming chat call, so the pipeline never
 * needs to know which backend is in use. LM Studio, Ollama and llama.cpp all
 * speak the OpenAI chat-completions shape, so they share one adapter; Ollama's
 * native /api/tags is only used for listing models.
 */

import type { LlmConfig, LlmProvider } from "../config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with each token as it arrives. */
  onToken?: (text: string) => void;
  /**
   * "background" for work nobody is waiting to hear — advert copy, a
   * petitioner's line, the producer's plan. Defaults to foreground, which is
   * what a conversation turn is.
   */
  priority?: "foreground" | "background";
  onTiming?: (timing: { queueMs: number; requestMs: number }) => void;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Normalise a user-typed base URL into an OpenAI-compatible root ending in /v1. */
export function resolveBaseUrl(config: LlmConfig): string {
  let url = config.baseUrl.trim().replace(/\/+$/, "");
  if (!url) {
    url = config.provider === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234";
  }
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;

  if (config.provider === "gemini") return url;
  if (!/\/v1$/.test(url)) url = `${url}/v1`;
  return url;
}

function headersFor(config: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.provider === "gemini") {
    headers["x-goog-api-key"] = config.apiKey;
  } else if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function connectionHint(config: LlmConfig): string {
  switch (config.provider) {
    case "lmstudio":
      return "Is LM Studio running with a model loaded? Open LM Studio, go to the Developer tab, load a model and press Start Server.";
    case "ollama":
      return "Is Ollama running? Start it with `ollama serve`, then `ollama run <model>` once to pull a model.";
    case "gemini":
      return "Check that your Gemini API key is set and that this machine can reach generativelanguage.googleapis.com.";
    default:
      return "Check that the server is running and the base URL is correct.";
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutSeconds: number, outer?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Model request timed out after ${timeoutSeconds}s.`, "TimeoutError")),
    timeoutSeconds * 1000,
  );
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort);
  if (outer?.aborted) controller.abort();
  const cleanup = () => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  };

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/* ── Model discovery ─────────────────────────────────────────────── */

export interface ModelInfo {
  id: string;
  label: string;
}

export async function listModels(config: LlmConfig): Promise<ModelInfo[]> {
  const base = resolveBaseUrl(config);

  if (config.provider === "gemini") {
    // Gemini's list endpoint lives outside the OpenAI-compatible surface.
    const url = `${base.replace(/\/v1beta\/openai\/?$/, "")}/v1beta/models`;
    const { response: res, cleanup } = await fetchWithTimeout(url, { headers: headersFor(config) }, 20);
    try {
      if (!res.ok) throw new LlmError(`Model list failed: HTTP ${res.status}`, connectionHint(config));
      const body = (await res.json()) as { models?: Array<{ name?: string; displayName?: string }> };
      return (body.models ?? [])
        .map((m) => ({ id: (m.name ?? "").replace(/^models\//, ""), label: m.displayName ?? m.name ?? "" }))
        .filter((m) => m.id);
    } finally {
      cleanup();
    }
  }

  const { response: res, cleanup } = await fetchWithTimeout(`${base}/models`, { headers: headersFor(config) }, 20);
  try {
    if (!res.ok) throw new LlmError(`Model list failed: HTTP ${res.status}`, connectionHint(config));

    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? [])
      .map((m) => ({ id: m.id ?? "", label: m.id ?? "" }))
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    cleanup();
  }
}

export async function probe(config: LlmConfig): Promise<{ ok: boolean; models: ModelInfo[]; error?: string; hint?: string }> {
  try {
    const models = await listModels(config);
    return { ok: true, models };
  } catch (err) {
    const e = err as Error;
    const isNetwork = /fetch failed|ECONNREFUSED|abort|network/i.test(e.message);
    return {
      ok: false,
      models: [],
      error: isNetwork ? `Could not reach ${resolveBaseUrl(config)}` : e.message,
      hint: (err as LlmError).hint ?? connectionHint(config),
    };
  }
}

/** Default base URL for a provider, used when the user switches providers in the UI. */
export function defaultBaseUrl(provider: LlmProvider): string {
  switch (provider) {
    case "lmstudio":
      return "http://127.0.0.1:1234/v1";
    case "ollama":
      return "http://127.0.0.1:11434/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    default:
      return "http://127.0.0.1:8080/v1";
  }
}

/* ── Generation ──────────────────────────────────────────────────── */

/** Some local models emit visible reasoning or raw chat-template tokens; strip both. */
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\|channel\|>analysis[\s\S]*?<\|message\|>/gi, "")
    .replace(/^<think>[\s\S]*$/i, "") // unterminated block: drop the remainder
    // Llama/Qwen special tokens that leak when a template is applied loosely.
    .replace(/<\|(?:python_tag|eom_id|eot_id|start_header_id|end_header_id|im_start|im_end)\|>/gi, "")
    .trim();
}

/**
 * Detect a response that is a function call or bare JSON rather than prose.
 *
 * Llama 3.1 in particular will answer with {"name": ..., "parameters": ...}
 * if anything in the prompt resembles its tool-calling format. Dialogue is
 * never shaped like this, so treating it as a failure is safe.
 */
export function looksLikeToolCall(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^<\|python_tag\|>/i.test(t)) return true;

  // Starts as a JSON object/array and carries call-shaped keys.
  if (/^[[{]/.test(t)) {
    if (/"(?:name|function|parameters|arguments|tool_name)"\s*:/i.test(t)) return true;
    // A response that is *entirely* a JSON value is not usable dialogue either.
    try {
      JSON.parse(t);
      return true;
    } catch {
      // Truncated JSON still counts if it opened like a call.
      if (/^\s*[{[]\s*"/.test(t)) return true;
    }
  }

  return false;
}

/* ── One model, one queue ──────────────────────────────────────────── */

/**
 * A local model serves one request at a time whatever you send it.
 *
 * This was learned the hard way. Writing the advert breaks used to block the
 * show, so it was moved to run underneath the conversation instead — which
 * looked like a clear win until it was measured. Eleven spots went to LM
 * Studio at once and the conversation had to queue behind them: turn gaps went
 * from about three seconds to between nineteen and twenty-nine, and the show
 * arrived in bursts. The total work was identical. Only the order changed, and
 * the order was what the listener actually experienced.
 *
 * So requests are queued here rather than at the server, where we can say what
 * matters. One in flight, and a conversation turn always jumps the queue —
 * somebody is waiting to hear that one. Adverts fill the gaps.
 */
let inFlight = 0;
const pending: Array<{ background: boolean; start: () => void }> = [];

export function queueStats(): { inFlight: number; pending: number; foreground: number; background: number } {
  return {
    inFlight,
    pending: pending.length,
    foreground: pending.filter((task) => !task.background).length,
    background: pending.filter((task) => task.background).length,
  };
}

function pump(): void {
  if (inFlight > 0 || pending.length === 0) return;

  // Foreground first, oldest first within each lane.
  let next = pending.findIndex((task) => !task.background);
  if (next === -1) next = 0;

  const [task] = pending.splice(next, 1);
  inFlight += 1;
  task.start();
}

function queued<T>(background: boolean, run: () => Promise<T>, signal?: AbortSignal, onStart?: () => void): Promise<T> {
  const aborted = () => new DOMException("Aborted", "AbortError");
  if (signal?.aborted) return Promise.reject(aborted());

  return new Promise<T>((resolve, reject) => {
    const task = {
      background,
      start: () => {
        signal?.removeEventListener("abort", cancel);
        onStart?.();
        Promise.resolve()
          .then(() => {
            if (signal?.aborted) throw aborted();
            return run();
          })
          .then(resolve, reject)
          .finally(() => {
            inFlight -= 1;
            pump();
          });
      },
    };
    const cancel = () => {
      const index = pending.indexOf(task);
      if (index < 0) return;
      pending.splice(index, 1);
      reject(aborted());
    };
    pending.push(task);
    signal?.addEventListener("abort", cancel, { once: true });
    pump();
  });
}

export function generate(config: LlmConfig, opts: GenerateOptions): Promise<string> {
  const queuedAt = performance.now();
  let startedAt = 0;
  return queued(opts.priority === "background", () => generateNow(config, opts), opts.signal, () => {
    startedAt = performance.now();
  }).finally(() => {
    if (!opts.onTiming) return;
    try {
      opts.onTiming({
        queueMs: Math.round((startedAt || performance.now()) - queuedAt),
        requestMs: startedAt ? Math.round(performance.now() - startedAt) : 0,
      });
    } catch {
      // Observability must not change the result of a model request.
    }
  });
}

async function generateNow(config: LlmConfig, opts: GenerateOptions): Promise<string> {
  const base = resolveBaseUrl(config);
  const model = (opts.model || config.model).trim();

  if (!model) {
    throw new LlmError(
      "No model selected.",
      "Pick a model in Settings. Click Refresh to list what your server currently has loaded.",
    );
  }

  const payload = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? config.temperature,
    max_tokens: opts.maxTokens ?? config.maxTokens,
    stream: true,
  };

  let res: Response;
  let cleanup = () => {};
  try {
    const request = await fetchWithTimeout(
      `${base}/chat/completions`,
      { method: "POST", headers: headersFor(config), body: JSON.stringify(payload) },
      config.timeoutSeconds,
      opts.signal,
    );
    res = request.response;
    cleanup = request.cleanup;
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") throw e;
    if (e.name === "TimeoutError") {
      throw new LlmError(e.message, "The model took too long. Try a shorter show or raise the timeout in Settings.");
    }
    throw new LlmError(`Could not reach ${base}: ${e.message}`, connectionHint(config));
  }

  try {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let detail = body.slice(0, 500);
      try {
        const parsed = JSON.parse(body);
        detail = parsed?.error?.message ?? parsed?.message ?? detail;
      } catch {
        /* keep the raw text */
      }

      const hint =
        res.status === 404
          ? `The server did not recognise model "${model}". Refresh the model list and pick one that is actually loaded.`
          : res.status === 401 || res.status === 403
            ? "The server rejected the API key."
            : connectionHint(config);

      throw new LlmError(`HTTP ${res.status}: ${detail}`, hint);
    }

    if (!res.body) throw new LlmError("The server returned an empty response body.", connectionHint(config));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let output = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payloadStr = trimmed.slice(5).trim();
          if (!payloadStr || payloadStr === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payloadStr) as {
              choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
            };
            const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
            if (delta) {
              output += delta;
              opts.onToken?.(delta);
            }
          } catch {
            // A partial JSON line; the next chunk will complete it.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const cleaned = stripReasoning(output);
    if (!cleaned) {
      throw new LlmError(
        "The model returned no usable text.",
        "This usually means the context window filled up or the model only emitted reasoning. Try a shorter show or a different model.",
      );
    }

    return cleaned;
  } catch (err) {
    const e = err as Error;
    if (e.name === "TimeoutError") {
      throw new LlmError(e.message, "The model took too long. Try a shorter show or raise the timeout in Settings.");
    }
    throw err;
  } finally {
    cleanup();
  }
}

/**
 * Unwrap a tool-call envelope.
 *
 * Llama 3.1 answers structured requests as {"name": "...", "parameters": {...}}
 * no matter how firmly it is told not to — but the data we asked for is sitting
 * inside `parameters`. Unwrapping is far more reliable than trying to suppress
 * the behaviour, so we meet the model where it is.
 */
function unwrapEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const obj = value as Record<string, unknown>;
  const inner = obj.parameters ?? obj.arguments;

  if (obj.name && inner && typeof inner === "object") {
    return inner;
  }

  return value;
}

/**
 * Some models stringify nested arrays inside a tool call, e.g.
 * `{"beats": "[\"a\", \"b\"]"}`. Re-parse those so callers see real arrays.
 */
function reviveNestedJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
          out[key] = JSON.parse(trimmed);
          continue;
        } catch {
          // Not JSON after all; keep the string.
        }
      }
    }
    out[key] = v;
  }

  return out;
}

/** Generate and parse a JSON object, tolerating fenced blocks, prose and tool-call envelopes. */
export async function generateJson<T>(config: LlmConfig, opts: GenerateOptions): Promise<T | null> {
  const text = await generate(config, opts);

  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  const candidates = [fenced?.[1], text];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const attempts: string[] = [candidate.trim()];

    // Fall back to the outermost brace/bracket pair if the whole string is not JSON.
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start >= 0 && end > start) attempts.push(candidate.slice(start, end + 1));

    for (const attempt of attempts) {
      try {
        return reviveNestedJson(unwrapEnvelope(JSON.parse(attempt))) as T;
      } catch {
        /* try the next attempt */
      }
    }
  }

  return null;
}
