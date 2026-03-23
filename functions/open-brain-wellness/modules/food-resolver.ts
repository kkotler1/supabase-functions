// ============================================================
// OPEN WELLNESS — Food Resolver Module
// Resolution chain: Cache → Open Food Facts → USDA → LLM Estimate
// ============================================================

import { getSupabase } from "./db.ts";
import type { FoodCatalogEntry, FoodResolutionResult } from "../types.ts";

// --- Main Resolution Function ---

export async function resolveFood(
  inputName: string,
  foodType: "generic" | "branded" = "generic"
): Promise<FoodResolutionResult> {
  const normalized = inputName.trim().toLowerCase();

  // Step 1: Cache check (honors existing verified entries — never overwritten)
  const cached = await checkCache(normalized);
  if (cached) {
    return {
      food: cached,
      input_name: inputName,
      resolution_source: "cache",
      confidence: cached.verified ? 1.0 : cached.confidence,
      is_new: false,
      needs_review: false,
    };
  }

  if (foodType === "generic") {
    // Generic whole foods → USDA Foundation/SR Legacy (no branded products, no brand assigned)
    const usdaResult = await searchUSDA(inputName, true);
    if (usdaResult) {
      const entry = await upsertFoodCatalog(usdaResult, normalized);
      return {
        food: entry,
        input_name: inputName,
        resolution_source: "usda",
        confidence: usdaResult.confidence,
        is_new: true,
        needs_review: false,
      };
    }

    // Generic fallback: LLM estimate (no branded DB needed)
    const llmResult = await estimateWithLLM(inputName);
    const entry = await upsertFoodCatalog(llmResult, normalized);
    return {
      food: entry,
      input_name: inputName,
      resolution_source: "estimated",
      confidence: llmResult.confidence,
      is_new: true,
      needs_review: false,
    };
  } else {
    // Branded foods → Open Food Facts first
    const offResult = await searchOpenFoodFacts(inputName);
    if (offResult) {
      if (offResult.confidence >= 0.5) {
        const entry = await upsertFoodCatalog(offResult, normalized);
        return {
          food: entry,
          input_name: inputName,
          resolution_source: "open_food_facts",
          confidence: offResult.confidence,
          is_new: true,
          needs_review: false,
        };
      }
      // OFF confidence too low — fall back to LLM estimate and flag for review
      const llmResult = await estimateWithLLM(inputName);
      const entry = await upsertFoodCatalog(llmResult, normalized);
      return {
        food: entry,
        input_name: inputName,
        resolution_source: "estimated",
        confidence: llmResult.confidence,
        is_new: true,
        needs_review: true,
      };
    }

    // OFF returned nothing → try USDA Branded as fallback
    const usdaResult = await searchUSDA(inputName, false);
    if (usdaResult) {
      const entry = await upsertFoodCatalog(usdaResult, normalized);
      return {
        food: entry,
        input_name: inputName,
        resolution_source: "usda",
        confidence: usdaResult.confidence,
        is_new: true,
        needs_review: false,
      };
    }

    // Final fallback: LLM estimate, flag for review since branded food not resolved
    const llmResult = await estimateWithLLM(inputName);
    const entry = await upsertFoodCatalog(llmResult, normalized);
    return {
      food: entry,
      input_name: inputName,
      resolution_source: "estimated",
      confidence: llmResult.confidence,
      is_new: true,
      needs_review: true,
    };
  }
}

// --- Batch Resolution (for capture pipeline) ---

