// ============================================================
// OPEN WELLNESS — Edge Function Entry Point
// Hono app serving:
//   - MCP protocol via wildcard route (Claude.ai, Claude Code)
//   - Slack Events API via POST /slack
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";

import { LOG_WELLNESS_TOOL, handleLogWellness } from "./tools/log-wellness.ts";
import { WELLNESS_STATUS_TOOL, handleWellnessStatus } from "./tools/wellness-status.ts";
import { WELLNESS_QUERY_TOOL, handleWellnessQuery } from "./tools/wellness-query.ts";
import { RESOLVE_FOOD_TOOL, handleResolveFood } from "./tools/resolve-food.ts";
import { verifySlackSignature, processWellnessSlackMessage } from "./slack/handler.ts";

const app = new Hono();

// --- Auth Middleware for MCP routes ---

function checkAuth(req: Request): boolean {
  const key = Deno.env.get("MCP_ACCESS_KEY");
  if (!key) return true; // No key set = open (dev mode)

  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key");
  const headerKey = req.headers.get("x-brain-key");

  return queryKey === key || headerKey === key;
}

// --- MCP Server Setup (singleton, matches open-brain-mcp pattern) ---

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "open-wellness",
    version: "1.0.0",
  });

  server.registerTool(
    LOG_WELLNESS_TOOL.name,
    {
      title: "Log Wellness",
      description: LOG_WELLNESS_TOOL.description,
      inputSchema: {
        content: z.string().describe("Freeform text describing wellness data — meals, sleep, symptoms, supplements, habits, etc."),
        date: z.string().optional().describe("ISO date override (YYYY-MM-DD). Defaults to today."),
        timezone: z.string().optional().describe("Timezone for date calculation. Defaults to America/New_York."),
      },
    },
    async (args) => handleLogWellness(args)
  );

  server.registerTool(
    WELLNESS_STATUS_TOOL.name,
    {
      title: "Wellness Status",
      description: WELLNESS_STATUS_TOOL.description,
      inputSchema: {
        timezone: z.string().optional().describe("Timezone for date calculation. Defaults to America/New_York."),
      },
    },
    async (args) => handleWellnessStatus(args)
  );

  server.registerTool(
    WELLNESS_QUERY_TOOL.name,
    {
      title: "Wellness Query",
      description: WELLNESS_QUERY_TOOL.description,
      inputSchema: {
        category: z.enum(["meals", "sleep", "supplements", "symptoms", "habits", "hydration", "workouts", "bathroom", "all"]).describe("Which data category to query. Use 'all' for a complete day summary."),
        days_back: z.number().optional().describe("How many days to look back. Default 7."),
        date: z.string().optional().describe("Specific date (YYYY-MM-DD) to query. Overrides days_back."),
        metric: z.string().optional().describe("For symptoms: filter by specific metric (energy, focus, mood, etc.)"),
      },
    },
    async (args) => handleWellnessQuery(args)
  );

  server.registerTool(
    RESOLVE_FOOD_TOOL.name,
    {
      title: "Resolve Food",
      description: RESOLVE_FOOD_TOOL.description,
      inputSchema: {
        food_name: z.string().describe("Food to look up, correct, or re-resolve."),
        action: z.enum(["lookup", "correct", "re_resolve", "list_catalog", "list_unverified"]).optional().describe("Action to perform. Default: lookup."),
        corrections: z.record(z.string(), z.unknown()).optional().describe("For 'correct' action — fields to override (calories, protein_g, carbs_g, fat_g, etc.)."),
      },
    },
    async (args) => handleResolveFood(args)
  );

  return server;
}

// Singleton — created once at module load, same pattern as open-brain-mcp.
// Per-request server creation causes the MCP SDK to re-register handlers on
// every connect() call, which breaks the transport's initialization state.
const mcpServer = createMcpServer();

// --- All Routes (wildcard — Supabase passes full URL path so specific routes don't match) ---

app.all("*", async (c) => {
  const url = new URL(c.req.url);

  // Route: Slack events
  if (url.pathname.endsWith("/slack")) {
    if (c.req.method !== "POST") {
      return c.json({ error: "method not allowed" }, 405);
    }

    const rawBody = await c.req.text();
    const body = JSON.parse(rawBody);

    // URL verification handshake
    if (body.type === "url_verification") {
      return c.json({ challenge: body.challenge });
    }

    // Dedup retries
    const retryNum = c.req.header("X-Slack-Retry-Num");
    if (retryNum && parseInt(retryNum) > 0) {
      return c.json({ ok: true });
    }

    // Verify Slack signature
    const timestamp = c.req.header("X-Slack-Request-Timestamp") || "";
    const signature = c.req.header("X-Slack-Signature") || "";
    const valid = await verifySlackSignature(rawBody, timestamp, signature);
    if (!valid) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const event = body.event;

    if (!event || event.type !== "message" || event.bot_id || event.subtype) {
      return c.json({ ok: true });
    }

    const wellnessChannel = Deno.env.get("SLACK_WELLNESS_CHANNEL");
    if (wellnessChannel && event.channel !== wellnessChannel) {
      return c.json({ ok: true });
    }

    const text = event.text || "";
    const channel = event.channel;
    const ts = event.ts;

    // Use waitUntil so the function stays alive for the full pipeline
    // (domain inserts + food resolution) even after responding to Slack.
    // Without this, the edge function tears down after the response and
    // kills any in-flight async work.
    const processingPromise = processWellnessSlackMessage(text, channel, ts).catch((err) => {
      console.error("Async Slack processing error:", err);
    });
    EdgeRuntime.waitUntil(processingPromise);

    return c.json({ ok: true });
  }

  // Route: MCP (everything else)
  if (!checkAuth(c.req.raw)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await mcpServer.connect(transport);
  return transport.handleRequest(c);
});

// --- Serve ---

Deno.serve(app.fetch);
