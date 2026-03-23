// ============================================================
// OPEN WELLNESS — Shared Capture Pipeline
// Called by both MCP log_wellness tool and Slack handler.
// ============================================================

import type { CaptureOptions, CaptureResult, InsertedCounts } from "../types.ts";
import { insertRawEntry, updateRawEntryParsed, insertDomainEntries } from "./db.ts";
import { parseFreeformInput } from "./llm-parser.ts";
import { resolveMealItems } from "./food-resolver.ts";

export async function captureWellnessEntry(
  content: string,
  options: CaptureOptions
): Promise<CaptureResult> {
  const warnings: string[] = [];

  // 1. Store raw entry immediately (never lose input)
  const rawEntry = await insertRawEntry(content, options);

  // 2. LLM extraction
  const { parsed, confidence } = await parseFreeformInput(content);

  // 3. Update raw entry with parsed result
  await updateRawEntryParsed(rawEntry.id, parsed, confidence);

  // 4. Check if anything was actually extracted
  const hasData =
    parsed.meals.length > 0 ||
    parsed.sleep !== null ||
    parsed.symptoms.length > 0 ||
    parsed.supplements.length > 0 ||
    parsed.habits.length > 0 ||
    parsed.hydration !== null ||
    parsed.workouts.length > 0 ||
    parsed.bathroom.length > 0;

  if (!hasData) {
    warnings.push("No wellness data could be extracted from this input.");
    return {
      raw_entry_id: rawEntry.id,
      parsed,
      inserted: emptyCounts(),
      food_resolutions: [],
      warnings,
      summary: "No wellness data detected.",
    };
  }

  // 5. Insert into domain tables
  const { counts, mealItemIds, foodTypes } = await insertDomainEntries(
    rawEntry.id,
    rawEntry.entry_date,
    parsed
  );

  // 6. Food resolution — resolve all new meal items
  let food_resolutions: CaptureResult["food_resolutions"] = [];

  if (mealItemIds.length > 0) {
    try {
      food_resolutions = await resolveMealItems(mealItemIds, foodTypes);

      const lowConfidence = food_resolutions.filter((r) => r.confidence < 0.5).length;
      if (lowConfidence > 0) {
        warnings.push(`${lowConfidence} food(s) resolved with low confidence — consider verifying.`);
      }
      const needsReview = food_resolutions.filter((r) => r.needs_review).length;
      if (needsReview > 0) {
        warnings.push(`${needsReview} branded food(s) flagged for manual review — resolution confidence too low.`);
      }
    } catch (err) {
      console.error("Food resolution failed:", err);
      warnings.push("Food resolution encountered an error. Items saved as pending.");
    }
  }

  // 7. Build summary (now with calorie info if available)
  const summary = buildSummary(parsed, counts, food_resolutions);

  return {
    raw_entry_id: rawEntry.id,
    parsed,
    inserted: counts,
    food_resolutions,
    warnings,
    summary,
  };
}

function emptyCounts(): InsertedCounts {
  return {
    meals: 0, meal_items: 0, sleep: 0, supplements: 0, supplements_skipped: 0,
    symptoms: 0, habits: 0, hydration: 0, workouts: 0, bathroom: 0,
  };
}

function buildSummary(
  parsed: CaptureResult["parsed"],
  counts: InsertedCounts,
  foodResolutions: CaptureResult["food_resolutions"]
): string {
  const parts: string[] = [];

  // Meals (now with calorie totals when available)
  if (counts.meals > 0) {
    const types = parsed.meals.map((m) => m.meal_type);
    const itemCount = parsed.meals.reduce((sum, m) => sum + m.items.length, 0);

    let mealStr = `${counts.meals} meal(s) (${types.join(", ")}) with ${itemCount} item(s)`;

    // Add calorie estimate from resolutions
    const totalCal = foodResolutions.reduce((sum, r) => sum + (r.food.calories || 0), 0);
    if (totalCal > 0) {
      mealStr += ` ~${Math.round(totalCal)} cal`;
    }

    parts.push(mealStr);
  }

  // Sleep
  if (counts.sleep > 0 && parsed.sleep) {
    const sleepParts: string[] = [];
    if (parsed.sleep.duration_hours) sleepParts.push(`${parsed.sleep.duration_hours}h`);
    if (parsed.sleep.quality_rating) sleepParts.push(`quality ${parsed.sleep.quality_rating}/10`);
    parts.push(`sleep (${sleepParts.join(", ")})`);
  }

  // Supplements (taken and skipped) — use parsed, not counts, so DB failures don't silence the summary
  const takenSupps = parsed.supplements.filter((s) => !s.skipped).map((s) => s.name);
  const skippedSupps = parsed.supplements.filter((s) => s.skipped).map((s) => s.name);
  if (takenSupps.length > 0) parts.push(takenSupps.join(", "));
  if (skippedSupps.length > 0) parts.push(`skipped: ${skippedSupps.join(", ")}`);

  // Symptoms
  if (counts.symptoms > 0) {
    const symptomStrs = parsed.symptoms.map((s) => `${s.metric} ${s.rating}/10`);
    parts.push(symptomStrs.join(" · "));
  }

  // Habits
  if (counts.habits > 0) {
    const names = parsed.habits.filter((h) => h.completed).map((h) => h.name);
    if (names.length > 0) parts.push(names.join(", "));
  }

  // Hydration
  if (counts.hydration > 0 && parsed.hydration?.amount_oz) {
    parts.push(`${parsed.hydration.amount_oz}oz water`);
  }

  // Workouts
  if (counts.workouts > 0) {
    const workoutStrs = parsed.workouts.map((w) => {
      let s = w.type;
      if (w.duration_minutes) s += ` ${w.duration_minutes}min`;
      if (w.intensity) s += ` (${w.intensity})`;
      return s;
    });
    parts.push(workoutStrs.join(", "));
  }

  // Bathroom — use parsed, not counts, so DB failures don't silence the summary
  if (parsed.bathroom.length > 0) {
    const bathroomStrs = parsed.bathroom.map((b) => {
      let s = `${b.entry_type} ×${b.count}`;
      if (b.time_of_day) s += ` (${b.time_of_day})`;
      return s;
    });
    parts.push(bathroomStrs.join(", "));
  }

  if (parts.length === 0) return "No wellness data detected.";
  return parts.join(", ");
}