export async function resolveMealItems(
  mealItemIds: string[],
  foodTypes?: Record<string, "generic" | "branded">
): Promise<FoodResolutionResult[]> {
  const db = getSupabase();
  const results: FoodResolutionResult[] = [];

  for (const itemId of mealItemIds) {
    try {
      // Get the meal item
      const { data: item, error } = await db
        .from("wellness_meal_items")
        .select("id, input_name, input_quantity, input_unit")
        .eq("id", itemId)
        .single();

      if (error || !item) continue;

      // Resolve the food using the food_type classification from the parse step
      const foodType = foodTypes?.[itemId] ?? "generic";
      const resolution = await resolveFood(item.input_name, foodType);

      // Calculate multiplier — unit-aware
      // If unit is grams/ml and the food has a serving size in grams,
      // compute the ratio. Otherwise, treat quantity as number of servings.
      let multiplier = item.input_quantity || 1;
      const unit = (item.input_unit || "serving").toLowerCase();

      if ((unit === "g" || unit === "ml") && resolution.food.serving_size) {
        // User specified weight, catalog has serving size — compute ratio
        multiplier = multiplier / resolution.food.serving_size;
      } else if (unit === "g" || unit === "ml") {
        // User specified weight but no serving size in catalog — assume 100g reference
        // This is a rough fallback; better than multiplying by raw grams
        multiplier = multiplier / 100;
      }

      // Safety clamp: no single food item should exceed ~3000 calories
      // If multiplier would create absurd values, cap at 1
      if (resolution.food.calories != null && resolution.food.calories * multiplier > 3000) {
        console.warn(`Clamping multiplier for ${item.input_name}: ${multiplier} would give ${resolution.food.calories * multiplier} cal`);
        multiplier = 1;
      }

      const updateData: Record<string, unknown> = {
        food_catalog_id: resolution.food.id,
        resolution_status: resolution.needs_review
          ? "needs_review"
          : resolution.confidence >= 0.5
          ? "resolved"
          : "estimated",
        resolution_confidence: resolution.confidence,
      };

      if (resolution.food.calories != null) {
        updateData.calories = resolution.food.calories * multiplier;
        updateData.protein_g = (resolution.food.protein_g || 0) * multiplier;
        updateData.carbs_g = (resolution.food.carbs_g || 0) * multiplier;
        updateData.fat_g = (resolution.food.fat_g || 0) * multiplier;
      }

      await db
        .from("wellness_meal_items")
        .update(updateData)
        .eq("id", itemId);

      // Also update the parent meal entry totals
      await updateMealTotals(item.id);

      results.push(resolution);
    } catch (err) {
      console.error(`Failed to resolve meal item ${itemId}:`, err);
    }
  }

  return results;
}

// --- Cache Check ---

async function checkCache(normalized: string): Promise<FoodCatalogEntry | null> {
  const db = getSupabase();

  // Check exact canonical name match
  const { data: exactMatch } = await db
    .from("wellness_food_catalog")
    .select("*")
    .ilike("canonical_name", normalized)
    .limit(1)
    .single();

  if (exactMatch) return exactMatch as FoodCatalogEntry;

  // Check aliases
  const { data: aliasMatch } = await db
    .from("wellness_food_catalog")
    .select("*")
    .contains("input_aliases", [normalized])
    .limit(1)
    .single();

  if (aliasMatch) return aliasMatch as FoodCatalogEntry;

  // Fuzzy search using text search
  const searchTerms = normalized.split(/\s+/).filter((t) => t.length > 2).join(" & ");
  if (!searchTerms) return null;

  const { data: fuzzyMatch } = await db
    .from("wellness_food_catalog")
    .select("*")
    .textSearch("canonical_name", searchTerms, { type: "plain" })
    .limit(1)
    .single();

  return fuzzyMatch as FoodCatalogEntry | null;
}

// --- Open Food Facts ---

interface ResolvedFood {
  canonical_name: string;
  brand: string | null;
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
  resolution_source: string;
  external_id: string | null;
  confidence: number;
}

async function searchOpenFoodFacts(query: string): Promise<ResolvedFood | null> {
  try {
    const url = new URL("https://world.openfoodfacts.org/cgi/search.pl");
    url.searchParams.set("search_terms", query);
    url.searchParams.set("search_simple", "1");
    url.searchParams.set("action", "process");
    url.searchParams.set("json", "1");
    url.searchParams.set("page_size", "5");

    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "OpenWellness/1.0 (wellness tracker)" },
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    const products = data.products;
    if (!products || products.length === 0) return null;

    // Find best match
    const queryLower = query.toLowerCase();
    let bestProduct = products[0];
    let bestScore = 0;

    for (const product of products) {
      const name = (product.product_name || "").toLowerCase();
      const brand = (product.brands || "").toLowerCase();
      const combined = `${brand} ${name}`;

      let score = 0;
      if (combined.includes(queryLower) || queryLower.includes(name)) score = 0.9;
      else {
        const queryWords = queryLower.split(/\s+/);
        const matchedWords = queryWords.filter((w) => combined.includes(w));
        score = matchedWords.length / queryWords.length;
      }

      if (score > bestScore) {
        bestScore = score;
        bestProduct = product;
      }
    }

    if (bestScore < 0.3) return null;

    const n = bestProduct.nutriments || {};
    const servingSize = parseServingSize(bestProduct.serving_size);

    return {
      canonical_name: bestProduct.product_name || query,
      brand: bestProduct.brands || null,
      calories: n["energy-kcal_serving"] ?? n["energy-kcal_100g"] ?? null,
      protein_g: n.proteins_serving ?? n.proteins_100g ?? null,
      carbs_g: n.carbohydrates_serving ?? n.carbohydrates_100g ?? null,
      fat_g: n.fat_serving ?? n.fat_100g ?? null,
      fiber_g: n.fiber_serving ?? n.fiber_100g ?? null,
      sugar_g: n.sugars_serving ?? n.sugars_100g ?? null,
      sodium_mg: n.sodium_serving != null ? n.sodium_serving * 1000 : (n.sodium_100g != null ? n.sodium_100g * 1000 : null),
      serving_size: servingSize.size,
      serving_unit: servingSize.unit,
      ingredients: bestProduct.ingredients_text || null,
      tags: generateTags(n, bestProduct.ingredients_text),
      resolution_source: "open_food_facts",
      external_id: bestProduct.code || null,
      confidence: Math.min(0.9, 0.5 + bestScore * 0.4),
    };
  } catch (err) {
    console.error("Open Food Facts search error:", err);
    return null;
  }
}

