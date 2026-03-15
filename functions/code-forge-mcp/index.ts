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
      "View all correction rules in the knowledge base. Filterable by category. These rules are injected into the agent's context on every task run.",
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe(
          "Filter by category: code_style, architecture, testing, api_usage, business_logic, general. Omit for all."
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max results to return (default: 50, max: 200)"),
    },
  },
  async ({ category, limit }) => {
    const cap = Math.min(limit ?? 50, 200);

    let query = supabase
      .from("forge_corrections")
      .select("id, rule, category, source, task_id, created_at")
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
