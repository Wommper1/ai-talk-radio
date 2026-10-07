/**
 * Read-only summary of the durable unattended-certification state.
 * No server, model, audio engine or network connection is started.
 */
import fs from "node:fs";
import path from "node:path";
import type { AutomationSettings, ScheduleSlot, StationMonitorEvent } from "../shared/station-automation.ts";

interface StoredAutomationState {
  settings?: AutomationSettings;
  events?: StationMonitorEvent[];
  lastDailyBackup?: string;
}

type CertificationState = "not-configured" | "pending" | "retrying" | "blocked" | "certified";

function findCertification(slots: ScheduleSlot[]): ScheduleSlot | undefined {
  return slots.find((slot) => (slot.turns ?? 0) >= 24 && /certif/i.test(`${slot.id} ${slot.name}`));
}

function classify(slot: ScheduleSlot | undefined): { state: CertificationState; certified: boolean; detail: string } {
  if (!slot) return { state: "not-configured", certified: false, detail: "No 24-turn certification slot is configured." };
  if (slot.lastFinishedAt && slot.lastShowId && !slot.lastError) {
    return {
      state: "certified",
      certified: true,
      detail: `Finished show ${slot.lastShowId} at ${slot.lastFinishedAt}.`,
    };
  }
  if (slot.retryAt) {
    return {
      state: "retrying",
      certified: false,
      detail: `Retry scheduled for ${slot.retryAt}: ${slot.lastError ?? "unknown error"}`,
    };
  }
  if (slot.lastError) {
    return { state: "blocked", certified: false, detail: slot.lastError };
  }
  if (slot.lastStartedAt) {
    return {
      state: "pending",
      certified: false,
      detail: `Started at ${slot.lastStartedAt}, but no finished show was recorded.`,
    };
  }
  return { state: "pending", certified: false, detail: "The certification slot has not run yet." };
}

const statePath = path.join(process.cwd(), "data", "station-automation.json");
const jsonMode = process.argv.includes("--json");

try {
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8")) as StoredAutomationState;
  if (!stored.settings || !Array.isArray(stored.settings.slots)) {
    throw new Error("the state file does not contain automation settings");
  }
  const slot = findCertification(stored.settings.slots);
  const result = classify(slot);
  const recentEvents = (Array.isArray(stored.events) ? stored.events : []).slice(-8);
  const report = {
    generatedAt: new Date().toISOString(),
    statePath,
    ...result,
    automationEnabled: stored.settings.enabled,
    monitorEnabled: stored.settings.monitorEnabled,
    lastDailyBackup: stored.lastDailyBackup ?? null,
    slot: slot ?? null,
    recentEvents,
    nextAction: result.certified
      ? "Preserve the finished show and update the readiness evidence."
      : "When the PC is quiet, load the radio's intended DJ model, start its local API, reset or recreate the certification slot in Operations, and let all 24 turns finish without intervention.",
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("AI Talk Radio — unattended certification");
    console.log(`State: ${result.state.toUpperCase()}`);
    console.log(`Certified: ${result.certified ? "yes" : "no"}`);
    console.log(`Detail: ${result.detail}`);
    console.log(`Automation: ${stored.settings.enabled ? "enabled" : "disabled"}`);
    console.log(`Daily backup: ${stored.lastDailyBackup ?? "no completed date recorded"}`);
    console.log(`Recent events shown by --json: ${recentEvents.length}`);
    console.log(`Next: ${report.nextAction}`);
  }
} catch (error) {
  console.error(`Could not read unattended certification state at ${statePath}: ${(error as Error).message}`);
  process.exitCode = 1;
}