// --- USDA FoodData Central ---

// genericOnly=true uses Foundation/SR Legacy data types (no branded products) and strips brand.
// genericOnly=false uses Branded data types (fallback for branded foods when OFF fails).
async function searchUSDA(query: string, genericOnly: boolean = false): Promise<ResolvedFood | null> {
  const apiKey = Deno.env.get("USDA_API_KEY");
  if (!apiKey) {
    console.warn("USDA_API_KEY not set, skipping USDA search");
    return null;
  }

  try {
    const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
    url.searchParams.set("query", query);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("pageSize", "5");
    // Generic foods: use curated Foundation/SR Legacy databases (no branded products)
    // Branded fallback: include Branded data type
    url.searchParams.set(
      "dataType",
      genericOnly ? "Foundation,SR Legacy,Survey (FNDDS)" : "Branded,Survey (FNDDS)"
    );

    const resp = await fetch(url.toString());
    if (!resp.ok) return null;

    const data = await resp.json();
    const foods = data.foods;
    if (!foods || foods.length === 0) return null;

    // Find best match
    const queryLower = query.toLowerCase();
    let bestFood = foods[0];
    let bestScore = 0;

    for (const food of foods) {
      const desc = (food.description || "").toLowerCase();
      const brand = (food.brandName || food.brandOwner || "").toLowerCase();
      const combined = `${brand} ${desc}`;

      let score = 0;
      if (combined.includes(queryLower) || queryLower.includes(desc)) score = 0.9;
      else {
        const queryWords = queryLower.split(/\s+/);
        const matchedWords = queryWords.filter((w) => combined.includes(w));
        score = matchedWords.length / queryWords.length;
      }

      if (score > bestScore) {
        bestScore = score;
        bestFood = food;
      }
    }

    if (bestScore < 0.3) return null;

    // Extract nutrients by nutrient number
    const nutrients: Record<string, number> = {};
    for (const n of bestFood.foodNutrients || []) {
      nutrients[n.nutrientNumber || n.nutrientId] = n.value;
    }

    // USDA nutrient numbers: 208=calories, 203=protein, 205=carbs, 204=fat, 291=fiber, 269=sugar, 307=sodium
    return {
      canonical_name: bestFood.description || query,
      // Generic foods should never carry a brand — strip even if USDA provides one
      brand: genericOnly ? null : (bestFood.brandName || bestFood.brandOwner || null),
      calories: nutrients["208"] ?? nutrients["1008"] ?? null,
      protein_g: nutrients["203"] ?? nutrients["1003"] ?? null,
      carbs_g: nutrients["205"] ?? nutrients["1005"] ?? null,
      fat_g: nutrients["204"] ?? nutrients["1004"] ?? null,
      fiber_g: nutrients["291"] ?? nutrients["1079"] ?? null,
      sugar_g: nutrients["269"] ?? nutrients["2000"] ?? null,
      sodium_mg: nutrients["307"] ?? nutrients["1093"] ?? null,
      serving_size: bestFood.servingSize || null,
      serving_unit: bestFood.servingSizeUnit || "g",
      ingredients: bestFood.ingredients || null,
      tags: generateTags(
        {
          "energy-kcal_serving": nutrients["208"] ?? nutrients["1008"],
          proteins_serving: nutrients["203"] ?? nutrients["1003"],
          sugars_serving: nutrients["269"] ?? nutrients["2000"],
          fiber_serving: nutrients["291"] ?? nutrients["1079"],
        },
        bestFood.ingredients
      ),
      resolution_source: "usda",
      external_id: String(bestFood.fdcId),
      confidence: Math.min(0.8, 0.4 + bestScore * 0.4),
    };
  } catch (err) {
    console.error("USDA search error:", err);
    return null;
  }
}

