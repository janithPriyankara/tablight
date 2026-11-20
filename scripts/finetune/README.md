# Fine-tuning the tab embedding model

Build-time only: these scripts are not shipped in the extension. They fine-tune
[BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (MIT licence; the same weights
Xenova/bge-small-en-v1.5 converts) on Tablight's labelled pool and export it in the layout transformers.js loads
offline (`dtype: 'q8'`, mean pooling, normalize), under the model id `tablight/bge-small-tabs-v1`.

Title + URL only: the text embedded is `embedText(row)` (src/shared/url.ts), ported to Python in `embedtext.py`.
The pool is the one `scripts/train-head.mjs` reads; the blind test sets (tests/quality/holdout*.json,
youtube-messy.json, sessions.json, tests/benchmark/) are never read.

## Setup (uv, Apple silicon)

```sh
uv venv --python 3.12 ../ft-venv              # anywhere outside the repo
VIRTUAL_ENV=../ft-venv uv pip install -r scripts/finetune/requirements.txt
export HF_HOME=/path/to/hf-cache               # the base model downloads here once
```

Node (the repo's `npm ci`) is needed too: `labels.mjs` reads the labels and their seed descriptions from
src/classify/seeds.ts.

## Commands

```sh
# Fine-tune on the Mac GPU (mps). Writes the model to DIR, DIR/calibration.json (pool keys `url\ntitle` held out
# from the encoder, for train-head CALIBRATION=...) and DIR/finetune.json (settings, per-epoch calibration scores).
python scripts/finetune/finetune.py --pool training/ --out DIR --calib-share 0.2 --seed 1 [--extra FILE...] \
  [--loss mnrl-seeds|triplet] [--epochs 4] [--lr 2e-5] [--batch-size 32]

# Export to MODELS_ROOT/tablight/bge-small-tabs-v1 (config + tokenizer files, onnx/model_quantized.onnx) and check
# int8 ONNX vs PyTorch parity on 500 pool rows; exits 1 if the mean cosine is under 0.99.
python scripts/finetune/export.py --model DIR --out MODELS_ROOT/tablight/bge-small-tabs-v1

# Use it from JS: the head's threshold and similarity must be chosen on the calibration rows (rows the encoder never
CALIBRATION=DIR/calibration.json MODEL_ID=tablight/bge-small-tabs-v1 MODEL_PATH=MODELS_ROOT node scripts/train-head.mjs

# Tests: the Python embedText matches the TS one (fixture), and the pool files match train-head.mjs.
python -m pytest -q scripts/finetune/test_embedtext.py

# Regenerate the fixture after changing src/shared/url.ts (--all OUT writes every pool row, for a full check).
node scripts/finetune/gen-fixture.mjs
```

## How it trains

- The pool is split by label 80/20 (`--calib-share`, `--seed`). The encoder trains on the 80%; the 20%
  calibration split is never shown to it. Rows from `--extra` files (public data) join the training side only.
- `--loss mnrl-seeds` (default): MultipleNegativesRanking of each row against its label's description (group name
  and seeds from seeds.ts), one row per label per batch so no description is a false negative.
  `--loss triplet`: batch-all triplet loss over labels with cosine distance (`--margin`, batches grouped by label).
- Pooling is mean + normalize, as the product embeds (bge's own sentence-transformers config uses CLS).
- After every epoch the calibration rows are classified by the product's neighbour vote (10 nearest training rows,
  weights exp(10 · cosine)); the epoch with the best accuracy is the one saved.

## How it exports

optimum's ONNX export of the bare transformer (output `last_hidden_state`; pooling stays in the product), then
dynamic int8 quantisation with optimum's arm64 config (no avx512_vnni assumptions) and per-channel symmetric int8
weights. Per-tensor weights (as the Xenova file uses) drifted to 0.978 mean cosine on a fine-tuned model;
per-channel holds 0.999 at the same size (~34 MB) and speed. The file loads in onnxruntime-web (WASM) and in
transformers.js with `dtype: 'q8'`.
`tablight/bge-small-tabs-v1` (committed under public/models/) is the `--seed 2 --loss mnrl-seeds --epochs 5 --lr 2e-5`
run (epoch 3 kept). Its held-out keys are [calibration-bge-small-tabs-v1.json](calibration-bge-small-tabs-v1.json)
(1244 pool rows): `npm run train:head` uses that file by default for this model and reproduces src/classify/head.json
(threshold 0.25, similarity 0.71; youtubeThreshold 0.13 comes from `scripts/tune-youtube-bar.mjs` with the same file),
and `node scripts/measure-similarity.mjs` measures the search and clustering cut-offs on the same rows.
