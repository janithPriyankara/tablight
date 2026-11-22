"""Exports a fine-tuned model (finetune.py output) to the Xenova layout transformers.js loads offline. Build-time only.

    python scripts/finetune/export.py --model DIR --out MODELS_ROOT/tablight/bge-small-tabs-v1

Writes OUT/config.json, tokenizer.json, tokenizer_config.json, special_tokens_map.json and
OUT/onnx/model_quantized.onnx (what transformers.js loads for dtype 'q8'): optimum's ONNX export of the bare
transformer (output last_hidden_state; pooling stays in the product), then dynamic int8 quantisation with the arm64
config (no avx512_vnni assumptions; runs on Apple silicon and in onnxruntime-web).

Parity: embeds 500 pool rows (their embedText, as the product does) with the PyTorch model and with the int8 ONNX
model (mean pooling + normalize), prints mean/min cosine, and exits 1 if the mean is under 0.99.
"""

from __future__ import annotations

import argparse
import random
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

from embedtext import embed_text  # noqa: E402
from finetune import load_labels, load_pool  # noqa: E402

TOKENIZER_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]
PARITY_ROWS = 500
PARITY_MIN_MEAN = 0.99


def onnx_embed(session, tokenizer, texts: list[str], batch: int = 64):
    import numpy as np

    names = {i.name for i in session.get_inputs()}
    out = []
    for i in range(0, len(texts), batch):
        enc = tokenizer(texts[i : i + batch], padding=True, truncation=True, max_length=512, return_tensors="np")
        feed = {k: v.astype(np.int64) for k, v in enc.items() if k in names}
        if "token_type_ids" in names and "token_type_ids" not in feed:
            feed["token_type_ids"] = np.zeros_like(feed["input_ids"])
        hidden = session.run(["last_hidden_state"], feed)[0]
        mask = enc["attention_mask"][..., None].astype(np.float32)
        v = (hidden * mask).sum(1) / np.clip(mask.sum(1), 1e-9, None)
        out.append(v / np.linalg.norm(v, axis=1, keepdims=True))
    return np.concatenate(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="finetune.py output dir")
    ap.add_argument("--out", required=True, help="e.g. MODELS_ROOT/tablight/bge-small-tabs-v1")
    ap.add_argument("--pool", default=str(ROOT / "training"), help="dir holding train-a..f.json (parity rows)")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    import numpy as np
    import onnxruntime as ort
    from optimum.exporters.onnx import main_export
    from optimum.onnxruntime import ORTQuantizer
    from optimum.onnxruntime.configuration import AutoQuantizationConfig
    from sentence_transformers import SentenceTransformer
    from transformers import AutoTokenizer

    model_dir = Path(args.model)
    out = Path(args.out)
    (out / "onnx").mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        # library_name="transformers": the bare BertModel (last_hidden_state), not a sentence-transformers wrapper.
        main_export(str(model_dir), output=tmp, task="feature-extraction", library_name="transformers")
        quantizer = ORTQuantizer.from_pretrained(tmp, file_name="model.onnx")
        qconfig = AutoQuantizationConfig.arm64(is_static=False, per_channel=True)
        qdir = Path(tmp) / "q"
        quantizer.quantize(save_dir=str(qdir), quantization_config=qconfig)
        shutil.copyfile(qdir / "model_quantized.onnx", out / "onnx" / "model_quantized.onnx")
    for f in TOKENIZER_FILES:
        shutil.copyfile(model_dir / f, out / f)
    size = (out / "onnx" / "model_quantized.onnx").stat().st_size
    print(f"wrote {out} (model_quantized.onnx {size / 1e6:.1f} MB)")

    # ---------- parity ----------
    labels = {g["id"] for g in load_labels()}
    pool = load_pool(Path(args.pool), labels)
    rows = random.Random(args.seed).sample(pool, min(PARITY_ROWS, len(pool)))
    texts = [embed_text(r) for r in rows]
    st = SentenceTransformer(str(model_dir), device="cpu")
    ref = st.encode(texts, batch_size=64, normalize_embeddings=True, convert_to_numpy=True)
    session = ort.InferenceSession(str(out / "onnx" / "model_quantized.onnx"), providers=["CPUExecutionProvider"])
    got = onnx_embed(session, AutoTokenizer.from_pretrained(str(out)), texts)
    cos = (ref * got).sum(1)
    mean, low = float(np.mean(cos)), float(np.min(cos))
    print(f"parity int8 ONNX vs PyTorch on {len(texts)} pool rows: mean cosine {mean:.4f}, min {low:.4f}")
    if mean < PARITY_MIN_MEAN:
        raise SystemExit(f"parity mean {mean:.4f} < {PARITY_MIN_MEAN}")


if __name__ == "__main__":
    main()
