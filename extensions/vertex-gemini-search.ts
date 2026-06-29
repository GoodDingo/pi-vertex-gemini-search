/**
 * Vertex Gemini Search extension
 *
 * Registers two tools the model can call autonomously for live/fresh info:
 *   - web_search   : quick verification / fact check (short answer)
 *   - web_research : complex topics (longer, more detailed answer)
 *
 * Both use Vertex AI Gemini with Google Search grounding. The search context
 * stays inside the tool result, keeping the main conversation lean.
 *
 * Source URLs returned by Gemini are vertexaisearch.cloud.google.com redirect
 * links. They are resolved to their pure destination URLs (via the 302
 * `location` header, no body download) so only clean links enter your context.
 *
 * Authentication uses Application Default Credentials via `gcloud auth print-access-token`.
 * Configure project/region/model with env vars or defaults below.
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const VERTEX_PROJECT_ID = process.env["VERTEX_PROJECT_ID"] ?? "rd-aise-prod766-dev";
const VERTEX_REGION = process.env["VERTEX_REGION"] ?? "eu";
const GEMINI_MODEL_SHORT = process.env["GEMINI_MODEL_SHORT"] ?? "gemini-3.1-flash-lite";
const GEMINI_MODEL_LONG = process.env["GEMINI_MODEL_LONG"] ?? "gemini-3.5-flash";
const GEMINI_ENDPOINT = (model: string) =>
  `https://aiplatform.${VERTEX_REGION}.rep.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_REGION}/publishers/google/models/${model}:generateContent`;
const MAX_SOURCES = 6;
// Transient statuses Google recommends retrying with exponential backoff.
// 503 in particular signals temporary overload / high demand on the model.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3; // total attempts per tier = MAX_RETRIES + 1
const MAX_BACKOFF_MS = 16_000;
const MAX_RETRY_AFTER_MS = 60_000;

const SYSTEM_INSTRUCTION = `You are a web research assistant with live internet access via two tools: google_search (web search) and url_context (fetch & read specific URLs the user gives you).
RULES:
- ALWAYS ground your answer using these tools. Never answer from memory alone — search the web and/or read any URLs provided.
- If the input includes URLs, READ them with url_context before answering.
- Treat the input as context-rich: it may contain background, constraints, prior conclusions, or a request for a second opinion. Use all of it.
- State facts directly. Include version numbers, dates, and names when relevant.
- When asked for an opinion or analysis, reason from grounded evidence and clearly separate fact from judgment.
- Do not add filler, disclaimers, or conversational preamble.
- If results are uncertain, missing, or conflicting, say so briefly.
- Cite which sources support key claims where useful.`;

function resolveAccessToken(): string {
  const fromEnv = process.env["VERTEX_ACCESS_TOKEN"];
  if (fromEnv) return fromEnv;

  try {
    return execFileSync("gcloud", ["auth", "print-access-token"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Vertex AI access token not found. Run: gcloud auth login (or set VERTEX_ACCESS_TOKEN). Details: ${msg}`,
    );
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
  error?: { message?: string };
}

/**
 * Resolve a vertexaisearch redirect URL to its pure destination by reading the
 * 302 `location` header. Falls back to the original URL on any failure.
 */
async function resolveUrl(url: string, signal: AbortSignal): Promise<string> {
  if (!url.includes("vertexaisearch.cloud.google.com")) return url;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal,
    });
    const loc = res.headers.get("location");
    if (loc) return loc;
  } catch {
    // ignore — return original
  }
  return url;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

interface RunOptions {
  query: string;
  detail: "short" | "long";
}

