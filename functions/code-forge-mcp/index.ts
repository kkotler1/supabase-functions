import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// =============================================================================
// Config
// =============================================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FORGE_KEY = Deno.env.get("FORGE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// =============================================================================
// MCP Server
// =============================================================================
const server = new McpServer({
  name: "code-forge",
  version: "1.0.0",
});

// =============================================================================
// Tool: forge_submit_task
// =============================================================================
server.registerTool(
  "forge_submit_task",
  {
    title: "Submit Task",
    description:
      "Submit a new coding task for Code Forge to execute autonomously. Provide a title, detailed description with acceptance criteria, and the target repo. The task enters the queue and will be picked up by the GitHub Actions runner.",
    inputSchema: {
      title: z.string().describe("Short task name (e.g., 'Add health check endpoint')"),
      description: z
        .string()
        .describe(
          "Full requirements: what to build, constraints, acceptance criteria. Be specific — this is the agent's only instruction."
        ),
      target_repo: z
        .string()
        .describe(
          "GitHub repo identifier as registered in forge_projects (e.g., 'kkotler1/open-brain')"
        ),
      target_branch: z
        .string()
        .optional()
        .default("main")
        .describe("Base branch to work from (default: main)"),
    },
  },
  async ({ title, description, target_repo, target_branch }) => {
    const { data: project, error: projErr } = await supabase
      .from("forge_projects")
      .select("repo")
      .eq("repo", target_repo)
      .single();

    if (projErr || !project) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Project '${target_repo}' not found in registry. Register it first with forge_register_project.`,
            }),
          },
        ],
        isError: true,
      };
    }

    const { data: task, error: taskErr } = await supabase
      .from("forge_tasks")
      .insert({
        title,
        description,
        target_repo,
        target_branch: target_branch || "main",
        status: "queued",
      })
      .select()
      .single();

    if (taskErr) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to create task: ${taskErr.message}` }) },
        ],
        isError: true,
      };
    }

    // TODO Phase 2: Trigger GitHub Actions workflow_dispatch here

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            task_id: task.id,
            status: task.status,
            message: `Task '${title}' queued. GitHub Actions trigger will be wired in Phase 2.`,
          }),
        },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_get_task_status
// =============================================================================
server.registerTool(
  "forge_get_task_status",
  {
    title: "Get Task Status",
    description:
      "Check the current status of a task by its UUID. Returns full task details including status, plan, PR URL, result summary, and attempt count.",
    inputSchema: {
      task_id: z.string().describe("UUID of the task to check"),
    },
  },
  async ({ task_id }) => {
    const { data, error } = await supabase
      .from("forge_tasks")
      .select("*")
      .eq("id", task_id)
      .single();

    if (error || !data) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Task '${task_id}' not found.` }) },
        ],
        isError: true,
      };
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }
);

// =============================================================================
// Tool: forge_list_tasks
// =============================================================================
server.registerTool(
  "forge_list_tasks",
  {
    title: "List Tasks",
    description:
      "List recent tasks with optional status filter. Returns the most recent tasks ordered by creation date. Use status filter to see only queued, in-progress, or completed tasks.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status: queued, planning, coding, testing, pr_open, merged, failed. Omit for all."
        ),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Max results to return (default: 10, max: 50)"),
    },
  },
  async ({ status, limit }) => {
    const cap = Math.min(limit ?? 10, 50);

    let query = supabase
      .from("forge_tasks")
      .select("id, title, target_repo, status, pr_url, attempts, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(cap);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;

    if (error) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to list tasks: ${error.message}` }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ count: data?.length || 0, tasks: data || [] }) },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_add_correction
