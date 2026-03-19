-- Code Forge: Draft Correction Pipeline
-- Migration: Add status column to forge_corrections; add draft/review/approve tools support
-- Run in Supabase SQL Editor after the error-tracking-migration.sql

-- =============================================================================
-- Add status column to forge_corrections
-- =============================================================================
ALTER TABLE forge_corrections
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- Existing rows already have status = 'active' (the default).

-- Add check constraint for valid status values
ALTER TABLE forge_corrections
  DROP CONSTRAINT IF EXISTS forge_corrections_status_check;

ALTER TABLE forge_corrections
  ADD CONSTRAINT forge_corrections_status_check
  CHECK (status IN ('active', 'draft', 'archived'));

-- Add index on status for query performance
CREATE INDEX IF NOT EXISTS idx_forge_corrections_status ON forge_corrections(status);

-- =============================================================================
-- Extend source check constraint to include 'auto' (for forge_auto_promote)
-- =============================================================================
ALTER TABLE forge_corrections
  DROP CONSTRAINT IF EXISTS forge_corrections_source_check;

ALTER TABLE forge_corrections
  ADD CONSTRAINT forge_corrections_source_check
  CHECK (source IN ('human', 'self', 'auto'));
