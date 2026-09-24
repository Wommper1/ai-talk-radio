import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../lib/atomic-file.ts";
import type { Turn } from "./conversation.ts";

const DRAFT_DIR = path.join(process.cwd(), "output", "drafts");

export interface ShowDraft {
  id: string;
  topic: string;
  station: string;
  style: string;
  mood: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
}

function safe(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,119}$/i.test(id) && !id.includes("..");
}

function fileFor(id: string): string {
  return path.join(DRAFT_DIR, `${id}.json`);
}

export function saveDraft(draft: ShowDraft): void {
  if (!safe(draft.id)) return;
  atomicWriteJson(fileFor(draft.id), draft);
}

export function removeDraft(id: string): void {
  if (!safe(id)) return;
  fs.rmSync(fileFor(id), { force: true });
}

export function readDraft(id: string): ShowDraft | null {
  if (!safe(id)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(fileFor(id), "utf8")) as ShowDraft;
    return value && Array.isArray(value.turns) ? value : null;
  } catch {
    return null;
  }
}

export function listDrafts(): ShowDraft[] {
  if (!fs.existsSync(DRAFT_DIR)) return [];
  return fs.readdirSync(DRAFT_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readDraft(name.slice(0, -5)))
    .filter((draft): draft is ShowDraft => Boolean(draft?.turns.length))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
