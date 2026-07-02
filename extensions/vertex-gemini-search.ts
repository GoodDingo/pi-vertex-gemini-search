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
 * Configure project, region, and models with environment variables.
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const VERTEX_PROJECT_ID = process.env["VERTEX_PROJECT_ID"];
const VERTEX_REGION = process.env["VERTEX_REGION"] ?? "eu";
const GEMINI_MODEL_SHORT = process.env["GEMINI_MODEL_SHORT"] ?? "gemini-3.1-flash-lite";
const GEMINI_MODEL_LONG = process.env["GEMINI_MODEL_LONG"] ?? "gemini-3.5-flash";
const GEMINI_ENDPOINT = (model: string) => {
  if (!VERTEX_PROJECT_ID) {
    throw new Error("VERTEX_PROJECT_ID is required for Vertex AI Gemini Search.");
  }

  return `https://aiplatform.${VERTEX_REGION}.rep.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_REGION}/publishers/google/models/${model}:generateContent`;
};
const MAX_SOURCES = 6;
const SEARCH_GROUNDING_USD_PER_1000 = Number(
  process.env["GEMINI_SEARCH_GROUNDING_USD_PER_1000"] ?? "14",
);
const USD_TO_EUR = Number(process.env["USD_TO_EUR"] ?? "0.93");
const FLEX_TOKEN_DISCOUNT = Number(process.env["VERTEX_FLEX_TOKEN_DISCOUNT"] ?? "0.5");
let flexUnavailableForSession = false;
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
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  error?: { message?: string };
}

interface SourceLink {
  index: number;
  host: string;
  url: string;
}

interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  searchQueries: number;
  tokenUsd: number;
  groundingUsd: number;
  totalUsd: number;
  totalEur: number;
  pricingNote: string;
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

function modelPricingUsdPerMillion(model: string): { input: number; output: number } {
  if (model.includes("3.1-flash-lite")) return { input: 0.25, output: 1.5 };
  if (model.includes("3.5-flash")) return { input: 1.5, output: 9 };
  return { input: 0, output: 0 };
}

function money(amount: number, currency: "USD" | "EUR"): string {
  const symbol = currency === "USD" ? "$" : "€";
  if (amount < 0.01) return `${symbol}${amount.toFixed(6)}`;
  return `${symbol}${amount.toFixed(4)}`;
}

function estimateCost(params: {
  model: string;
  serviceTier: "flex" | "standard";
  usage?: GeminiResponse["usageMetadata"];
  searchQueries: number;
}): CostEstimate {
  const inputTokens = params.usage?.promptTokenCount ?? 0;
  const outputTokens =
    (params.usage?.candidatesTokenCount ?? 0) +
    (params.usage?.thoughtsTokenCount ?? 0);
  const totalTokens = params.usage?.totalTokenCount ?? inputTokens + outputTokens;
  const pricing = modelPricingUsdPerMillion(params.model);
  const standardTokenUsd =
    (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  const tokenDiscount = params.serviceTier === "flex" ? FLEX_TOKEN_DISCOUNT : 1;
  const tokenUsd = standardTokenUsd * tokenDiscount;
  const groundingUsd =
    (params.searchQueries * SEARCH_GROUNDING_USD_PER_1000) / 1000;
  const totalUsd = tokenUsd + groundingUsd;
  const totalEur = totalUsd * USD_TO_EUR;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    searchQueries: params.searchQueries,
    tokenUsd,
    groundingUsd,
    totalUsd,
    totalEur,
    pricingNote:
      `Google Search grounding ${params.searchQueries} × $${SEARCH_GROUNDING_USD_PER_1000}/1k queries = ${money(groundingUsd, "USD")}; ` +
      `tokens ${inputTokens} in / ${outputTokens} out at ${params.model} rates` +
      (params.serviceTier === "flex"
        ? ` with Flex ${Math.round((1 - FLEX_TOKEN_DISCOUNT) * 100)}% token discount`
        : " at standard tier") +
      ` = ${money(tokenUsd, "USD")}. ` +
      `Estimate uses USD→EUR=${USD_TO_EUR}.`,
  };
}

function summaryLine(params: {
  model: string;
  region: string;
  cost: CostEstimate;
  sourceCount: number;
  serviceTier: "flex" | "standard";
}): string {
  const sourceLabel = `${params.sourceCount} source${params.sourceCount === 1 ? "" : "s"}`;
  const pricingLabel = params.serviceTier === "flex" ? "flex pricing" : "standard pricing";
  return (
    `◆ Gemini Search [` +
    `${params.model}, ${params.region}, ` +
    `${money(params.cost.totalEur, "EUR")}/${money(params.cost.totalUsd, "USD")}, ` +
    `${sourceLabel}, ${pricingLabel}` +
    `]`
  );
}

