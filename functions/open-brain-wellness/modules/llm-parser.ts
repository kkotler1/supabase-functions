// ============================================================
// OPEN WELLNESS — LLM Parser Module
// Sends freeform text to gpt-4o-mini via OpenRouter,
// returns structured wellness data.
// ============================================================

import type { ParsedWellnessData } from "../types.ts";

const EXTRACTION_PROMPT = `You are a wellness data extraction engine. Parse the following freeform text into structured JSON. Extract ALL of the following categories if present:

1. meals: array of {meal_type (breakfast/lunch/dinner/snack), time_approx (HH:MM 24h or null), items: [{name, quantity (number), unit (string)}]}
2. sleep: {duration_hours (number or null), quality_rating (1-10 or null), bed_time (HH:MM or null), wake_time (HH:MM or null), interruptions (number or null), notes (string or null)}
3. symptoms: array of {metric (energy/focus/mood/pain/digestion/anxiety/stress/other), rating (1-10), time_of_day (morning/afternoon/evening/all_day or null), notes (string or null)}
4. supplements: array of {name, dose (string or null), time_approx (HH:MM or null)}
5. habits: array of {name, completed (bool), duration_minutes (number or null), notes (string or null)}
6. hydration: {amount_oz (number or null), notes (string or null)}
7. workouts: array of {type, duration_minutes (number or null), intensity (low/moderate/high or null), notes (string or null)}

Rules:
- Preserve exact food names as spoken (e.g., "Chobani yogurt", "Yasso mint chocolate chip bar")
- If a rating is vague, map to numeric: terrible=2, bad/rough=3, not great/low=4, okay/meh/flat=5, decent=6, good/fine=7, great/really good=8, amazing/excellent=9
- If time is vague, estimate: morning=08:00, lunch=12:00, afternoon=15:00, dinner=19:00, evening=21:00, night=22:00
- If quantity is not stated, assume 1 serving
- For sleep described as "kept waking up" or "restless", set interruptions to a reasonable estimate (2-4)
- Convert hydration: "glasses of water" → multiply by 8 oz, "bottles" → multiply by 16.9 oz
- Do NOT invent data that isn't in the input
- If a category has no data in the input, return empty array or null
- Return ONLY valid JSON, no markdown, no explanation, no backticks`;

const EMPTY_RESULT: ParsedWellnessData = {
  meals: [],
  sleep: null,
  symptoms: [],
  supplements: [],
  habits: [],
  hydration: null,
  workouts: [],
};

export async function parseFreeformInput(content: string): Promise<{
  parsed: ParsedWellnessData;
  confidence: number;
}> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: `Text: ${content}` },
        ],
        temperature: 0.1, // Low temp for consistent extraction
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content?.trim();

    if (!rawText) {
      console.error("Empty response from LLM");
      return { parsed: EMPTY_RESULT, confidence: 0 };
    }

    // Clean potential markdown fencing
    const cleaned = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as ParsedWellnessData;

    // Validate and normalize
    const normalized = normalizeOutput(parsed);
    const confidence = estimateConfidence(normalized);

    return { parsed: normalized, confidence };
  } catch (err) {
    console.error("LLM parsing failed:", err);
    return { parsed: EMPTY_RESULT, confidence: 0 };
  }
}

function normalizeOutput(raw: Record<string, unknown>): ParsedWellnessData {
  return {
    meals: Array.isArray(raw.meals) ? raw.meals.map(normalizeMeal) : [],
    sleep: raw.sleep && typeof raw.sleep === "object" ? normalizeSleep(raw.sleep as Record<string, unknown>) : null,
    symptoms: Array.isArray(raw.symptoms) ? raw.symptoms.map(normalizeSymptom).filter(Boolean) as ParsedWellnessData["symptoms"] : [],
    supplements: Array.isArray(raw.supplements) ? raw.supplements : [],
    habits: Array.isArray(raw.habits) ? raw.habits : [],
    hydration: raw.hydration && typeof raw.hydration === "object" ? raw.hydration as ParsedWellnessData["hydration"] : null,
    workouts: Array.isArray(raw.workouts) ? raw.workouts : [],
  };
}

function normalizeMeal(meal: Record<string, unknown>): ParsedWellnessData["meals"][0] {
  const validTypes = ["breakfast", "lunch", "dinner", "snack"];
  let mealType = String(meal.meal_type || "snack").toLowerCase();
  if (!validTypes.includes(mealType)) mealType = "snack";

  return {
    meal_type: mealType as "breakfast" | "lunch" | "dinner" | "snack",
    time_approx: typeof meal.time_approx === "string" ? meal.time_approx : null,
    items: Array.isArray(meal.items)
      ? meal.items.map((item: Record<string, unknown>) => ({
          name: String(item.name || "unknown item"),
          quantity: Number(item.quantity) || 1,
          unit: String(item.unit || "serving"),
        }))
      : [],
  };
}

function normalizeSleep(sleep: Record<string, unknown>): ParsedWellnessData["sleep"] {
  return {
    duration_hours: typeof sleep.duration_hours === "number" ? sleep.duration_hours : null,
    quality_rating: typeof sleep.quality_rating === "number"
      ? Math.min(10, Math.max(1, Math.round(sleep.quality_rating)))
      : null,
    bed_time: typeof sleep.bed_time === "string" ? sleep.bed_time : null,
    wake_time: typeof sleep.wake_time === "string" ? sleep.wake_time : null,
    interruptions: typeof sleep.interruptions === "number" ? sleep.interruptions : null,
    notes: typeof sleep.notes === "string" ? sleep.notes : null,
  };
}

function normalizeSymptom(symptom: Record<string, unknown>): ParsedWellnessData["symptoms"][0] | null {
  const validMetrics = ["energy", "focus", "mood", "pain", "digestion", "anxiety", "stress", "other"];
  const metric = String(symptom.metric || "").toLowerCase();
  if (!validMetrics.includes(metric)) return null;

  const rating = Number(symptom.rating);
  if (isNaN(rating) || rating < 1 || rating > 10) return null;

  const validTimes = ["morning", "afternoon", "evening", "all_day"];
  let timeOfDay = typeof symptom.time_of_day === "string" ? symptom.time_of_day.toLowerCase() : null;
  if (timeOfDay && !validTimes.includes(timeOfDay)) timeOfDay = null;

  return {
    metric: metric as ParsedWellnessData["symptoms"][0]["metric"],
    rating: Math.round(rating),
    time_of_day: timeOfDay as ParsedWellnessData["symptoms"][0]["time_of_day"],
    notes: typeof symptom.notes === "string" ? symptom.notes : null,
  };
}

function estimateConfidence(parsed: ParsedWellnessData): number {
  // Rough confidence based on how much data was extracted
  let score = 0;
  let categories = 0;

  if (parsed.meals.length > 0) { score += 0.9; categories++; }
  if (parsed.sleep) { score += 0.9; categories++; }
  if (parsed.symptoms.length > 0) { score += 0.9; categories++; }
  if (parsed.supplements.length > 0) { score += 0.9; categories++; }
  if (parsed.habits.length > 0) { score += 0.9; categories++; }
  if (parsed.hydration) { score += 0.9; categories++; }
  if (parsed.workouts.length > 0) { score += 0.9; categories++; }

  if (categories === 0) return 0;
  return Math.round((score / categories) * 100) / 100;
}
