import fs from "node:fs";
import path from "node:path";
import { djTrainingReadiness, djTrainingSplit, trainingJsonl } from "../server/memory/djfeedback.ts";

const outDir = path.join(process.cwd(), "training", "dj-lora", "data");
fs.mkdirSync(outDir, { recursive: true });

const split = djTrainingSplit();
fs.writeFileSync(path.join(outDir, "train.jsonl"), trainingJsonl(split.train), "utf-8");
fs.writeFileSync(path.join(outDir, "eval.jsonl"), trainingJsonl(split.evaluation), "utf-8");

const readiness = djTrainingReadiness();
console.log(JSON.stringify({ ...readiness, trainRows: split.train.length, evalRows: split.evaluation.length }, null, 2));
if (!readiness.readyForLora) console.log("Export created for inspection, but training should wait for the keeper target.");
