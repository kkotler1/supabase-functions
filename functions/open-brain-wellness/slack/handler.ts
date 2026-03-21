// ============================================================
// OPEN WELLNESS — Slack Event Handler
// Handles incoming messages from the #wellness Slack channel.
// Parses wellness data and posts brief confirmation.
// ============================================================

import { captureWellnessEntry } from "../modules/capture.ts";

// --- Signature Verification ---

export async function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string
): Promise<boolean> {
  const signingSecret = Deno.env.get("SLACK_SIGNING_SECRET");
  if (!signingSecret) {
    console.error("SLACK_SIGNING_SECRET not set");
    return false;
  }

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    console.error("Slack request too old");
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sigBasestring));
  const computed = `v0=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  return computed === signature;
}

// --- Slack Message Formatting Cleanup ---

function cleanSlackText(text: string): string {
  // Remove Slack-specific formatting
  return text
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, "$1") // <url|label> → label
    .replace(/<https?:\/\/[^>]+>/g, "")               // <url> → remove
    .replace(/<@[A-Z0-9]+>/g, "")                      // <@USER> → remove
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")         // <#CHANNEL|name> → #name
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

// --- Process Message ---

export async function processWellnessSlackMessage(
  text: string,
  channel: string,
  ts: string
): Promise<void> {
  const cleanedText = cleanSlackText(text);

  if (!cleanedText || cleanedText.length < 3) {
    return; // Ignore empty/tiny messages
  }

  try {
    const result = await captureWellnessEntry(cleanedText, {
      source: "slack",
      slack_ts: ts,
      timezone: "America/New_York",
    });

    // Post confirmation to Slack
    if (result.summary === "No wellness data detected.") {
      await postSlackMessage(
        channel,
        "⚠️ Couldn't extract wellness data from that. Try describing meals, sleep, energy, supplements, etc.",
        ts
      );
    } else {
      await postSlackMessage(channel, `✅ Logged: ${result.summary}`, ts);
    }
  } catch (err) {
    console.error("Slack processing error:", err);
    await postSlackMessage(
      channel,
      "❌ Error processing wellness entry. Raw text was saved.",
      ts
    );
  }
}

// --- Post to Slack ---

async function postSlackMessage(
  channel: string,
  text: string,
  threadTs?: string
): Promise<void> {
  const token = Deno.env.get("SLACK_BOT_TOKEN");
  if (!token) {
    console.error("SLACK_BOT_TOKEN not set");
    return;
  }

  try {
    const body: Record<string, string> = { channel, text };
    if (threadTs) {
      body.thread_ts = threadTs; // Reply in thread to keep channel clean
    }

    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      console.error("Slack postMessage failed:", resp.status, await resp.text());
    } else {
      const data = await resp.json();
      if (!data.ok) {
        console.error("Slack API error:", data.error);
      }
    }
  } catch (err) {
    console.error("Failed to post to Slack:", err);
  }
}
