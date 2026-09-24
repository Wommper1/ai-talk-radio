# King Orion LoRA staging area

The initial dataset contains twenty hand-written Night Court exchanges, split
into King Orion and Maeve training rows. Saved Orion episodes can add reviewed
examples through the keeper button in the transcript player. Court ratings are
kept separate from the ordinary station DJs.

Run `npm run orion:export` to rebuild `data/train.jsonl` and `data/eval.jsonl`.
Do not train until the collection has at least 500 human-approved court lines
and the selected base model's license is suitable for the intended use.