async function runSearch(
  { query, detail }: RunOptions,
  signal: AbortSignal,
): Promise<{
  text: string;
  sourceCount: number;
  groundingQueries: string[];
}> {
  const accessToken = resolveAccessToken();

  const instruction =
    detail === "long"
      ? `${SYSTEM_INSTRUCTION}\nThis is a COMPLEX research query. Provide a thorough, well-structured answer covering the key facets of the topic. Organize with short sections or bullet points where helpful. Aim for completeness over brevity.`
      : `${SYSTEM_INSTRUCTION}\nThis is a QUICK verification query. Answer as concisely as possible — ideally one to three sentences. Only include the essential fact(s) needed to verify or check.`;

  const model = detail === "long" ? GEMINI_MODEL_LONG : GEMINI_MODEL_SHORT;
  const flexTimeout = detail === "long" ? 160_000 : 60_000;
  const standardTimeout = detail === "long" ? 260_000 : 60_000;

  const buildBody = (serviceTier: "flex" | "standard") => ({
    system_instruction: { parts: [{ text: instruction }] },
    contents: [{ role: "user", parts: [{ text: query }] }],
    tools: [{ google_search: {} }, { url_context: {} }],
    labels: {
      app: "pi-vertex-gemini-search",
      module: "vertex-ai",
      tier: serviceTier,
    },
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: detail === "long" ? 12000 : 2000,
    },
  });

  const doFetch = async (
    serviceTier: "flex" | "standard",
    timeoutMs: number,
  ): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    // Combine the user's abort signal with our timeout.
    const combined =
      "any" in AbortSignal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
    return fetch(GEMINI_ENDPOINT(model), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify(buildBody(serviceTier)),
      signal: combined,
    });
  };

  /**
   * Sleep that rejects early if the caller aborts. Keeps retries responsive to
   * cancellation.
   */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

  /**
   * Parse a `Retry-After` header (seconds or HTTP-date) into milliseconds.
   */
  const parseRetryAfter = (header: string | null): number | undefined => {
    if (!header) return undefined;
    const secs = Number(header);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    return undefined;
  };

  /**
   * Exponential backoff with jitter (Google's recommended strategy for 503).
   * Honors `Retry-After` when the server provides it.
   */
  const backoffDelay = (
    attempt: number,
    retryAfterMs?: number,
  ): number => {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    }
    const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    return base + Math.random() * 500; // jitter to avoid thundering herd
  };

  /**
   * Fetch with bounded retries on transient errors (429/5xx) and network
   * failures. Returns the last response if retries are exhausted (so the
   * caller can still inspect status / fall back to another tier).
   */
  const fetchWithRetry = async (
    serviceTier: "flex" | "standard",
    timeoutMs: number,
  ): Promise<Response> => {
    let lastResponse: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) throw new Error("aborted");
      try {
        const res = await doFetch(serviceTier, timeoutMs);
        if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
        lastResponse = res;
        lastError = undefined;
      } catch (err) {
        if (signal.aborted) throw err; // user cancelled
        lastError = err;
        lastResponse = undefined;
      }
      if (attempt < MAX_RETRIES) {
        const retryAfterMs = parseRetryAfter(
          lastResponse?.headers.get("retry-after") ?? null,
        );
        await sleep(backoffDelay(attempt, retryAfterMs));
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError;
  };

  // 1) Try Flex first (50% cheaper, but slow / sheddable) with retries on
  //    transient errors.
  // 2) On timeout / network error OR a retryable status that exhausted retries,
  //    fall back to the standard tier (longer timeout) and retry there too.
  let response: Response;
  try {
    response = await fetchWithRetry("flex", flexTimeout);
  } catch (err) {
    if (signal.aborted) throw err; // user cancelled — don't retry
    response = await fetchWithRetry("standard", standardTimeout);
  }

  // Flex can still return a retryable error after exhausting its retries
  // (common — the Flex tier sheds load aggressively). Give standard a turn.
  if (!response.ok && RETRYABLE_STATUS.has(response.status)) {
    response = await fetchWithRetry("standard", standardTimeout);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vertex AI Gemini API error (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as GeminiResponse;

  if (data.error) {
    throw new Error(`Vertex AI Gemini API error: ${data.error.message ?? "unknown"}`);
  }

  const candidate = data.candidates?.[0];
  const answer =
    candidate?.content?.parts?.map((p) => p.text ?? "").join("\n").trim() ??
    "(no answer returned)";

  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const rawUrls = chunks
    .map((c) => c.web?.uri)
    .filter((u): u is string => !!u)
    .slice(0, MAX_SOURCES);

  // Resolve redirect URLs to pure links in parallel (best-effort, bounded).
  const resolved = await Promise.all(
    rawUrls.map((u) => resolveUrl(u, signal)),
  );

  const seen = new Set<string>();
  const sources: string[] = [];
  for (const u of resolved) {
    if (seen.has(u)) continue;
    seen.add(u);
    const host = hostOf(u);
    sources.push(`${sources.length + 1}. ${host ? host + " — " : ""}${u}`);
  }

  const text =
    sources.length > 0
      ? `${answer}\n\nSources:\n${sources.join("\n")}`
      : answer;

  return {
    text,
    sourceCount: sources.length,
    groundingQueries: candidate?.groundingMetadata?.webSearchQueries ?? [],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {},
  };
}

export default function (pi: ExtensionAPI) {
  // Quick verification / fact check.
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Quick fact-check or verification via a companion model WITH live web access. " +
      "It searches the web + reads any URLs you pass, then returns ONLY a concise synthesized answer + source URLs — no raw page dumps, no irrelevant content noise, so your context stays lean. " +
      "Input is context-rich: include background, the claim to verify, URLs to cross-check; more context = better answer. " +
      "Use for version numbers, dates, single facts, or a quick second opinion. For complex topics use web_research.",
    parameters: Type.Object({
      query: Type.String({
        description: "The specific fact or question to verify on the web.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const result = await runSearch(
          { query: params.query, detail: "short" },
          signal,
        );
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            model: GEMINI_MODEL_SHORT,
            depth: "short",
            sourceCount: result.sourceCount,
            groundingQueries: result.groundingQueries,
          },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // In-depth research on a complex topic.
  pi.registerTool({
    name: "web_research",
    label: "Web Research",
    description:
      "In-depth research, comparison, or grounded second opinion via a companion model WITH live web access. " +
      "It searches the web + reads any URLs you pass, then returns ONLY a synthesized, structured answer + source URLs — no raw page dumps, no irrelevant content noise, so your context stays lean. " +
      "Input is context-rich: include background, constraints, prior conclusions, docs URLs to read; more context = better answer. " +
      "Use for multi-faceted topics, how-tos, architecture opinions. For quick checks use web_search.",
    parameters: Type.Object({
      query: Type.String({
        description: "The complex topic or research question to investigate on the web.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const result = await runSearch(
          { query: params.query, detail: "long" },
          signal,
        );
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            model: GEMINI_MODEL_LONG,
            depth: "long",
            sourceCount: result.sourceCount,
            groundingQueries: result.groundingQueries,
          },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });
}
