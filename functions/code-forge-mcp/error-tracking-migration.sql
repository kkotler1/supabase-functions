-- Code Forge: Error Tracking
-- Migration: Create forge_errors table
-- Run in Supabase SQL Editor after the initial migration

CREATE TABLE IF NOT EXISTS forge_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES forge_tasks(id),
  phase TEXT NOT NULL
    CHECK (phase IN ('planning', 'coding', 'testing', 'self_eval', 'pr_creation', 'deployment', 'other')),
  error_message TEXT NOT NULL,
  context TEXT,
  stack_trace TEXT,
  resolved BOOLEAN NOT NULL DEFAULT false,
  correction_id UUID REFERENCES forge_corrections(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_forge_errors_task ON forge_errors(task_id);
CREATE INDEX idx_forge_errors_phase ON forge_errors(phase);
CREATE INDEX idx_forge_errors_resolved ON forge_errors(resolved);
CREATE INDEX idx_forge_errors_created ON forge_errors(created_at DESC);
