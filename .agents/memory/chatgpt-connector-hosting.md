---
name: ChatGPT connector hosting (dev vs deployed)
description: Why ChatGPT's Bullhorn connector repeatedly shows Connect/Allow prompts and never finishes a multi-step task; dev-endpoint instability + per-call approval; deploy is the fix.
---

# ChatGPT remote-MCP connector: reconnect loops & approval prompts

Symptom: ChatGPT (AskToAct–Bullhorn connector) keeps showing a "Connect / Add to ChatGPT" screen and/or an "Allow ChatGPT to use… (Deny / Allow once / Always allow)" prompt, and a multi-step prompt never completes — user re-"connects" 5–6 times.

Two DIFFERENT prompts, often conflated:
- **"Allow once / Always allow"** = ChatGPT's per-ACTION tool consent. It re-asks for EVERY new tool call, so a ~15-call prompt feels like constant nagging. The user should click **Always allow** (once per tool), not Allow once.
- **"Connect / Add to ChatGPT"** = connector-level reachability/health check failing. ChatGPT couldn't reach the endpoint, so it falls back to the reconnect screen.

Root cause of the reconnect loop: pointing ChatGPT at the **Replit dev domain** (the dev workflow). The dev endpoint is NOT always-on — it goes offline briefly on every code rebuild/restart (`pnpm run dev` = build && start), can sleep when the workspace is idle/closed, and sits behind the dev proxy. A multi-minute task spans one of those blips → ChatGPT loses the server → reconnect.

NOT the cause: server crashes or lost MCP sessions. Logs showed every request 200 in <1s and Bullhorn re-auth automatic. The MCP transport is **stateless** (StreamableHTTPServerTransport, `sessionIdGenerator: undefined`), so there is no in-memory session to lose and **Autoscale is a safe deploy target**.

**Fix:** deploy the api-server to a stable always-on URL, then re-add the ChatGPT connector pointing at the deployed `.replit.app` URL (NOT the dev domain), and ensure MCP_BEARER_TOKEN + Bullhorn secrets are present in the deployment. Combined with "Always allow," the multi-step prompt completes in one pass.

**Why:** a dev workflow is not a production host for an external 24/7 consumer like ChatGPT; treat the connector like any external API client and give it a deployed endpoint.
**How to apply:** when a user reports the connector "keeps asking to reconnect / never finishes," check logs first (if all 200s, it's not us), then steer them to deploy + repoint the connector + Always allow.
