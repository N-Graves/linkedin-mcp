# linkedin-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server for LinkedIn's **official** OpenID Connect + Posts API — no scraping, no stealth browser, no session-cookie automation.

## Why this exists

Every pre-built LinkedIn MCP server found at the time this was built was either an explicit "stealth-browser" scraper (automating a real logged-in browser session specifically to evade LinkedIn's own bot detection — against their ToS, and a real account-ban risk since there's no sandbox to test against), a precompiled binary with no visible source at all, or an unlicensed package with no repository. None of those are acceptable when you already have real, working OAuth credentials — an API token is narrow and revocable from a dashboard in seconds; a scraped session is closer to full account access and, if the server holding it is buggy or malicious, has a much larger blast radius.

This wraps LinkedIn's real, documented API instead. ~90 lines of code you can read in five minutes.

## Setup

```bash
npm install
npm run build
```

Requires a LinkedIn access token with the `w_member_social` scope (for posting) and `openid profile email` (for reading your profile). The fastest way to get one for personal/testing use is LinkedIn's own [OAuth Token Generator](https://www.linkedin.com/developers/tools/oauth) in your app's developer console — no redirect-URI OAuth flow needed for a quick start. Note: tokens from that tool are short-lived (~60 days) with no refresh token; for a long-running production integration, implement LinkedIn's full 3-legged OAuth flow instead.

### Configuration

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "node",
      "args": ["/path/to/linkedin-mcp/dist/index.js"],
      "env": {
        "LINKEDIN_ACCESS_TOKEN": "<your-access-token>"
      }
    }
  }
}
```

## Available tools

| Tool | Description |
|---|---|
| `linkedin_get_profile` | Get the authenticated user's basic profile (safe, read-only) |
| `linkedin_create_post` | Publish a real, **immediately-live** post via LinkedIn's Posts API |

## ⚠️ No draft state

LinkedIn's Posts API has no draft/unpublished lifecycle — `lifecycleState` only supports `PUBLISHED`. Calling `linkedin_create_post` makes the post live on LinkedIn immediately, with no undo. If you want a human-review step before anything goes public, that has to happen entirely on your side, *before* this tool is ever called — this server cannot enforce that for you.

## Security model: `agent_id` capability gating

Built for a multi-agent fleet where several AI agents share one MCP process, and the underlying platform doesn't propagate per-agent caller identity down to MCP tool calls. `linkedin_create_post` **requires an `agent_id` argument**, verified against an external authorization endpoint (`FLEET_BOARD_URL`, default `http://127.0.0.1:8420`) before it does anything.

**Honest limitation:** `agent_id` is self-reported by the caller, not cryptographically bound by the MCP protocol. This turns a *silent* wrong-agent action into a *loud, rejected, auditable* one — it does not stop a determined malicious actor from lying about its own identity.

Running standalone? Either stand up a minimal service at `FLEET_BOARD_URL` returning a JSON array of capability strings for `GET /agents/{id}/capabilities`, or remove the single `checkCapability` call in `src/index.ts`.

## Notes on safety

- Every request goes to `api.linkedin.com` only — no telemetry, no third-party calls, no dynamic code execution, no browser automation.

## License

MIT — see [LICENSE](LICENSE).