function ansi(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function osc8(url: string, label: string): string {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

function linkifyUrls(line: string): string {
  return line.replace(/https?:\/\/[^\s)]+/g, (raw) => {
    const trailing = raw.match(/[.,;:]$/)?.[0] ?? "";
    const url = trailing ? raw.slice(0, -1) : raw;
    return `${osc8(url, ansi("1;4;96", url))}${trailing}`;
  });
}

function brutalistLine(line: string): string {
  if (line.startsWith("◆ Gemini Search [")) {
    const open = line.indexOf("[");
    const meta = open >= 0 ? line.slice(open) : "";
    return `${ansi("1;30;103", " ◆ GEMINI SEARCH ")} ${ansi("1;96", meta)}`;
  }

  if (line === "Sources:") {
    return ansi("1;30;106", " SOURCES ");
  }

  const sourceMatch = line.match(/^(\d+)\.\s+(.+?)\s+[—-]\s+(https?:\/\/\S+)$/);
  if (sourceMatch) {
    const [, index, host, url] = sourceMatch;
    return [
      ansi("1;33", `${index}.`),
      ansi("1;95", host),
      ansi("90", "—"),
      osc8(url, ansi("1;4;96", url)),
    ].join(" ");
  }

  if (line.trim() === "") return line;

  return ansi("97", linkifyUrls(line));
}

function renderSearchResult(result: any) {
  const text = result.content
    ?.filter((part: { type?: string; text?: string }) => part.type === "text")
    .map((part: { text?: string }) => part.text ?? "")
    .join("\n") ?? "";

  return new Text(text.split("\n").map(brutalistLine).join("\n"), 0, 0);
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
  model: string;
  endpoint: string;
  serviceTier: "flex" | "standard";
  sources: SourceLink[];
  sourceCount: number;
  groundingQueries: string[];
  cost: CostEstimate;
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    };
    if (serviceTier === "flex") {
      headers["X-Vertex-AI-LLM-Shared-Request-Type"] = "flex";
      headers["X-Vertex-AI-LLM-Request-Type"] = "shared";
    }
    return fetch(GEMINI_ENDPOINT(model), {
      method: "POST",
      headers,
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
  let usedServiceTier: "flex" | "standard" = flexUnavailableForSession
    ? "standard"
    : "flex";
  if (flexUnavailableForSession) {
    response = await fetchWithRetry("standard", standardTimeout);
  } else {
    try {
      response = await fetchWithRetry("flex", flexTimeout);
      usedServiceTier = "flex";
    } catch (err) {
      if (signal.aborted) throw err; // user cancelled — don't retry
      response = await fetchWithRetry("standard", standardTimeout);
      usedServiceTier = "standard";
    }
  }

  // Flex can still return a retryable error after exhausting its retries
  // (common — the Flex tier sheds load aggressively). Give standard a turn.
  if (!response.ok && RETRYABLE_STATUS.has(response.status)) {
    response = await fetchWithRetry("standard", standardTimeout);
    usedServiceTier = "standard";
  }

  // Some Vertex projects/regions don't support Flex. In that case Vertex returns
  // a non-retryable 400, but the same request is valid at the standard tier.
  if (!response.ok && usedServiceTier === "flex" && response.status === 400) {
    flexUnavailableForSession = true;
    response = await fetchWithRetry("standard", standardTimeout);
    usedServiceTier = "standard";
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
  const sources: SourceLink[] = [];
  for (const u of resolved) {
    if (seen.has(u)) continue;
    seen.add(u);
    sources.push({
      index: sources.length + 1,
      host: hostOf(u),
      url: u,
    });
  }

  const groundingQueries = candidate?.groundingMetadata?.webSearchQueries ?? [];
  const searchQueries = Math.max(
    groundingQueries.length,
    sources.length > 0 ? 1 : 0,
  );
  const cost = estimateCost({
    model,
    serviceTier: usedServiceTier,
    usage: data.usageMetadata,
    searchQueries,
  });
  const provenance = summaryLine({
    model,
    region: VERTEX_REGION,
    cost,
    sourceCount: sources.length,
    serviceTier: usedServiceTier,
  });
  const sourceLines = sources.map(
    (s) => `${s.index}. ${s.host ? s.host + " — " : ""}${s.url}`,
  );
  const text =
    sourceLines.length > 0
      ? `${provenance}\n\n${answer}\n\nSources:\n${sourceLines.join("\n")}`
      : `${provenance}\n\n${answer}`;

  return {
    text,
    model,
    endpoint: GEMINI_ENDPOINT(model),
    serviceTier: usedServiceTier,
    sources,
    sourceCount: sources.length,
    groundingQueries,
    cost,
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
            model: result.model,
            endpoint: result.endpoint,
            region: VERTEX_REGION,
            serviceTier: result.serviceTier,
            depth: "short",
            sourceCount: result.sourceCount,
            sources: result.sources,
            groundingQueries: result.groundingQueries,
            cost: result.cost,
          },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
    renderResult: renderSearchResult,
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
            model: result.model,
            endpoint: result.endpoint,
            region: VERTEX_REGION,
            serviceTier: result.serviceTier,
            depth: "long",
            sourceCount: result.sourceCount,
            sources: result.sources,
            groundingQueries: result.groundingQueries,
            cost: result.cost,
          },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
    renderResult: renderSearchResult,
  });
}