// --- LLM Estimation (Fallback) ---

async function estimateWithLLM(query: string): Promise<ResolvedFood> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");

  const defaultEstimate: ResolvedFood = {
    canonical_name: query,
    brand: null,
    calories: null, protein_g: null, carbs_g: null, fat_g: null,
    fiber_g: null, sugar_g: null, sodium_mg: null,
    serving_size: null, serving_unit: null,
    ingredients: null, tags: [],
    resolution_source: "estimated",
    external_id: null,
    confidence: 0.3,
  };

  if (!apiKey) return defaultEstimate;

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a nutrition estimation engine. Given a food item name, estimate its nutritional content per serving. Return ONLY valid JSON with these fields:
{
  "canonical_name": "standardized name",
  "brand": "brand or null",
  "calories": number,
  "protein_g": number,
  "carbs_g": number,
  "fat_g": number,
  "fiber_g": number or null,
  "sugar_g": number or null,
  "serving_size": number,
  "serving_unit": "g or ml or piece or bar etc",
  "tags": ["high_protein", "high_sugar", etc]
}
Base estimates on your knowledge of the product or similar products. Be conservative. No markdown, no explanation.`,
          },
          { role: "user", content: `Estimate nutrition for: ${query}` },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
    });

    if (!resp.ok) return defaultEstimate;

    const data = await resp.json();
    const rawText = data.choices?.[0]?.message?.content?.trim();
    if (!rawText) return defaultEstimate;

    const cleaned = rawText
      .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

    const est = JSON.parse(cleaned);

    return {
      canonical_name: est.canonical_name || query,
      brand: est.brand || null,
      calories: est.calories ?? null,
      protein_g: est.protein_g ?? null,
      carbs_g: est.carbs_g ?? null,
      fat_g: est.fat_g ?? null,
      fiber_g: est.fiber_g ?? null,
      sugar_g: est.sugar_g ?? null,
      sodium_mg: est.sodium_mg ?? null,
      serving_size: est.serving_size ?? null,
      serving_unit: est.serving_unit ?? null,
      ingredients: null,
      tags: Array.isArray(est.tags) ? est.tags : [],
      resolution_source: "estimated",
      external_id: null,
      confidence: 0.3,
    };
  } catch (err) {
    console.error("LLM estimation error:", err);
    return defaultEstimate;
  }
}

// --- Database Helpers ---

async function upsertFoodCatalog(
  food: ResolvedFood,
  inputAlias: string
): Promise<FoodCatalogEntry> {
  const db = getSupabase();

  // Check if this canonical_name + brand already exists
  let query = db
    .from("wellness_food_catalog")
    .select("*")
    .ilike("canonical_name", food.canonical_name);

  if (food.brand) {
    query = query.ilike("brand", food.brand);
  } else {
    query = query.is("brand", null);
  }

  const { data: existing } = await query.limit(1).single();

  if (existing) {
    // Add alias if not already present
    const aliases: string[] = existing.input_aliases || [];
    if (!aliases.includes(inputAlias)) {
      aliases.push(inputAlias);
      await db
        .from("wellness_food_catalog")
        .update({ input_aliases: aliases })
        .eq("id", existing.id);
      existing.input_aliases = aliases;
    }
    return existing as FoodCatalogEntry;
  }

  // Insert new entry
  const { data: inserted, error } = await db
    .from("wellness_food_catalog")
    .insert({
      canonical_name: food.canonical_name,
      brand: food.brand,
      input_aliases: [inputAlias],
      calories: food.calories,
      protein_g: food.protein_g,
      carbs_g: food.carbs_g,
      fat_g: food.fat_g,
      fiber_g: food.fiber_g,
      sugar_g: food.sugar_g,
      sodium_mg: food.sodium_mg,
      serving_size: food.serving_size,
      serving_unit: food.serving_unit,
      ingredients: food.ingredients,
      tags: food.tags,
      resolution_source: food.resolution_source,
      external_id: food.external_id,
      confidence: food.confidence,
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to insert food catalog entry: ${error.message}`);
  return inserted as FoodCatalogEntry;
}