// =============================================================================
server.registerTool(
  "forge_add_correction",
  {
    title: "Add Correction",
    description:
      "Log a correction rule to the compounding knowledge base. Every correction makes all future tasks smarter. Can be global (no task_id) or tied to a specific task. Use category to organize rules.",
    inputSchema: {
      rule: z
        .string()
        .describe(
          "The correction as a clear, actionable instruction (e.g., 'Always validate UUID format before querying')"
        ),
      category: z
        .string()
        .optional()
        .default("general")
        .describe("One of: code_style, architecture, testing, api_usage, business_logic, general"),
      task_id: z
        .string()
        .optional()
        .describe("UUID of the task that triggered this correction (optional, omit for global rules)"),
      source: z
        .string()
        .optional()
        .default("human")
        .describe("'human' if you are logging it, 'self' if the agent caught its own mistake"),
    },
  },
  async ({ rule, category, task_id, source }) => {
    const validCategories = ["code_style", "architecture", "testing", "api_usage", "business_logic", "general"];
    const cat = category && validCategories.includes(category) ? category : "general";
    const src = source === "self" ? "self" : "human";

    const insert: Record<string, unknown> = { rule, category: cat, source: src };
    if (task_id) insert.task_id = task_id;

    const { data, error } = await supabase
      .from("forge_corrections")
      .insert(insert)
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to add correction: ${error.message}` }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            correction_id: data.id,
            rule: data.rule,
            category: data.category,
            message: "Correction logged. All future tasks will apply this rule.",
          }),
        },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_list_corrections
// =============================================================================
server.registerTool(
  "forge_list_corrections",
  {
    title: "List Corrections",
    description:
      "View correction rules in the knowledge base. Filterable by category and status. Only active corrections are injected into the agent's context on every task run.",
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe(
          "Filter by category: code_style, architecture, testing, api_usage, business_logic, general. Omit for all."
        ),
      status: z
        .string()
        .optional()
        .default("active")
        .describe("Filter by status: active, draft, archived (default: active)"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max results to return (default: 50, max: 200)"),
    },
  },
  async ({ category, status, limit }) => {
    const cap = Math.min(limit ?? 50, 200);
    const statusFilter = status ?? "active";

    let query = supabase
      .from("forge_corrections")
      .select("id, rule, category, source, task_id, status, created_at")
      .eq("status", statusFilter)
      .order("created_at", { ascending: false })
      .limit(cap);

    if (category) query = query.eq("category", category);

    const { data, error } = await query;

    if (error) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to list corrections: ${error.message}` }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ count: data?.length || 0, corrections: data || [] }) },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_register_project
// =============================================================================
server.registerTool(
  "forge_register_project",
  {
    title: "Register Project",
    description:
      "Add or update a project in the registry. Projects define what repos Code Forge can work on, including their tech stack and coding conventions.",
    inputSchema: {
      repo: z.string().describe("GitHub repo identifier (e.g., 'kkotler1/blaze-vending-site')"),
      description: z.string().describe("What this project is and does"),
      tech_stack: z.string().optional().describe("Languages, frameworks, key dependencies"),
      conventions: z
        .string()
        .optional()
        .describe("Coding standards, file structure patterns, naming conventions"),
    },
  },
  async ({ repo, description, tech_stack, conventions }) => {
    const { data, error } = await supabase
      .from("forge_projects")
      .upsert(
        {
          repo,
          description,
          tech_stack: tech_stack || null,
          conventions: conventions || null,
        },
        { onConflict: "repo" }
      )
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to register project: ${error.message}` }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            project_id: data.id,
            repo: data.repo,
            message: `Project '${repo}' registered. Code Forge can now accept tasks for this repo.`,
          }),
        },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_get_project_context
// =============================================================================
server.registerTool(
  "forge_get_project_context",
  {
    title: "Get Project Context",
    description:
      "Pull full context for a repo: description, tech stack, conventions, and all applicable corrections. This is what gets loaded into the agent's prompt before it starts coding.",
    inputSchema: {
      repo: z.string().describe("GitHub repo identifier"),
    },
  },
  async ({ repo }) => {
    const { data: project, error: projErr } = await supabase
      .from("forge_projects")
      .select("*")
      .eq("repo", repo)
      .single();

    if (projErr || !project) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Project '${repo}' not found in registry.` }) },
        ],
        isError: true,
      };
    }

    const { data: corrections, error: corrErr } = await supabase
      .from("forge_corrections")
      .select("rule, category, source")
      .eq("status", "active")
      .order("created_at", { ascending: true });

    if (corrErr) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to load corrections: ${corrErr.message}` }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            project: {
              repo: project.repo,
              description: project.description,
              tech_stack: project.tech_stack,
              conventions: project.conventions,
            },
            corrections: corrections || [],
            corrections_count: corrections?.length || 0,
            message: "This context is injected into the agent prompt before every task execution.",
          }),
        },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_log_error
// =============================================================================
server.registerTool(
  "forge_log_error",
  {
    title: "Log Error",
    description:
      "Log an error that occurred during task execution. Records which phase failed, the error message, and optional context/stack trace. Use this to build an incident history that can be reviewed and promoted to corrections.",
    inputSchema: {
      task_id: z
        .string()
        .optional()
        .describe("UUID of the task that encountered the error (optional for system-level errors)"),
      phase: z
        .string()
        .describe(
          "Which pipeline step failed: planning, coding, testing, self_eval, pr_creation, deployment, other"
        ),
      error_message: z.string().describe("Clear description of what went wrong"),
      context: z
        .string()
        .optional()
        .describe("What the agent was trying to do when the error occurred (optional)"),
      stack_trace: z.string().optional().describe("Raw error output for debugging (optional)"),
    },
  },
  async ({ task_id, phase, error_message, context, stack_trace }) => {
    const validPhases = ["planning", "coding", "testing", "self_eval", "pr_creation", "deployment", "other"];
    if (!validPhases.includes(phase)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Invalid phase '${phase}'. Must be one of: ${validPhases.join(", ")}`,
            }),
          },
        ],
        isError: true,
      };
    }

    const insert: Record<string, unknown> = { phase, error_message };
    if (task_id) insert.task_id = task_id;
    if (context) insert.context = context;
    if (stack_trace) insert.stack_trace = stack_trace;

    const { data, error } = await supabase
      .from("forge_errors")
      .insert(insert)
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to log error: ${error.message}` }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            error_id: data.id,
            phase: data.phase,
            message: "Error logged. Review during next task review and promote to correction if pattern detected.",
          }),
        },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_list_errors
// =============================================================================
server.registerTool(
  "forge_list_errors",
  {
    title: "List Errors",
    description:
      "View logged errors. Filterable by task, phase, or resolution status. Use during reviews to identify patterns worth promoting to corrections.",
    inputSchema: {
      task_id: z.string().optional().describe("Filter errors for a specific task (optional)"),
      phase: z
        .string()
        .optional()
        .describe(
          "Filter by phase: planning, coding, testing, self_eval, pr_creation, deployment, other (optional)"
        ),
      resolved: z
        .boolean()
        .optional()
        .describe(
          "Filter by resolution status. false = unresolved only, true = resolved only. Omit for all."
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Max results to return (default: 20, max: 100)"),
    },
  },
  async ({ task_id, phase, resolved, limit }) => {
    const cap = Math.min(limit ?? 20, 100);

    let query = supabase
      .from("forge_errors")
      .select("id, task_id, phase, error_message, context, resolved, correction_id, created_at")
      .order("created_at", { ascending: false })
      .limit(cap);

    if (task_id) query = query.eq("task_id", task_id);
    if (phase) query = query.eq("phase", phase);
    if (resolved !== undefined) query = query.eq("resolved", resolved);

    const { data, error } = await query;

    if (error) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to list errors: ${error.message}` }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ count: data?.length || 0, errors: data || [] }) },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_resolve_error
