"""Fine-tunes BAAI/bge-small-en-v1.5 on Tablight's labelled pool (Mac GPU via MPS). Build-time only, not shipped.

    python scripts/finetune/finetune.py --pool training/ --out DIR --calib-share 0.2 --seed 1 [--extra FILE...]

Writes a sentence-transformers model dir (mean pooling + normalize, as the product embeds) to DIR, the pool rows
held out from the encoder to DIR/calibration.json (keys `url\\ntitle`, as train-head.mjs keys rows), and the run's
settings and per-epoch calibration scores to DIR/finetune.json.

The pool is the one scripts/train-head.mjs reads (the blind test sets are never read). It is split by label, 80/20:
the encoder trains on the 80%, the 20% calibration split picks the epoch (kNN accuracy of calibration rows against
the training rows, the product's neighbour vote) and later sets the head's threshold (train-head CALIBRATION=...).
Rows from --extra files (public data) only ever join the training side.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

from embedtext import embed_text  # noqa: E402

# Same files, same order, as scripts/train-head.mjs (test_embedtext.py checks). `training/` paths are read from --pool.
POOL_FILES = [
    "training/train-a.json", "training/train-b.json", "training/train-c.json", "training/train-d.json",
    "training/train-e.json", "training/train-f.json",
    "tests/quality/fixture.json",
]
# The product's neighbour vote (train-head.mjs KNN): k nearest, each weighted exp(SHARP * cosine).
KNN_K = 10
KNN_SHARP = 10.0


def row_key(r: dict) -> str:
    return f"{r['url']}\n{r['title']}"


def load_labels() -> list[dict]:
    out = subprocess.run(
        ["node", str(HERE / "labels.mjs")], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    return json.loads(out)


def load_pool(pool_dir: Path, labels: set[str]) -> list[dict]:
    seen: set[str] = set()
    pool: list[dict] = []
    for f in POOL_FILES:
        path = pool_dir / f[len("training/"):] if f.startswith("training/") else ROOT / f
        for r in json.loads(path.read_text(encoding="utf-8")):
            if r["group"] not in labels:
                raise SystemExit(f'{path}: unknown group "{r["group"]}"')
            k = row_key(r)
            if k in seen:
                continue
            seen.add(k)
            pool.append({"title": r["title"], "url": r["url"], "group": r["group"]})
    return pool


def load_extra(files: list[str], labels: set[str], taken: set[str]) -> list[dict]:
    rows: list[dict] = []
    for f in files:
        for r in json.loads(Path(f).read_text(encoding="utf-8")):
            if r["group"] not in labels:
                raise SystemExit(f'{f}: unknown group "{r["group"]}"')
            k = row_key(r)
            if k in taken:
                continue
            taken.add(k)
            rows.append({"title": r["title"], "url": r["url"], "group": r["group"]})
    return rows


def stratified_split(pool: list[dict], share: float, seed: int) -> tuple[list[int], list[int]]:
    rng = random.Random(seed)
    by_label: dict[str, list[int]] = {}
    for i, r in enumerate(pool):
        by_label.setdefault(r["group"], []).append(i)
    train, calib = [], []
    for label in sorted(by_label):
        idx = by_label[label][:]
        rng.shuffle(idx)
        n = round(len(idx) * share)
        calib += idx[:n]
        train += idx[n:]
    return sorted(train), sorted(calib)


def knn_accuracy(model, train_texts, train_y, calib_texts, calib_y, n_labels: int) -> float:
    import torch

    a = model.encode(train_texts, batch_size=128, convert_to_tensor=True, normalize_embeddings=True)
    b = model.encode(calib_texts, batch_size=128, convert_to_tensor=True, normalize_embeddings=True)
    sims = b @ a.T
    top, idx = sims.topk(KNN_K, dim=1)
    w = torch.exp(KNN_SHARP * top)
    ty = torch.tensor(train_y, device=sims.device)
    votes = torch.zeros(len(calib_texts), n_labels, device=sims.device)
    votes.scatter_add_(1, ty[idx], w)
    pred = votes.argmax(dim=1).cpu().tolist()
    return sum(int(p == y) for p, y in zip(pred, calib_y)) / len(calib_y)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pool", default=str(ROOT / "training"), help="dir holding train-a..f.json")
    ap.add_argument("--out", required=True, help="model output dir")
    ap.add_argument("--calib-share", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--extra", nargs="*", default=[], help="extra training-only files of {title,url,group}")
    ap.add_argument("--base", default="BAAI/bge-small-en-v1.5")
    ap.add_argument(
        "--loss", choices=["mnrl-seeds", "triplet"], default="mnrl-seeds",
        help="mnrl-seeds: MultipleNegativesRanking of each row against its label's description (seeds.ts), one row "
        "per label per batch; triplet: batch-all triplet over labels (cosine distance)",
    )
    ap.add_argument("--epochs", type=int, default=4, help="max epochs; the best by calibration kNN is kept")
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--batch-size", type=int, default=32, help="mnrl-seeds: at most the label count")
    ap.add_argument("--margin", type=float, default=0.3, help="triplet margin (cosine distance)")
    ap.add_argument("--device", default="mps")
    args = ap.parse_args()

    import torch
    from datasets import Dataset
    from sentence_transformers import SentenceTransformer, SentenceTransformerTrainer, SentenceTransformerTrainingArguments
    from sentence_transformers.sentence_transformer import losses
    from sentence_transformers.sentence_transformer.modules import Normalize, Pooling, Transformer
    from sentence_transformers.sentence_transformer.training_args import BatchSamplers
    from transformers import TrainerCallback

    t0 = time.time()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    label_info = load_labels()
    labels = [g["id"] for g in label_info]
    label_set = set(labels)
    pool = load_pool(Path(args.pool), label_set)
    pool_hash = hashlib.sha256(json.dumps(pool, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    train_idx, calib_idx = stratified_split(pool, args.calib_share, args.seed)
    extra = load_extra(args.extra, label_set, {row_key(r) for r in pool})
    (out / "calibration.json").write_text(
        json.dumps([row_key(pool[i]) for i in calib_idx], ensure_ascii=False, indent=0) + "\n", encoding="utf-8"
    )
    train_rows = [pool[i] for i in train_idx] + extra
    calib_rows = [pool[i] for i in calib_idx]
    print(f"pool {len(pool)} rows ({pool_hash[:12]}), train {len(train_idx)} + extra {len(extra)}, calibration {len(calib_idx)}")

    # Pool rows only as neighbours for epoch selection, so --extra variants are judged on the same footing.
    knn_train_texts = [embed_text(pool[i]) for i in train_idx]
    knn_train_y = [labels.index(pool[i]["group"]) for i in train_idx]
    calib_texts = [embed_text(r) for r in calib_rows]
    calib_y = [labels.index(r["group"]) for r in calib_rows]

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    tr = Transformer(args.base, max_seq_length=512)
    model = SentenceTransformer(
        modules=[tr, Pooling(tr.auto_model.config.hidden_size, pooling_mode="mean"), Normalize()], device=args.device
    )

    texts = [embed_text(r) for r in train_rows]
    if args.loss == "triplet":
        data = Dataset.from_dict({"text": texts, "label": [labels.index(r["group"]) for r in train_rows]})
        loss = losses.BatchAllTripletLoss(
            model, distance_metric=losses.BatchHardTripletLossDistanceFunction.cosine_distance, margin=args.margin
        )
        sampler = BatchSamplers.GROUP_BY_LABEL
    else:
        desc = {g["id"]: f"{g['name']}: {'; '.join(g['seeds'])}" if g["seeds"] else g["name"] for g in label_info}
        data = Dataset.from_dict({"anchor": texts, "positive": [desc[r["group"]] for r in train_rows]})
        loss = losses.MultipleNegativesRankingLoss(model)
        # One row per label per batch: a second row of the same label would make its own description a false negative.
        sampler = BatchSamplers.NO_DUPLICATES

    history: list[dict] = []
    best = {"epoch": -1, "acc": -1.0}

    def evaluate(epoch: int) -> None:
        acc = knn_accuracy(model, knn_train_texts, knn_train_y, calib_texts, calib_y, len(labels))
        history.append({"epoch": epoch, "calib_knn_acc": acc, "elapsed_s": round(time.time() - t0, 1)})
        print(f"epoch {epoch}: calibration kNN accuracy {acc:.4f}", flush=True)
        if epoch > 0 and acc > best["acc"]:
            best.update(epoch=epoch, acc=acc)
            model.save(str(out))

    class EpochSelect(TrainerCallback):
        def on_epoch_end(self, _args, state, control, **kw):
            evaluate(round(state.epoch))
            model.train()

    evaluate(0)
    targs = SentenceTransformerTrainingArguments(
        output_dir=str(out / "_trainer"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        learning_rate=args.lr,
        warmup_ratio=0.1,
        seed=args.seed,
        batch_sampler=sampler,
        save_strategy="no",
        logging_steps=50,
        report_to="none",
        dataloader_drop_last=False,
    )
    trainer = SentenceTransformerTrainer(
        model=model, args=targs, train_dataset=data, loss=loss, callbacks=[EpochSelect()]
    )
    trainer.train()

    base_acc = history[0]["calib_knn_acc"]
    meta = {
        "base": args.base,
        "loss": args.loss,
        "epochs_max": args.epochs,
        "epoch_chosen": best["epoch"],
        "calib_knn_acc": best["acc"],
        "calib_knn_acc_base": base_acc,
        "lr": args.lr,
        "batch_size": args.batch_size,
        "margin": args.margin if args.loss == "triplet" else None,
        "seed": args.seed,
        "calib_share": args.calib_share,
        "pool_rows": len(pool),
        "pool_sha256": pool_hash,
        "train_rows": len(train_idx),
        "extra_files": args.extra,
        "extra_rows": len(extra),
        "calibration_rows": len(calib_idx),
        "pooling": "mean",
        "history": history,
        "wall_s": round(time.time() - t0, 1),
    }
    (out / "finetune.json").write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")
    trainer_dir = out / "_trainer"
    if trainer_dir.exists():
        import shutil

        shutil.rmtree(trainer_dir)
    if not math.isfinite(best["acc"]) or best["epoch"] < 1:
        raise SystemExit("no epoch was saved")
    print(
        f"kept epoch {best['epoch']}: calibration kNN {best['acc']:.4f} (base {base_acc:.4f}); "
        f"wall {meta['wall_s']} s -> {out}"
    )


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
