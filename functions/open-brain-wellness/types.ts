// ============================================================
// OPEN WELLNESS — Type Definitions
// ============================================================

// --- LLM Parser Output ---

export interface ParsedMeal {
  meal_type: "breakfast" | "lunch" | "dinner" | "snack";
  time_approx: string | null; // HH:MM 24h
  items: ParsedFoodItem[];
}

export interface ParsedFoodItem {
  name: string;
  quantity: number;
  unit: string;
  food_type?: "generic" | "branded";
}

export interface ParsedSleep {
  duration_hours: number | null;
  quality_rating: number | null; // 1-10
  bed_time: string | null; // HH:MM
  wake_time: string | null; // HH:MM
  interruptions: number | null;
  notes: string | null;
}

export interface ParsedSymptom {
  metric: "energy" | "focus" | "mood" | "pain" | "digestion" | "anxiety" | "stress" | "other";
  rating: number; // 1-10
  time_of_day: "morning" | "afternoon" | "evening" | "all_day" | null;
  notes: string | null;
}

export interface ParsedSupplement {
  name: string;
  dose: string | null;
  time_approx: string | null; // HH:MM
  skipped: boolean; // true = explicitly did NOT take this
}

export interface ParsedBathroom {
  entry_type: "urination" | "bowel" | "other";
  count: number;
  time_of_day: "morning" | "afternoon" | "evening" | "night" | "overnight" | "all_day" | null;
  notes: string | null;
}

export interface ParsedHabit {
  name: string;
  completed: boolean;
  duration_minutes: number | null;
  notes: string | null;
}

export interface ParsedHydration {
  amount_oz: number | null;
  notes: string | null;
}

export interface ParsedWorkout {
  type: string;
  duration_minutes: number | null;
  intensity: "low" | "moderate" | "high" | null;
  notes: string | null;
}

export interface ParsedWellnessData {
  meals: ParsedMeal[];
  sleep: ParsedSleep | null;
  symptoms: ParsedSymptom[];
  supplements: ParsedSupplement[];
  habits: ParsedHabit[];
  hydration: ParsedHydration | null;
  workouts: ParsedWorkout[];
  bathroom: ParsedBathroom[];
}

// --- Food Resolution ---

export interface FoodCatalogEntry {
  id: string;
  canonical_name: string;
  brand: string | null;
  input_aliases: string[];
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  serving_size: number | null;
  serving_unit: string | null;
  ingredients: string | null;
  tags: string[];
  resolution_source: "open_food_facts" | "usda" | "estimated" | "manual";
  external_id: string | null;
  confidence: number;
  verified: boolean;
}

export interface FoodResolutionResult {
  food: FoodCatalogEntry;
  input_name: string;
  resolution_source: string;
  confidence: number;
  is_new: boolean;
  needs_review?: boolean;
}

// --- Capture Pipeline ---

export interface CaptureOptions {
  date?: string; // ISO date override
  timezone?: string;
  source: "mcp" | "slack";
  slack_ts?: string;
}

export interface InsertedCounts {
  meals: number;
  meal_items: number;
  sleep: number;
  supplements: number;
  supplements_skipped: number;
  symptoms: number;
  habits: number;
  hydration: number;
  workouts: number;
  bathroom: number;
}

export interface CaptureResult {
  raw_entry_id: string;
  parsed: ParsedWellnessData;
  inserted: InsertedCounts;
  food_resolutions: FoodResolutionResult[];
  warnings: string[];
  summary: string;
}

// --- Insight Engine ---

export interface Finding {
  factor: string;
  outcome: string;
  direction: "positive" | "negative";
  strength: number; // 0-1
  lag_days?: number;
  description: string;
  evidence: Record<string, unknown>;
}

export interface InsightResult {
  period_start: string;
  period_end: string;
  days_analyzed: number;
  findings: Finding[];
  suggestions: string[];
  confidence_note: string;
}
