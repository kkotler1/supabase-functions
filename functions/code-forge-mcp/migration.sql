-- Code Forge: Autonomous Coding Agent
-- Migration: Create core tables
-- Run in Supabase SQL Editor or via CLI migration
-- Project: vwcwfzphjuvtsqlmkhvd (shared with Open Brain)

-- =============================================================================
-- forge_projects: Registry of repos and their context
-- =============================================================================
CREATE TABLE IF NOT EXISTS forge_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  tech_stack TEXT,
  conventions TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_forge_projects_updated_at()
RETURNS TRIGGER AS $
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$ LANGUAGE plpgsql;

CREATE TRIGGER forge_projects_updated_at
  BEFORE UPDATE ON forge_projects
  FOR EACH ROW
  EXECUTE FUNCTION update_forge_projects_updated_at();

-- =============================================================================
-- forge_tasks: Task queue and execution history
-- =============================================================================
CREATE TABLE IF NOT EXISTS forge_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  target_repo TEXT NOT NULL REFERENCES forge_projects(repo),
  target_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'planning', 'coding', 'testing', 'pr_open', 'merged', 'failed')),
  plan TEXT,
  pr_url TEXT,
  result_summary TEXT,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_forge_tasks_updated_at()
RETURNS TRIGGER AS $
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$ LANGUAGE plpgsql;

CREATE TRIGGER forge_tasks_updated_at
  BEFORE UPDATE ON forge_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_forge_tasks_updated_at();

CREATE INDEX idx_forge_tasks_status ON forge_tasks(status);
CREATE INDEX idx_forge_tasks_repo ON forge_tasks(target_repo);
CREATE INDEX idx_forge_tasks_created ON forge_tasks(created_at DESC);

-- =============================================================================
-- forge_corrections: Compounding knowledge base
-- =============================================================================
CREATE TABLE IF NOT EXISTS forge_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES forge_tasks(id),
  rule TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('code_style', 'architecture', 'testing', 'api_usage', 'business_logic', 'general')),
  source TEXT NOT NULL DEFAULT 'human'
    CHECK (source IN ('human', 'self')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_forge_corrections_category ON forge_corrections(category);
CREATE INDEX idx_forge_corrections_created ON forge_corrections(created_at DESC);

-- =============================================================================
-- Seed: Open Brain repo as first project
-- =============================================================================
INSERT INTO forge_projects (repo, description, tech_stack, conventions)
VALUES (
  'kkotler1/open-brain',
  'Open Brain MCP Server — persistent cross-session knowledge store. Supabase Edge Function with 6 tools for thought capture, search, and management.',
  'TypeScript, Deno, Hono, MCP SDK, Supabase Edge Functions, OpenRouter embeddings (text-embedding-3-small), gpt-4o-mini for metadata',
  'Single index.ts file pattern. Auth via x-brain-key header or ?key= query param. Snake_case tool names. Lean non-redundant code. Test each change before moving to next.'
)
ON CONFLICT (repo) DO NOTHING;

-- =============================================================================
-- Seed: 10 baseline corrections
-- =============================================================================
INSERT INTO forge_corrections (rule, category, source) VALUES
  ('Always use const over let unless reassignment is genuinely needed.', 'code_style', 'human'),
  ('Deno.env.get() takes the variable NAME as a string, not the literal value. Double-check env variable references.', 'api_usage', 'human'),
  ('Every Supabase Edge Function must handle CORS preflight (OPTIONS) requests explicitly.', 'architecture', 'human'),
  ('When using Supabase client in Edge Functions, pass the service_role key, not the anon key, for full table access.', 'api_usage', 'human'),
  ('Keep MCP tool descriptions concise but include parameter types and example usage.', 'code_style', 'human'),
  ('Always return structured JSON in MCP tool responses, not just plain text strings.', 'code_style', 'human'),
  ('Test the build before committing. Never push code that has not been verified to compile.', 'testing', 'human'),
  ('For Hono routes in Supabase Edge Functions, use c.req.json() for POST body parsing, not c.req.body.', 'api_usage', 'human'),
  ('Include error context in catch blocks — the raw error message plus what operation was attempted.', 'architecture', 'human'),
  ('PRs should have a structured body: what was done, why, test results, and any caveats.', 'general', 'human');