// =============================================================================
server.registerTool(
  "forge_resolve_error",
  {
    title: "Resolve Error",
    description:
      "Mark an error as resolved. Optionally link it to a correction rule that was extracted from this error. This closes the loop: error → review → correction → smarter agent.",
    inputSchema: {
      error_id: z.string().describe("UUID of the error to resolve"),
      correction_id: z
        .string()
        .optional()
        .describe(
          "UUID of the correction rule extracted from this error (optional — omit if no correction was needed)"
        ),
    },
  },
  async ({ error_id, correction_id }) => {
    const update: Record<string, unknown> = { resolved: true };
    if (correction_id) update.correction_id = correction_id;

    const { data, error } = await supabase
      .from("forge_errors")
      .update(update)
      .eq("id", error_id)
      .select("id, phase, error_message, resolved, correction_id")
      .single();

    if (error) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to resolve error: ${error.message}` }) },
        ],
        isError: true,
      };
    }

    if (!data) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Error '${error_id}' not found.` }) },
        ],
        isError: true,
      };
    }

    const linked = correction_id ? ` Linked to correction ${correction_id}.` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            error_id: data.id,
            message: `Error resolved.${linked} The loop is closed.`,
          }),
        },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_review_drafts
// =============================================================================
server.registerTool(
  "forge_review_drafts",
  {
    title: "Review Draft Corrections",
    description:
      "List all correction rules with status=draft awaiting review. Includes rule text, category, source, created_at, and the task_id that generated it (if any). Use forge_approve_correction to activate or reject each draft.",
    inputSchema: {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Max results to return (default: 20, max: 100)"),
    },
  },
  async ({ limit }) => {
    const cap = Math.min(limit ?? 20, 100);

    const { data, error } = await supabase
      .from("forge_corrections")
      .select("id, rule, category, source, task_id, status, created_at")
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(cap);

    if (error) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to list draft corrections: ${error.message}` }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ count: data?.length || 0, drafts: data || [] }) },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_approve_correction
// =============================================================================
server.registerTool(
  "forge_approve_correction",
  {
    title: "Approve or Reject Draft Correction",
    description:
      "Transition a draft correction to active or archived. action='activate' promotes it into the agent's live context; action='reject' archives it. Only corrections currently in draft status can be actioned.",
    inputSchema: {
      id: z.string().describe("UUID of the draft correction to action"),
      action: z
        .enum(["activate", "reject"])
        .describe("'activate' sets status=active; 'reject' sets status=archived"),
    },
  },
  async ({ id, action }) => {
    // Fetch the correction and verify it exists and is in draft status
    const { data: existing, error: fetchErr } = await supabase
      .from("forge_corrections")
      .select("id, rule, category, source, task_id, status, created_at")
      .eq("id", id)
      .single();

    if (fetchErr || !existing) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Correction '${id}' not found.` }) },
        ],
        isError: true,
      };
    }

    if (existing.status !== "draft") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Correction '${id}' is not in draft status (current status: '${existing.status}'). Only draft corrections can be activated or rejected.`,
            }),
          },
        ],
        isError: true,
      };
    }

    const newStatus = action === "activate" ? "active" : "archived";

    const { data: updated, error: updateErr } = await supabase
      .from("forge_corrections")
      .update({ status: newStatus })
      .eq("id", id)
      .select("id, rule, category, source, task_id, status, created_at")
      .single();

    if (updateErr) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to update correction: ${updateErr.message}` }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            correction: updated,
            message:
              action === "activate"
                ? "Correction activated. It will now be injected into all future agent task contexts."
                : "Correction rejected and archived. It will not be injected into agent context.",
          }),
        },
      ],
    };
  }
);

