// ============================================================
// OPEN WELLNESS — resolve_food MCP Tool
// Look up, correct, or re-resolve food items in the catalog.
// ============================================================

import { getSupabase } from "../modules/db.ts";
import { resolveFood, correctFood } from "../modules/food-resolver.ts";

export const RESOLVE_FOOD_TOOL = {
  name: "resolve_food",
  description: `Look up or correct a food item in the catalog. Use this to:
- Check what nutrition data we have for a food
- Manually correct calories/macros for a food
- Force re-resolution of a food from external APIs
- Browse the food catalog

Examples:
- "look up Yasso mint chocolate chip bar"
- "correct black coffee to 5 calories"
- "what foods are in my catalog?"
- "re-resolve chipotle burrito bowl"`,
  inputSchema: {
    type: "object" as const,
    properties: {
      food_name: {
        type: "string",
        description: "Food to look up, correct, or re-resolve.",
      },
      action: {
        type: "string",
        enum: ["lookup", "correct", "re_resolve", "list_catalog", "list_unverified"],
        description: "Action to perform. Default: lookup.",
      },
      corrections: {
        type: "object",
        description: "For 'correct' action — fields to override.",
        properties: {
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          fiber_g: { type: "number" },
          sugar_g: { type: "number" },
          serving_size: { type: "number" },
          serving_unit: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
    required: ["food_name"],
  },
};

export async function handleResolveFood(args: {
  food_name: string;
  action?: string;
  corrections?: Record<string, unknown>;
}) {
  const action = args.action || "lookup";
  const db = getSupabase();

  switch (action) {
    case "lookup": {
      // Try to find in catalog first
      const { data: existing } = await db
        .from("wellness_food_catalog")
        .select("*")
        .ilike("canonical_name", `%${args.food_name}%`)
        .limit(5);

      if (existing && existing.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              action: "lookup",
              found: existing.length,
              results: existing.map((f) => ({
                canonical_name: f.canonical_name,
                brand: f.brand,
                calories: f.calories,
                protein_g: f.protein_g,
                carbs_g: f.carbs_g,
                fat_g: f.fat_g,
                serving_size: f.serving_size,
                serving_unit: f.serving_unit,
                tags: f.tags,
                resolution_source: f.resolution_source,
                confidence: f.confidence,
                verified: f.verified,
              })),
            }, null, 2),
          }],
        };
      }

      // Not in catalog — resolve it
      const resolution = await resolveFood(args.food_name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "lookup",
            found_in_catalog: false,
            resolved_from: resolution.resolution_source,
            confidence: resolution.confidence,
            food: {
              canonical_name: resolution.food.canonical_name,
              brand: resolution.food.brand,
              calories: resolution.food.calories,
              protein_g: resolution.food.protein_g,
              carbs_g: resolution.food.carbs_g,
              fat_g: resolution.food.fat_g,
              serving_size: resolution.food.serving_size,
              serving_unit: resolution.food.serving_unit,
              tags: resolution.food.tags,
            },
            note: resolution.confidence < 0.5
              ? "Low confidence — consider using 'correct' action to verify."
              : undefined,
          }, null, 2),
        }],
      };
    }

    case "correct": {
      if (!args.corrections) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "corrections object required for 'correct' action",
              example: { calories: 100, protein_g: 5, carbs_g: 17, fat_g: 1 },
            }, null, 2),
          }],
        };
      }

      const corrected = await correctFood(args.food_name, args.corrections);
      if (!corrected) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Food "${args.food_name}" not found in catalog. Log a meal with it first, or use 'lookup' to resolve it.`,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "corrected",
            food: {
              canonical_name: corrected.canonical_name,
              brand: corrected.brand,
              calories: corrected.calories,
              protein_g: corrected.protein_g,
              carbs_g: corrected.carbs_g,
              fat_g: corrected.fat_g,
              serving_size: corrected.serving_size,
              serving_unit: corrected.serving_unit,
              tags: corrected.tags,
              verified: corrected.verified,
              confidence: corrected.confidence,
            },
            note: "Food marked as verified. Future logs of this food will use these values.",
          }, null, 2),
        }],
      };
    }

    case "re_resolve": {
      // Delete existing catalog entry and re-resolve fresh
      const { data: existing } = await db
        .from("wellness_food_catalog")
        .select("id")
        .ilike("canonical_name", `%${args.food_name}%`)
        .limit(1)
        .single();

      if (existing) {
        await db.from("wellness_food_catalog").delete().eq("id", existing.id);
      }

      const resolution = await resolveFood(args.food_name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "re_resolved",
            source: resolution.resolution_source,
            confidence: resolution.confidence,
            food: {
              canonical_name: resolution.food.canonical_name,
              brand: resolution.food.brand,
              calories: resolution.food.calories,
              protein_g: resolution.food.protein_g,
              carbs_g: resolution.food.carbs_g,
              fat_g: resolution.food.fat_g,
              serving_size: resolution.food.serving_size,
              serving_unit: resolution.food.serving_unit,
              tags: resolution.food.tags,
            },
          }, null, 2),
        }],
      };
    }

    case "list_catalog": {
      const { data: catalog } = await db
        .from("wellness_food_catalog")
        .select("canonical_name, brand, calories, protein_g, carbs_g, fat_g, resolution_source, confidence, verified")
        .order("canonical_name", { ascending: true })
        .limit(50);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "list_catalog",
            count: (catalog || []).length,
            foods: catalog || [],
          }, null, 2),
        }],
      };
    }

    case "list_unverified": {
      const { data: unverified } = await db
        .from("wellness_food_catalog")
        .select("canonical_name, brand, calories, resolution_source, confidence")
        .lt("confidence", 0.5)
        .eq("verified", false)
        .order("confidence", { ascending: true })
        .limit(20);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "list_unverified",
            count: (unverified || []).length,
            note: "These foods have low confidence and should be verified or re-resolved.",
            foods: unverified || [],
          }, null, 2),
        }],
      };
    }

    default:
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: `Unknown action: ${action}` }),
        }],
      };
  }
}
