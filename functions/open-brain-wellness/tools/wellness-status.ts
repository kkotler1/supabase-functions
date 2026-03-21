// ============================================================
// OPEN WELLNESS — wellness_status MCP Tool
// ============================================================

import { getTodayStatus, getRecentSymptomAverages, getTrackingStreak } from "../modules/db.ts";

export const WELLNESS_STATUS_TOOL = {
  name: "wellness_status",
  description: `Get a quick snapshot of your wellness tracking status. Shows today's entries, streaks, data completeness, and recent symptom averages.`,
  inputSchema: {
    type: "object" as const,
    properties: {
      timezone: {
        type: "string",
        description: "Timezone for date calculation. Defaults to America/New_York.",
      },
    },
  },
};

export async function handleWellnessStatus(args: { timezone?: string }) {
  const tz = args.timezone || "America/New_York";

  const [today, averages, streak] = await Promise.all([
    getTodayStatus(tz),
    getRecentSymptomAverages(7, tz),
    getTrackingStreak(tz),
  ]);

  const todaySummary = {
    date: today.date,
    meals_logged: today.meals.length,
    meal_types: today.meals.map((m: { meal_type: string }) => m.meal_type),
    sleep_logged: today.sleep.length > 0,
    sleep_details: today.sleep[0] || null,
    supplements: today.supplements.map((s: { name: string; dose: string }) => `${s.name}${s.dose ? ` (${s.dose})` : ""}`),
    symptom_checkins: today.symptoms.map((s: { metric: string; rating: number }) => `${s.metric}: ${s.rating}/10`),
    habits: today.habits.map((h: { name: string; completed: boolean }) => `${h.name}: ${h.completed ? "✓" : "✗"}`),
    hydration_oz: today.hydration.reduce((sum: number, h: { amount_oz: number }) => sum + (h.amount_oz || 0), 0),
    workouts: today.workouts.map((w: { workout_type: string; duration_minutes: number; intensity: string }) =>
      `${w.workout_type}${w.duration_minutes ? ` ${w.duration_minutes}min` : ""}${w.intensity ? ` (${w.intensity})` : ""}`
    ),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          today: todaySummary,
          streak: streak,
          recent_7day_averages: averages,
        }, null, 2),
      },
    ],
  };
}
