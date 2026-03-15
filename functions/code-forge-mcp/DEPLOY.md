# Code Forge — Deployment Guide

## Prerequisites
- Supabase CLI installed and linked to project `vwcwfzphjuvtsqlmkhvd`
- Access to Supabase Dashboard (SQL Editor)

---

## Step 1: Run the SQL Migration

Open Supabase Dashboard → SQL Editor → New Query
Paste the contents of `migration.sql` and run.

This creates:
- `forge_projects` (with Open Brain repo seeded)
- `forge_tasks`
- `forge_corrections` (with 10 baseline rules seeded)
- Auto-update triggers for `updated_at`
- Indexes for common queries

**Verify:** Run `SELECT * FROM forge_projects;` — you should see the Open Brain entry.
Run `SELECT count(*) FROM forge_corrections;` — should return 10.

---

## Step 2: Set the FORGE_KEY Secret

Generate a key (or reuse a pattern you like):
```bash
openssl rand -hex 32
```

Set it in Supabase:
```bash
supabase secrets set FORGE_KEY=your_generated_key_here
```

---

## Step 3: Create the Edge Function

From your Supabase project root:
```bash
supabase functions new code-forge-mcp
```

Replace the generated `index.ts` with the one from this directory.

---

## Step 4: Deploy
```bash
supabase functions deploy code-forge-mcp --no-verify-jwt
```

The `--no-verify-jwt` flag is needed because we handle auth ourselves via `x-forge-key` (same pattern as Open Brain).

---

## Step 5: Test the Health Check
```bash
curl https://vwcwfzphjuvtsqlmkhvd.supabase.co/functions/v1/code-forge-mcp
```

Expected: `{"status":"ok","server":"code-forge-mcp","version":"1.0.0"}`

---

## Step 6: Test MCP Tools/List
```bash
curl -X POST https://vwcwfzphjuvtsqlmkhvd.supabase.co/functions/v1/code-forge-mcp?key=YOUR_FORGE_KEY \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected: JSON with all 7 tools listed.

---

## Step 7: Test a Tool Call
```bash
curl -X POST https://vwcwfzphjuvtsqlmkhvd.supabase.co/functions/v1/code-forge-mcp?key=YOUR_FORGE_KEY \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"forge_list_corrections","arguments":{}}}'
```

Expected: JSON with your 10 seeded corrections.

---

## Step 8: Connect to Claude as MCP Server

In Claude.ai → Settings → Connectors → Add MCP Server

- **Name:** Code Forge
- **URL:** `https://vwcwfzphjuvtsqlmkhvd.supabase.co/functions/v1/code-forge-mcp?key=YOUR_FORGE_KEY`

Once connected, you can talk to Code Forge directly in Claude conversations.

---

## Step 9: Verify Open Brain Integration

From a Claude conversation with both MCP servers connected:

- "Search Open Brain for my recent tasks" → uses Open Brain
- "Submit a Code Forge task to add a README to the Open Brain repo" → uses Code Forge
- "What corrections does Code Forge have?" → uses Code Forge

Both servers work side by side, sharing the same Supabase project.

---

## What's Next (Phase 2)

Phase 1 gives you the brain — task queue, corrections, project registry, and MCP access.
Phase 2 adds the hands — GitHub Actions workflow that actually executes tasks.

When you're ready for Phase 2, you'll need:
1. Your GitHub PAT as a GitHub Actions secret
2. Your ANTHROPIC_API_KEY as a GitHub Actions secret
3. Your SUPABASE_URL + FORGE_KEY as GitHub Actions secrets
4. A `forge-runner` repo with the workflow YAML
