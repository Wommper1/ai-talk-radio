# DJ LoRA staging area

The app builds training data from two sources:

- Hand-written DJ school examples in `server/pipeline/djexamples.ts`.
- Generated lines explicitly marked **Keeper** in the show player.

Run `npm run dj:export` to create `data/train.jsonl` and `data/eval.jsonl`.
The exporter intentionally reports the dataset as not ready until it contains
at least 500 reviewed keeper lines. Rejected lines are retained as evaluation
evidence but never placed in supervised fine-tuning output.

Do not train an adapter on the current Stheno base for commercial deployment:
its published license is noncommercial. Choose the final commercially
compatible base model first, then collect and export examples for that model's
chat template. Training itself is deliberately not automatic; it requires a
separate CUDA training environment and a reviewed base-model license.
