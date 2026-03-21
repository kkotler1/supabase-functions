// ============================================================
// OPEN WELLNESS — log_wellness MCP Tool
// ============================================================

import { captureWellnessEntry } from "../modules/capture.ts";

export const LOG_WELLNESS_TOOL = {
  name: "log_wellness",
  description: `Log wellness data from freeform text. Describe your meals, sleep, supplements, energy, mood, focus, habits, hydration, workouts — anything about your day. The system will parse and structure it automatically.

Examples:
- "Had oatmeal and coffee for breakfast, energy is about a 6"
- "Slept 7 hours, took vitamin D and magnesium, went for a 30 min walk"
- "Lunch was a chipotle bowl. Focus has been great today, maybe 8/10. Drank about 5 glasses of water."`,
  inputSchema: {
    type: "object" as const,
    properties: {
      content: {
        type: "string",
        description: "Freeform text describing wellness data — meals, sleep, symptoms, supplements, habits, etc.",
      },
      date: {
        type: "string",
        description: "ISO date override (YYYY-MM-DD). Defaults to today.",
      },
      timezone: {
        type: "string",
        description: "Timezone for date calculation. Defaults to America/New_York.",
      },
    },
    required: ["content"],
  },
};

export async function handleLogWellness(args: {
  content: string;
  date?: string;
  timezone?: string;
}) {
  const result = await captureWellnessEntry(args.content, {
    date: args.date,
    timezone: args.timezone || "America/New_York",
    source: "mcp",
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "logged",
          raw_entry_id: result.raw_entry_id,
          summary: result.summary,
          details: {
            meals: result.parsed.meals.length,
            meal_items: result.inserted.meal_items,
            sleep: result.inserted.sleep > 0,
            supplements: result.inserted.supplements,
            symptoms: result.inserted.symptoms,
            habits: result.inserted.habits,
            hydration: result.inserted.hydration > 0,
            workouts: result.inserted.workouts,
          },
          parsed: result.parsed,
          food_resolutions: result.food_resolutions,
          warnings: result.warnings,
        }, null, 2),
      },
    ],
  };
}
