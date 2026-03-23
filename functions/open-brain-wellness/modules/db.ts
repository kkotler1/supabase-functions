// ============================================================
// OPEN WELLNESS — Database Module
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type {
  ParsedWellnessData,
  ParsedMeal,
  CaptureOptions,
  InsertedCounts,
} from "../types.ts";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
  }
  return _client;
}

// --- Raw Entry ---

export async function insertRawEntry(
  content: string,
  options: CaptureOptions
): Promise<{ id: string; entry_date: string }> {
  const db = getSupabase();
  const entry_date = options.date || new Date().toLocaleDateString("en-CA", {
    timeZone: options.timezone || "America/New_York",
  });

  const { data, error } = await db
    .from("wellness_raw_entries")
    .insert({
      content,
      entry_date,
      source: options.source,
      timezone: options.timezone || "America/New_York",
      slack_ts: options.slack_ts || null,
    })
    .select("id, entry_date")
    .single();

  if (error) throw new Error(`Failed to insert raw entry: ${error.message}`);
  return data;
}

export async function updateRawEntryParsed(
  id: string,
  parsed_json: ParsedWellnessData,
  parse_confidence: number
): Promise<void> {
  const db = getSupabase();
  const { error } = await db
    .from("wellness_raw_entries")
    .update({ parsed_json, parse_confidence })
    .eq("id", id);

  if (error) throw new Error(`Failed to update raw entry: ${error.message}`);
}

// --- Domain Table Inserts ---

export async function insertDomainEntries(
  raw_entry_id: string,
  entry_date: string,
  parsed: ParsedWellnessData
): Promise<{ counts: InsertedCounts; mealItemIds: string[]; foodTypes: Record<string, "generic" | "branded"> }> {
  const db = getSupabase();
  const counts: InsertedCounts = {
    meals: 0, meal_items: 0, sleep: 0, supplements: 0, supplements_skipped: 0,
    symptoms: 0, habits: 0, hydration: 0, workouts: 0, bathroom: 0,
  };
  const mealItemIds: string[] = [];
  const foodTypes: Record<string, "generic" | "branded"> = {};

  // --- Meals ---
  for (const meal of parsed.meals) {
    const { data: mealEntry, error: mealErr } = await db
      .from("wellness_meal_entries")
      .insert({
        raw_entry_id,
        entry_date,
        meal_type: meal.meal_type,
        time_approx: meal.time_approx,
      })
      .select("id")
      .single();

    if (mealErr) {
      console.error("Failed to insert meal:", mealErr.message);
      continue;
    }
    counts.meals++;

    // Insert meal items
    for (const item of meal.items) {
      const { data: itemData, error: itemErr } = await db
        .from("wellness_meal_items")
        .insert({
          meal_entry_id: mealEntry.id,
          input_name: item.name,
          input_quantity: item.quantity,
          input_unit: item.unit,
          resolution_status: "pending",
        })
        .select("id")
        .single();

      if (itemErr) {
        console.error("Failed to insert meal item:", itemErr.message);
        continue;
      }
      counts.meal_items++;
      mealItemIds.push(itemData.id);
      foodTypes[itemData.id] = item.food_type === "branded" ? "branded" : "generic";
    }
  }

  // --- Sleep ---
  if (parsed.sleep && (parsed.sleep.duration_hours || parsed.sleep.quality_rating)) {
    const { error } = await db.from("wellness_sleep_entries").insert({
      raw_entry_id,
      entry_date,
      duration_hours: parsed.sleep.duration_hours,
      quality_rating: parsed.sleep.quality_rating,
      bed_time: parsed.sleep.bed_time,
      wake_time: parsed.sleep.wake_time,
      interruptions: parsed.sleep.interruptions,
      notes: parsed.sleep.notes,
    });
    if (!error) counts.sleep = 1;
    else console.error("Failed to insert sleep:", error.message);
  }

  // --- Supplements ---
  if (parsed.supplements.length > 0) {
    const rows = parsed.supplements.map((s) => ({
      raw_entry_id,
      entry_date,
      name: s.name,
      dose: s.dose,
      time_approx: s.time_approx,
      skipped: s.skipped || false,
    }));
    const { error } = await db.from("wellness_supplement_entries").insert(rows);
    if (!error) {
      const taken = parsed.supplements.filter((s) => !s.skipped).length;
      const skipped = parsed.supplements.filter((s) => s.skipped).length;
      counts.supplements = taken;
      counts.supplements_skipped = skipped;
    }
    else console.error("Failed to insert supplements:", error.message);
  }

  // --- Symptoms ---
  if (parsed.symptoms.length > 0) {
    const rows = parsed.symptoms.map((s) => ({
      raw_entry_id,
      entry_date,
      metric: s.metric,
      rating: s.rating,
      time_of_day: s.time_of_day,
      notes: s.notes,
    }));
    const { error } = await db.from("wellness_symptom_checkins").insert(rows);
    if (!error) counts.symptoms = parsed.symptoms.length;
    else console.error("Failed to insert symptoms:", error.message);
  }

  // --- Habits ---
  if (parsed.habits.length > 0) {
    const rows = parsed.habits.map((h) => ({
      raw_entry_id,
      entry_date,
      name: h.name,
      completed: h.completed,
      duration_minutes: h.duration_minutes,
      notes: h.notes,
    }));
    const { error } = await db.from("wellness_habit_entries").insert(rows);
    if (!error) counts.habits = parsed.habits.length;
    else console.error("Failed to insert habits:", error.message);
  }

  // --- Hydration ---
  if (parsed.hydration && parsed.hydration.amount_oz) {
    const { error } = await db.from("wellness_hydration_entries").insert({
      raw_entry_id,
      entry_date,
      amount_oz: parsed.hydration.amount_oz,
      notes: parsed.hydration.notes,
    });
    if (!error) counts.hydration = 1;
    else console.error("Failed to insert hydration:", error.message);
  }

  // --- Workouts ---
  if (parsed.workouts.length > 0) {
    const rows = parsed.workouts.map((w) => ({
      raw_entry_id,
      entry_date,
      workout_type: w.type,
      duration_minutes: w.duration_minutes,
      intensity: w.intensity,
      notes: w.notes,
    }));
    const { error } = await db.from("wellness_workout_entries").insert(rows);
    if (!error) counts.workouts = parsed.workouts.length;
    else console.error("Failed to insert workouts:", error.message);
  }

  // --- Bathroom ---
  if (parsed.bathroom && parsed.bathroom.length > 0) {
    const rows = parsed.bathroom.map((b) => ({
      raw_entry_id,
      entry_date,
      entry_type: b.entry_type,
      count: b.count,
      time_of_day: b.time_of_day,
      notes: b.notes,
    }));
    const { error } = await db.from("wellness_bathroom_entries").insert(rows);
    if (!error) counts.bathroom = parsed.bathroom.length;
    else console.error("Failed to insert bathroom:", error.message);
  }

  return { counts, mealItemIds, foodTypes };
}

