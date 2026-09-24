import fs from "node:fs";
import path from "node:path";

/** Write beside the target, then replace it so readers never see half a file. */
export function atomicWriteText(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(temporary, text, "utf8");
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export function atomicWriteJson(target: string, value: unknown, trailingNewline = true): void {
  atomicWriteText(target, `${JSON.stringify(value, null, 2)}${trailingNewline ? "\n" : ""}`);
}
