# @nilskluewer/pi-vertex-gemini-search

Web search & research tools for the [Pi coding agent](https://pi.dev/), backed by **Vertex AI Gemini** with Google Search grounding and Google Cloud Agent Platform credentials.

This is a Vertex AI variant of the Gemini search extension. It does **not** use a Gemini API key.

## Tools

Registers two tools the model can call:

- **`web_search`** — quick fact-check / verification. Returns a concise synthesized answer + source URLs.
- **`web_research`** — in-depth research on complex topics. Returns a structured answer + source URLs.

Both tools:

- Ground answers with Google Search.
- Can read specific URLs passed in the query via Gemini `url_context`.
- Resolve Gemini `vertexaisearch.cloud.google.com` redirect links to clean destination URLs.
- Render source URLs as OSC-8 terminal hyperlinks in the Pi TUI when supported by your terminal.
- Prefix results with a compact, brutalist high-contrast Vertex AI provenance/cost summary in Pi TUI.

## Vertex AI authentication

Authentication order:

1. `VERTEX_ACCESS_TOKEN` environment variable, if set
2. `gcloud auth print-access-token`

Run this first if needed:

```bash
gcloud auth login
```

## Configuration

Required:

- `VERTEX_PROJECT_ID` — your Google Cloud project ID with Vertex AI enabled.

Defaults:

- `VERTEX_REGION=eu`
- `GEMINI_MODEL_SHORT=gemini-3.1-flash-lite`
- `GEMINI_MODEL_LONG=gemini-3.5-flash`

Set or override these environment variables before starting `pi`.

## Cost estimate configuration

Each result includes a compact estimated cost summary, for example:

```text
◆ Gemini Search [gemini-3.1-flash-lite, eu, €0.0131/$0.0141, 2 sources, standard pricing]
```

Defaults:

- `GEMINI_SEARCH_GROUNDING_USD_PER_1000=14`
- `USD_TO_EUR=0.93`
- `VERTEX_FLEX_TOKEN_DISCOUNT=0.5`

The estimate uses response token counts from Vertex AI. Flex is attempted first via the Vertex AI Flex PayGo headers; if the project/region does not support Flex, the extension falls back to standard tier and marks the result as `standard tier`.

## Install

From npm:

```bash
pi install npm:@nilskluewer/pi-vertex-gemini-search
```

From a local checkout:

```bash
pi install /path/to/pi-vertex-gemini-search
```

## License

MIT
