import fs from "node:fs";
import path from "node:path";

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400];
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const waitCell = new Int32Array(new SharedArrayBuffer(4));

/** Write beside the target, then replace it so readers never see half a file. */
export function atomicWriteText(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(temporary, text, "utf8");
    // Windows can briefly hold the old file open after a reader or virus scan.
    // Retry the atomic replacement; deleting the target first would expose a
    // missing file to readers and defeat the point of this helper.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, target);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= RENAME_RETRY_DELAYS_MS.length || !RENAME_RETRY_CODES.has(code ?? "")) {
          throw error;
        }
        Atomics.wait(waitCell, 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export function atomicWriteJson(target: string, value: unknown, trailingNewline = true): void {
  atomicWriteText(target, `${JSON.stringify(value, null, 2)}${trailingNewline ? "\n" : ""}`);
}