// --- Query Helpers ---

export async function getTodayStatus(timezone: string = "America/New_York") {
  const db = getSupabase();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });

  const [meals, sleep, supplements, symptoms, habits, hydration, workouts] = await Promise.all([
    db.from("wellness_meal_entries").select("id, meal_type, time_approx, total_calories").eq("entry_date", today),
    db.from("wellness_sleep_entries").select("*").eq("entry_date", today),
    db.from("wellness_supplement_entries").select("id, name, dose").eq("entry_date", today),
    db.from("wellness_symptom_checkins").select("id, metric, rating, time_of_day").eq("entry_date", today),
    db.from("wellness_habit_entries").select("id, name, completed").eq("entry_date", today),
    db.from("wellness_hydration_entries").select("id, amount_oz").eq("entry_date", today),
    db.from("wellness_workout_entries").select("id, workout_type, duration_minutes, intensity").eq("entry_date", today),
  ]);

  return {
    date: today,
    meals: meals.data || [],
    sleep: sleep.data || [],
    supplements: supplements.data || [],
    symptoms: symptoms.data || [],
    habits: habits.data || [],
    hydration: hydration.data || [],
    workouts: workouts.data || [],
  };
}

export async function getRecentSymptomAverages(days: number = 7, timezone: string = "America/New_York") {
  const db = getSupabase();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const start = startDate.toLocaleDateString("en-CA", { timeZone: timezone });

  const { data, error } = await db
    .from("wellness_symptom_checkins")
    .select("metric, rating")
    .gte("entry_date", start)
    .lte("entry_date", today);

  if (error || !data) return {};

  const grouped: Record<string, number[]> = {};
  for (const row of data) {
    if (!grouped[row.metric]) grouped[row.metric] = [];
    grouped[row.metric].push(row.rating);
  }

  const averages: Record<string, number> = {};
  for (const [metric, ratings] of Object.entries(grouped)) {
    averages[metric] = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
  }
  return averages;
}

export async function getTrackingStreak(timezone: string = "America/New_York") {
  const db = getSupabase();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });

  const { data, error } = await db
    .from("wellness_raw_entries")
    .select("entry_date")
    .order("entry_date", { ascending: false })
    .limit(90);

  if (error || !data || data.length === 0) return { current_streak: 0, total_days: 0 };

  const uniqueDates = [...new Set(data.map((r) => r.entry_date))].sort().reverse();
  let streak = 0;
  const checkDate = new Date(today + "T12:00:00");

  for (const dateStr of uniqueDates) {
    const expected = checkDate.toLocaleDateString("en-CA", { timeZone: "UTC" });
    if (dateStr === expected) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return { current_streak: streak, total_days: uniqueDates.length };
}
