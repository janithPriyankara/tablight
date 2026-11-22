"""The Python embedText port matches the TypeScript function (fixture from gen-fixture.mjs), and finetune.py reads
the same pool files as scripts/train-head.mjs."""

import json
import re
from pathlib import Path

import pytest

from embedtext import embed_text
from finetune import POOL_FILES

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
FIXTURE = json.loads((HERE / "fixtures" / "embedtext.json").read_text(encoding="utf-8"))


def test_fixture_has_200_pool_rows():
    assert len(FIXTURE["pairs"]) == 200


@pytest.mark.parametrize("pair", FIXTURE["pairs"] + FIXTURE["edge"], ids=lambda p: p["row"]["url"][:60])
def test_matches_typescript(pair):
    assert embed_text(pair["row"]) == pair["text"]


def test_pool_files_match_train_head():
    src = (ROOT / "scripts" / "train-head.mjs").read_text(encoding="utf-8")
    block = re.search(r"const files = \[(.*?)\];", src, re.S).group(1)
    assert re.findall(r"'([^']+)'", block) == POOL_FILES
