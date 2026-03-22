// ============================================================
// OPEN WELLNESS — wellness_query MCP Tool
// Retrieves wellness data based on natural language questions.
// Uses structured queries, NOT LLM interpretation of data.
// ============================================================

import { getSupabase } from "../modules/db.ts";

export const WELLNESS_QUERY_TOOL = {
  name: "wellness_query",
  description: `Query your wellness data. Ask about meals, sleep, supplements, symptoms, habits, hydration, or workouts over any time range.

Examples:
- "what did I eat yesterday?"
- "how has my sleep been this week?"
- "show me my energy ratings for the last 7 days"
- "what supplements have I been taking?"
- "what did I log today?"`,
  inputSchema: {
    type: "object" as const,
    properties: {
      category: {
        type: "string",
        enum: ["meals", "sleep", "supplements", "symptoms", "habits", "hydration", "workouts", "bathroom", "all"],
        description: "Which data category to query. Use 'all' for a complete day summary.",
      },
      days_back: {
        type: "number",
        description: "How many days to look back. Default 7.",
      },
      date: {
        type: "string",
        description: "Specific date (YYYY-MM-DD) to query. Overrides days_back.",
      },
      metric: {
        type: "string",
        description: "For symptoms: filter by specific metric (energy, focus, mood, etc.)",
      },
    },
    required: ["category"],
  },
};

export async function handleWellnessQuery(args: {
  category: string;
  days_back?: number;
  date?: string;
  metric?: string;
}) {
  const db = getSupabase();
  const tz = "America/New_York";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });

  let startDate: string;
  let endDate: string;

  if (args.date) {
    startDate = args.date;
    endDate = args.date;
  } else {
    const daysBack = args.days_back || 7;
    const start = new Date();
    start.setDate(start.getDate() - daysBack);
    startDate = start.toLocaleDateString("en-CA", { timeZone: tz });
    endDate = today;
  }

  const result: Record<string, unknown> = {
    period: { start: startDate, end: endDate },
  };

  const categories = args.category === "all"
    ? ["meals", "sleep", "supplements", "symptoms", "habits", "hydration", "workouts", "bathroom"]
    : [args.category];

  for (const cat of categories) {
    switch (cat) {
      case "meals": {
        const { data: meals } = await db
          .from("wellness_meal_entries")
          .select("entry_date, meal_type, time_approx, total_calories, total_protein_g, total_carbs_g, total_fat_g")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate)
          .order("entry_date", { ascending: false });

        // Get items for these meals
        const mealIds = (meals || []).map((m: { id?: string }) => m.id).filter(Boolean);
        let items: unknown[] = [];
        if (meals && meals.length > 0) {
          // Fetch items separately with meal info
          const { data: mealWithItems } = await db
            .from("wellness_meal_entries")
            .select(`
              entry_date, meal_type, time_approx,
              wellness_meal_items (input_name, input_quantity, input_unit, calories, protein_g, carbs_g, fat_g, resolution_status)
            `)
            .gte("entry_date", startDate)
            .lte("entry_date", endDate)
            .order("entry_date", { ascending: false });

          result.meals = mealWithItems || meals;
        } else {
          result.meals = [];
        }
        break;
      }

      case "sleep": {
        const { data } = await db
          .from("wellness_sleep_entries")
          .select("entry_date, duration_hours, quality_rating, bed_time, wake_time, interruptions, notes")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate)
          .order("entry_date", { ascending: false });
        result.sleep = data || [];
        break;
      }

      case "supplements": {
        const { data } = await db
          .from("wellness_supplement_entries")
          .select("entry_date, name, dose, time_approx")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate)
          .order("entry_date", { ascending: false });
        result.supplements = data || [];
        break;
      }

      case "symptoms": {
        let query = db
          .from("wellness_symptom_checkins")
          .select("entry_date, metric, rating, time_of_day, notes")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate);

        if (args.metric) {
          query = query.eq("metric", args.metric);
        }

        const { data } = await query.order("entry_date", { ascending: false });
        result.symptoms = data || [];

        // Compute averages if multiple days
        if (data && data.length > 0) {
          const grouped: Record<string, number[]> = {};
          for (const row of data) {
            if (!grouped[row.metric]) grouped[row.metric] = [];
            grouped[row.metric].push(row.rating);
          }
          const avgs: Record<string, number> = {};
          for (const [m, ratings] of Object.entries(grouped)) {
            avgs[m] = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
          }
          result.symptom_averages = avgs;
        }
        break;
      }

      case "habits": {
        const { data } = await db
          .from("wellness_habit_entries")
          .select("entry_date, name, completed, duration_minutes, notes")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate)
          .order("entry_date", { ascending: false });
        result.habits = data || [];
        break;
      }

      case "hydration": {
        const { data } = await db
          .from("wellness_hydration_entries")
          .select("entry_date, amount_oz, notes")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate)
          .order("entry_date", { ascending: false });
        result.hydration = data || [];
        break;
      }

      case "workouts": {
        const { data } = await db
          .from("wellness_workout_entries")
          .select("entry_date, workout_type, duration_minutes, intensity, notes")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate)
          .order("entry_date", { ascending: false });
        result.workouts = data || [];
        break;
      }

      case "bathroom": {
        const { data } = await db
          .from("wellness_bathroom_entries")
          .select("entry_date, entry_type, count, time_of_day, notes")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate)
          .order("entry_date", { ascending: false });
        result.bathroom = data || [];
        break;
      }
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
