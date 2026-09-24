import fs from "node:fs";
import path from "node:path";
import { trainingJsonl } from "../server/memory/djfeedback.ts";
import { orionTrainingReadiness, orionTrainingSplit } from "../server/orion/training.ts";

const outDir = path.join(process.cwd(), "training", "orion-lora", "data");
fs.mkdirSync(outDir, { recursive: true });
const split = orionTrainingSplit();
fs.writeFileSync(path.join(outDir, "train.jsonl"), trainingJsonl(split.train), "utf-8");
fs.writeFileSync(path.join(outDir, "eval.jsonl"), trainingJsonl(split.evaluation), "utf-8");

const readiness = orionTrainingReadiness();
console.log(JSON.stringify({ ...readiness, trainRows: split.train.length, evalRows: split.evaluation.length }, null, 2));
if (!readiness.readyForLora) console.log("Royal training data is staged, but LoRA training should wait for the keeper target.");
