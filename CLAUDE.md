# CLAUDE.md — supabase-functions

This repo holds all Kyle's Supabase Edge Functions: Open Brain, Open Wellness, ingest-thought, and supporting infrastructure.

Claude Code auto-loads this file on every session in this repo. The rules below encode hard-won lessons from production incidents. Read them before writing or modifying functions in this repo.

---

## Repo structure

- Functions live at `functions/<name>/index.ts` at the repo root (not under `supabase/functions/`).
- If the Supabase CLI in CI complains about structure, create a `supabase/` directory with a symlink to `functions/` so the CLI finds the expected layout. **Do not use `--entrypoint-path` — that flag does not exist in current CLI versions.**

---

## verify_jwt and webhook-receiving functions

This has caused silent breakage multiple times. Read carefully.

- **`config.toml` is the source of truth for `verify_jwt`.** The `--no-verify-jwt` CLI flag is temporary and gets overwritten on the next deploy.
- **Every function that receives external webhooks (Slack, Stripe, GitHub, etc.) must have `verify_jwt = false` set permanently in `config.toml`.** Without this, Supabase's gateway rejects webhook requests with 401 before they reach your code.
- **Before redeploying any function, check `config.toml` to ensure webhook-receiving functions still have `verify_jwt = false`.**
- **Always commit `config.toml` changes in the SAME commit as the function code changes.** If they're in separate commits, GitHub Actions auto-deploy may fire on the code change while `config.toml` still has `verify_jwt = true`, causing the gateway to reject webhooks. This can trigger Slack's automatic event subscription suspension, which persists even after the function is fixed and requires manual re-verification in Slack app settings.
- **If a function handles its own auth** (custom key validation via `?key=` param or `x-forge-key` header), deploy with `--no-verify-jwt` AND set `verify_jwt = false` in `config.toml` for persistence.

## Async work after returning a response

- **Never use fire-and-forget promises for async work after returning an HTTP response.** The runtime terminates as soon as the response is sent, killing any in-flight work.
- **Use `EdgeRuntime.waitUntil(promise)` to keep the function alive until async processing completes.** Critical for Slack handlers that must respond within 3 seconds but need to do heavy processing (LLM calls, database inserts, API requests) after the response.

## CORS

- **Every Edge Function must handle CORS preflight (OPTIONS) requests explicitly.**

---

## Hono patterns

- **Register public routes (health checks, CORS preflight, webhook receivers) BEFORE auth middleware.** Hono processes middleware in registration order — any route added after `app.use()` auth will require authentication.
- **Use `c.req.json()` for POST body parsing, not `c.req.body`.**

---

## MCP server patterns

- **Create the `McpServer` as a module-level singleton (once at load time), not per-request.** Each incoming request should get a fresh `StreamableHTTPTransport` but connect to the same server instance. Creating a new `McpServer` per request causes initialization race conditions with the SDK's handler registration. This is the pattern used by `open-brain-mcp` and must be followed by all MCP functions in this repo.
- **Zod v4 gotcha:** `z.record()` requires two arguments: `z.record(keySchema, valueSchema)`. Using `z.record(z.unknown())` like Zod v3 silently breaks — v4 treats the single argument as the key schema, leaving `valueType` undefined, which crashes when the MCP SDK iterates tool schemas and accesses `._zod` on undefined. Always use `z.record(z.string(), z.unknown())` explicitly.

---

## Secrets and environment

