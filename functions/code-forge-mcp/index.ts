import { Hono } from "https://deno.land/x/hono@v4.3.11/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const app = new Hono();

// =============================================================================
// Config
// =============================================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FORGE_KEY = Deno.env.get("FORGE_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// =============================================================================
// Auth
// =============================================================================
function authenticate(req: Request, query: URLSearchParams): boolean {
  if (!FORGE_KEY) return true;
  const headerKey = req.headers.get("x-forge-key");
  const queryKey = query.get("key");
  return headerKey === FORGE_KEY || queryKey === FORGE_KEY;
}

// =============================================================================
// Tool Definitions
// =============================================================================
const TOOLS = [
  {
    name: "forge_submit_task",
    description:
      "Submit a new coding task for Code Forge to execute autonomously. Provide a title, detailed description with acceptance criteria, and the target repo. The task enters the queue and will be picked up by the GitHub Actions runner.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task name (e.g., 'Add health check endpoint')" },
        description: {
          type: "string",
          description:
            "Full requirements: what to build, constraints, acceptance criteria. Be specific — this is the agent's only instruction.",
        },
        target_repo: {
          type: "string",
          description: "GitHub repo identifier as registered in forge_projects (e.g., 'kylekotler/open-brain')",
        },
        target_branch: {
          type: "string",
          description: "Base branch to work from (default: main)",
          default: "main",
        },
      },
      required: ["title", "description", "target_repo"],
    },
  },
  {
    name: "forge_get_task_status",
    description: "Check the current status of a task by its UUID. Returns full task details including status, plan, PR URL, result summary, and attempt count.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "UUID of the task to check" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "forge_list_tasks",
    description:
      "List recent tasks with optional status filter. Returns the most recent tasks ordered by creation date. Use status filter to see only queued, in-progress, or completed tasks.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status: queued, planning, coding, testing, pr_open, merged, failed. Omit for all.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 10, max: 50)",
          default: 10,
        },
      },
    },
  },
  {
    name: "forge_add_correction",
    description:
      "Log a correction rule to the compounding knowledge base. Every correction makes all future tasks smarter. Can be global (no task_id) or tied to a specific task. Use category to organize rules.",
    inputSchema: {
      type: "object",
      properties: {
        rule: {
          type: "string",
          description: "The correction as a clear, actionable instruction (e.g., 'Always validate UUID format before querying')",
        },
        category: {
          type: "string",
          description: "One of: code_style, architecture, testing, api_usage, business_logic, general",
          default: "general",
        },
        task_id: {
          type: "string",
          description: "UUID of the task that triggered this correction (optional, omit for global rules)",
        },
        source: {
          type: "string",
          description: "'human' if you are logging it, 'self' if the agent caught its own mistake",
          default: "human",
        },
      },
      required: ["rule"],
    },
  },
  {
    name: "forge_list_corrections",
    description:
      "View all correction rules in the knowledge base. Filterable by category. These rules are injected into the agent's context on every task run.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category: code_style, architecture, testing, api_usage, business_logic, general. Omit for all.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 50, max: 200)",
          default: 50,
        },
      },
    },
  },
  {
    name: "forge_register_project",
    description:
      "Add or update a project in the registry. Projects define what repos Code Forge can work on, including their tech stack and coding conventions.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "GitHub repo identifier (e.g., 'kylekotler/blaze-vending-site')" },
        description: { type: "string", description: "What this project is and does" },
        tech_stack: { type: "string", description: "Languages, frameworks, key dependencies" },
        conventions: { type: "string", description: "Coding standards, file structure patterns, naming conventions" },
      },
      required: ["repo", "description"],
    },
  },
  {
    name: "forge_get_project_context",
    description:
      "Pull full context for a repo: description, tech stack, conventions, and all applicable corrections. This is what gets loaded into the agent's prompt before it starts coding.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "GitHub repo identifier" },
      },
      required: ["repo"],
    },
  },
];

// =============================================================================
// Tool Handlers
// =============================================================================
async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "forge_submit_task":
      return await submitTask(args);
    case "forge_get_task_status":
      return await getTaskStatus(args);
    case "forge_list_tasks":
      return await listTasks(args);
    case "forge_add_correction":
      return await addCorrection(args);
    case "forge_list_corrections":
      return await listCorrections(args);
    case "forge_register_project":
      return await registerProject(args);
    case "forge_get_project_context":
      return await getProjectContext(args);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function submitTask(args: Record<string, unknown>): Promise<string> {
  const { title, description, target_repo, target_branch } = args as {
    title: string;
    description: string;
    target_repo: string;
    target_branch?: string;
  };

  const { data: project, error: projErr } = await supabase
    .from("forge_projects")
    .select("repo")
    .eq("repo", target_repo)
    .single();

  if (projErr || !project) {
    return JSON.stringify({
      error: `Project '${target_repo}' not found in registry. Register it first with forge_register_project.`,
    });
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
    return JSON.stringify({ error: `Failed to create task: ${taskErr.message}` });
  }

  return JSON.stringify({
    success: true,
    task_id: task.id,
    status: task.status,
    message: `Task '${title}' queued. GitHub Actions trigger will be wired in Phase 2.`,
  });
}

