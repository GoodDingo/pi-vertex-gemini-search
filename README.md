# pi-vertex-gemini-search

Web search & research tools for the [Pi coding agent](https://github.com/earendil-works/pi), backed by **Vertex AI Gemini** with Google Search grounding.

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
- Prefix results with Vertex AI provenance and an estimated per-query cost.

## Vertex AI authentication

Authentication order:

1. `VERTEX_ACCESS_TOKEN` environment variable, if set
2. `gcloud auth print-access-token`

Run this first if needed:

```bash
gcloud auth login
```

## Configuration

Defaults:

- `VERTEX_PROJECT_ID=rd-aise-prod766-dev`
- `VERTEX_REGION=eu`
- `GEMINI_MODEL_SHORT=gemini-3.1-flash-lite`
- `GEMINI_MODEL_LONG=gemini-3.5-flash`

Override with environment variables before starting `pi`.

## Cost estimate configuration

Each result includes an estimated cost line. Defaults:

- `GEMINI_SEARCH_GROUNDING_USD_PER_1000=14`
- `USD_TO_EUR=0.93`
- `VERTEX_FLEX_TOKEN_DISCOUNT=0.5`

The estimate uses response token counts from Vertex AI. Flex is attempted first via the Vertex AI Flex PayGo headers; if the project/region does not support Flex, the extension falls back to standard tier and marks the result as `standard tier`.

## Install locally

From this checkout:

```bash
pi install /Users/A200048/GitLab/pi-vertex-gemini-search
```

## License

MIT