// =============================================================================
// Tool: forge_auto_promote
// =============================================================================
server.registerTool(
  "forge_auto_promote",
  {
    title: "Auto-Promote Error Patterns to Draft Corrections",
    description:
      "Scans unresolved errors in forge_errors for recurring patterns (same error_message appearing 2+ times across different task_ids). Creates a draft correction for each new pattern found. Skips patterns already covered by an active or draft correction.",
    inputSchema: {},
  },
  async () => {
    // Fetch all unresolved errors that have a task_id
    const { data: errors, error: fetchErr } = await supabase
      .from("forge_errors")
      .select("id, task_id, error_message")
      .eq("resolved", false)
      .not("task_id", "is", null);

    if (fetchErr) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to fetch errors: ${fetchErr.message}` }) },
        ],
        isError: true,
      };
    }

    // Group by error_message and collect distinct task_ids
    const patterns = new Map<string, Set<string>>();
    for (const err of errors ?? []) {
      if (!err.task_id) continue;
      if (!patterns.has(err.error_message)) {
        patterns.set(err.error_message, new Set());
      }
      patterns.get(err.error_message)!.add(err.task_id);
    }

    // Retain only patterns appearing across 2+ distinct task_ids
    const recurringPatterns: string[] = [];
    for (const [errorMessage, taskIds] of patterns.entries()) {
      if (taskIds.size >= 2) {
        recurringPatterns.push(errorMessage);
      }
    }

    if (recurringPatterns.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              new_drafts: 0,
              message: "No recurring error patterns detected across multiple tasks.",
            }),
          },
        ],
      };
    }

    // Fetch all existing active/draft corrections to check for duplicates
    const { data: existingCorrections, error: corrFetchErr } = await supabase
      .from("forge_corrections")
      .select("id, rule")
      .in("status", ["active", "draft"]);

    if (corrFetchErr) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Failed to fetch existing corrections: ${corrFetchErr.message}` }) },
        ],
        isError: true,
      };
    }

    let newDrafts = 0;
    const createdPatterns: string[] = [];

    for (const errorMessage of recurringPatterns) {
      // Check if an existing active/draft correction already covers this error pattern
      // (exact substring match: error_message appears in any existing rule)
      const alreadyCovered = (existingCorrections ?? []).some(
        (c) => c.rule.includes(errorMessage) || errorMessage.includes(c.rule)
      );

      if (alreadyCovered) continue;

      const rule = `Recurring error pattern detected across multiple tasks: "${errorMessage}". This error has been observed in 2 or more distinct task executions. Investigate the root cause and add a specific correction to prevent recurrence.`;

      const { error: insertErr } = await supabase.from("forge_corrections").insert({
        rule,
        category: "general",
        source: "auto",
        status: "draft",
      });

      if (!insertErr) {
        newDrafts++;
        createdPatterns.push(errorMessage);
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            new_drafts: newDrafts,
            patterns_scanned: recurringPatterns.length,
            patterns_promoted: createdPatterns,
            message:
              newDrafts > 0
                ? `${newDrafts} draft correction(s) created. Use forge_review_drafts to inspect and forge_approve_correction to activate or reject each one.`
                : "All recurring patterns are already covered by existing corrections. No new drafts created.",
          }),
        },
      ],
    };
  }
);

// =============================================================================
// Hono App with Auth Check
// =============================================================================
const app = new Hono();

app.all("*", async (c) => {
  const provided = c.req.header("x-forge-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== FORGE_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