async function getTaskStatus(args: Record<string, unknown>): Promise<string> {
  const { task_id } = args as { task_id: string };

  const { data, error } = await supabase
    .from("forge_tasks")
    .select("*")
    .eq("id", task_id)
    .single();

  if (error || !data) {
    return JSON.stringify({ error: `Task '${task_id}' not found.` });
  }

  return JSON.stringify(data);
}

async function listTasks(args: Record<string, unknown>): Promise<string> {
  const status = args.status as string | undefined;
  const limit = Math.min((args.limit as number) || 10, 50);

  let query = supabase
    .from("forge_tasks")
    .select("id, title, target_repo, status, pr_url, attempts, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    return JSON.stringify({ error: `Failed to list tasks: ${error.message}` });
  }

  return JSON.stringify({ count: data?.length || 0, tasks: data || [] });
}

async function addCorrection(args: Record<string, unknown>): Promise<string> {
  const { rule, category, task_id, source } = args as {
    rule: string;
    category?: string;
    task_id?: string;
    source?: string;
  };

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
    return JSON.stringify({ error: `Failed to add correction: ${error.message}` });
  }

  return JSON.stringify({
    success: true,
    correction_id: data.id,
    rule: data.rule,
    category: data.category,
    message: "Correction logged. All future tasks will apply this rule.",
  });
}

async function listCorrections(args: Record<string, unknown>): Promise<string> {
  const category = args.category as string | undefined;
  const limit = Math.min((args.limit as number) || 50, 200);

  let query = supabase
    .from("forge_corrections")
    .select("id, rule, category, source, task_id, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;

  if (error) {
    return JSON.stringify({ error: `Failed to list corrections: ${error.message}` });
  }

  return JSON.stringify({ count: data?.length || 0, corrections: data || [] });
}

async function registerProject(args: Record<string, unknown>): Promise<string> {
  const { repo, description, tech_stack, conventions } = args as {
    repo: string;
    description: string;
    tech_stack?: string;
    conventions?: string;
  };

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
    return JSON.stringify({ error: `Failed to register project: ${error.message}` });
  }

  return JSON.stringify({
    success: true,
    project_id: data.id,
    repo: data.repo,
    message: `Project '${repo}' registered. Code Forge can now accept tasks for this repo.`,
  });
}

async function getProjectContext(args: Record<string, unknown>): Promise<string> {
  const { repo } = args as { repo: string };

  const { data: project, error: projErr } = await supabase
    .from("forge_projects")
    .select("*")
    .eq("repo", repo)
    .single();

  if (projErr || !project) {
    return JSON.stringify({ error: `Project '${repo}' not found in registry.` });
  }

  const { data: corrections, error: corrErr } = await supabase
    .from("forge_corrections")
    .select("rule, category, source")
    .order("created_at", { ascending: true });

  if (corrErr) {
    return JSON.stringify({ error: `Failed to load corrections: ${corrErr.message}` });
  }

  return JSON.stringify({
    project: {
      repo: project.repo,
      description: project.description,
      tech_stack: project.tech_stack,
      conventions: project.conventions,
    },
    corrections: corrections || [],
    corrections_count: corrections?.length || 0,
    message: "This context is injected into the agent prompt before every task execution.",
  });
}

// =============================================================================
// MCP Protocol Handler
// =============================================================================
function handleMCPRequest(method: string, params?: Record<string, unknown>) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "code-forge-mcp", version: "1.0.0" },
      };

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call": {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
      return { _async: true, toolName, toolArgs };
    }

    case "notifications/initialized":
      return null;

    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// =============================================================================
// Routes
// =============================================================================

app.options("*", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-forge-key",
    },
  });
});

app.get("/", (c) => {
  return c.json({ status: "ok", server: "code-forge-mcp", version: "1.0.0" });
});

app.post("/", async (c) => {
  const query = new URL(c.req.url).searchParams;

  if (!authenticate(c.req.raw, query)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();

  const requests = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const req of requests) {
    const { jsonrpc, id, method, params } = req;

    const result = handleMCPRequest(method, params);

    if (result === null && !id) continue;

    if (result && (result as Record<string, unknown>)._async) {
      const { toolName, toolArgs } = result as { _async: boolean; toolName: string; toolArgs: Record<string, unknown> };
      try {
        const toolResult = await handleTool(toolName, toolArgs);
        responses.push({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: toolResult }],
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        responses.push({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: message }) }],
            isError: true,
          },
        });
      }
      continue;
    }

    if (result && (result as Record<string, unknown>).error) {
      responses.push({ jsonrpc: "2.0", id, error: result.error });
      continue;
    }

    responses.push({ jsonrpc: "2.0", id, result });
  }

  const responseBody = Array.isArray(body) ? responses : responses[0] || {};

  return new Response(JSON.stringify(responseBody), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// =============================================================================
// Serve
// =============================================================================
Deno.serve(app.fetch);