async function updateMealTotals(mealItemId: string): Promise<void> {
  const db = getSupabase();

  // Get the meal entry ID for this item
  const { data: item } = await db
    .from("wellness_meal_items")
    .select("meal_entry_id")
    .eq("id", mealItemId)
    .single();

  if (!item) return;

  // Sum all items for this meal
  const { data: items } = await db
    .from("wellness_meal_items")
    .select("calories, protein_g, carbs_g, fat_g")
    .eq("meal_entry_id", item.meal_entry_id);

  if (!items) return;

  const totals = items.reduce(
    (acc, i) => ({
      total_calories: acc.total_calories + (i.calories || 0),
      total_protein_g: acc.total_protein_g + (i.protein_g || 0),
      total_carbs_g: acc.total_carbs_g + (i.carbs_g || 0),
      total_fat_g: acc.total_fat_g + (i.fat_g || 0),
    }),
    { total_calories: 0, total_protein_g: 0, total_carbs_g: 0, total_fat_g: 0 }
  );

  await db
    .from("wellness_meal_entries")
    .update(totals)
    .eq("id", item.meal_entry_id);
}

// --- Tagging ---

function generateTags(
  nutrients: Record<string, number | null | undefined>,
  ingredientsText?: string | null
): string[] {
  const tags: string[] = [];

  const cal = nutrients["energy-kcal_serving"] ?? nutrients.calories;
  const protein = nutrients.proteins_serving ?? nutrients.protein_g;
  const sugar = nutrients.sugars_serving ?? nutrients.sugar_g;
  const fiber = nutrients.fiber_serving ?? nutrients.fiber_g;

  if (protein != null && protein > 20) tags.push("high_protein");
  if (sugar != null && sugar > 15) tags.push("high_sugar");
  if (fiber != null && fiber > 5) tags.push("high_fiber");
  if (cal != null && cal < 150) tags.push("low_calorie");
  if (cal != null && cal > 500) tags.push("high_calorie");

  if (ingredientsText) {
    const lower = ingredientsText.toLowerCase();
    const ultraProcessedSignals = [
      "high fructose corn syrup", "maltodextrin", "artificial flavor",
      "hydrogenated", "modified starch", "sodium benzoate",
      "artificial color", "aspartame", "sucralose",
    ];
    const matchCount = ultraProcessedSignals.filter((s) => lower.includes(s)).length;
    const ingredientCount = ingredientsText.split(",").length;

    if (matchCount >= 1 || ingredientCount > 15) tags.push("ultra_processed");
  }

  return tags;
}

// --- Helpers ---

function parseServingSize(raw: string | null | undefined): { size: number | null; unit: string | null } {
  if (!raw) return { size: null, unit: null };

  const match = raw.match(/([\d.]+)\s*(\w+)/);
  if (match) {
    return { size: parseFloat(match[1]), unit: match[2] };
  }
  return { size: null, unit: raw };
}

// --- Manual Correction ---

export async function correctFood(
  foodName: string,
  corrections: Partial<{
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
    sugar_g: number;
    serving_size: number;
    serving_unit: string;
    tags: string[];
  }>
): Promise<FoodCatalogEntry | null> {
  const db = getSupabase();

  // Find the food
  const { data: food } = await db
    .from("wellness_food_catalog")
    .select("*")
    .ilike("canonical_name", `%${foodName}%`)
    .limit(1)
    .single();

  if (!food) return null;

  // Apply corrections
  const update: Record<string, unknown> = {
    ...corrections,
    verified: true,
    confidence: 1.0,
    resolution_source: "manual",
  };

  const { data: updated, error } = await db
    .from("wellness_food_catalog")
    .update(update)
    .eq("id", food.id)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to correct food: ${error.message}`);
  return updated as FoodCatalogEntry;
}

// --- Caffeine Detection (for tagging during capture) ---

export function isCaffeinated(foodName: string): boolean {
  const lower = foodName.toLowerCase();
  const caffeineKeywords = [
    "coffee", "espresso", "latte", "cappuccino", "americano",
    "tea", "matcha", "green tea", "black tea",
    "energy drink", "red bull", "monster", "celsius",
    "pre-workout", "cold brew",
  ];
  return caffeineKeywords.some((k) => lower.includes(k));
}