- **`Deno.env.get()` takes the variable NAME as a string**, not the literal value. Double-check every reference.
- **Edge Functions only get `SUPABASE_URL` and `SUPABASE_ANON_KEY` as automatic env vars.** `SUPABASE_SERVICE_ROLE_KEY` is NOT auto-injected — set it manually via `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...` before deploying any function that needs it.
- **When using the Supabase client in Edge Functions, pass the service_role key, not the anon key**, for full table access.
- **Supabase blocks custom secrets with the `SUPABASE_` prefix in the dashboard UI.** To set reserved-prefix secrets like `SUPABASE_SERVICE_ROLE_KEY`, use the CLI: `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...`. The CLI bypasses this restriction.
- **The CLI also blocks `SUPABASE_` prefix for arbitrary custom secrets.** For custom keys, use a non-reserved name like `SERVICE_ROLE_KEY` instead.
- **Reuse existing secret names rather than inventing new ones.** Run `supabase secrets list` to see what's already set. E.g., Open Brain uses `MCP_ACCESS_KEY`, not `BRAIN_KEY`. Supabase secrets are write-only — you cannot read back plaintext values, so inventing a new name silently creates duplication.
- **Save secrets to a password manager BEFORE running `supabase secrets set`.** `supabase secrets list` shows SHA-256 digests, not plaintext. Once set, the original value is unrecoverable from Supabase. This applies to every key: `FORGE_KEY`, `MCP_ACCESS_KEY`, `OPENROUTER_API_KEY`, `SLACK_BOT_TOKEN`, etc.
- **A 64-character hex string from `supabase secrets list` is always a SHA-256 digest, NOT the original key** — even though `openssl rand -hex 32` also produces 64 hex characters. If the plaintext is lost, the only fix is rotation: generate new key → `supabase secrets set` → redeploy function → update all connector URLs (Claude.ai, Claude Code CLI, webhook endpoints).

---

## CI/CD

- **Use `supabase/setup-cli@v1` for installing the CLI in GitHub Actions.** Do NOT use `npm install -g supabase` — the official action is faster, cached, and doesn't depend on Node version.
- **`SUPABASE_ACCESS_TOKEN` for CI/CD must be a personal access token starting with `sbp_...`** (from Supabase dashboard → Account Settings → Access Tokens). It is NOT the same as `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY`.
- **GitHub PATs pushing repos that contain `.github/workflows/` files must include the `workflow` scope** (classic tokens) or Actions read/write permission (fine-grained tokens). Without it, GitHub rejects the push entirely — even if Contents write is granted.

---

## Slack integration (Open Brain, Code Forge, others)

- **Reinstalling a Slack app generates a new Bot User OAuth Token (`xoxb-...`).** The old token stored in Supabase secrets becomes immediately invalid. After ANY Slack app reinstall: update `SLACK_BOT_TOKEN` in Supabase secrets with the new token AND redeploy the affected function.

---

## Cron / scheduled scripts

- **When deploying any cron-based or scheduled script:**
  1. Add a `FileHandler` to logging alongside `StreamableHTTPTransport`
  2. Save structured run output as dated JSON files in a `runs/` subdirectory for dashboard consumption
  3. Install the cron job as part of deployment — not as a separate follow-up step
  4. Verify deployment with a test run and confirm log file creation

---

## Postgres / schema

- **Never use expressions (`COALESCE`, `LOWER`, function calls) inside a `UNIQUE` table constraint.** Table constraints only accept bare column names. To create a unique constraint on an expression, use `CREATE UNIQUE INDEX` instead. Example: instead of `UNIQUE(name, COALESCE(brand, ''))`, use `CREATE UNIQUE INDEX idx_name ON table (name, COALESCE(brand, ''));`.

---

## Open Wellness business logic

(Open Wellness lives in this repo as `functions/open-brain-wellness/`.)

- **`quantity` always means NUMBER OF SERVINGS**, never weight in grams. When a user says "single serving 150g" or "30g protein drink," the gram value describes the product (serving size or nutrient content), not how many were consumed. The parser must output `quantity: 1, unit: "serving"`.
- **Safety clamp in the food resolver:** if multiplying per-serving calories by quantity exceeds 3000, cap the multiplier at 1 and log a warning.
- **If unit is `g` or `ml`,** divide by the catalog's `serving_size` to compute the correct ratio instead of raw multiplication.
- **Composite restaurant meals must be decomposed into components** (e.g., "Chipotle bowl with chicken, rice, beans, sour cream, cheese, salsa, fajita veggies"). Resolve each component's macros separately using the restaurant's published nutrition data, then sum for the total. Do NOT attempt to resolve a composite as a single item. Major chains (Chipotle, McDonald's, Wendy's, Dunkin', etc.) publish per-component nutrition — use as source of truth. Store the composite total as the catalog entry but preserve the component breakdown in metadata where possible.
