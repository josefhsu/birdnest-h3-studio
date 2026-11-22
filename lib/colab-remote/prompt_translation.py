"""Translate only the descriptive segments selected by the studio."""
import importlib.util
from pathlib import Path
import re
import subprocess
import sys

# Helsinki-NLP / OPUS-MT Chinese-English, CC-BY-4.0. Fixed safetensors revision.
# https://huggingface.co/Helsinki-NLP/opus-mt-zh-en
MODEL = "Helsinki-NLP/opus-mt-zh-en"
REVISION = "badebd2bdd4cdfde141a969df82a0f2c4e3b1dfe"
_MODEL_FILES = ("config.json", "generation_config.json", "model.safetensors",
                "source.spm", "target.spm", "tokenizer_config.json", "vocab.json")
_breaks = re.compile(r"[。！？；;!?，,、]|\s")
_left_word = re.compile(r"[A-Za-z0-9>]$")
_right_word = re.compile(r"^[A-Za-z0-9@<]")
_engine = None


def chunks(text, size=200):
    while len(text) > size:
        boundaries = list(_breaks.finditer(text, size // 2, size))
        end = boundaries[-1].end() if boundaries else size
        yield text[:end].strip()
        text = text[end:].lstrip()
    if text:
        yield text


def english_batch(texts):
    global _engine
    if _engine is None:
        missing = [name for name in ("sentencepiece", "sacremoses") if importlib.util.find_spec(name) is None]
        if missing:
            subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", *missing], check=True, timeout=120)
        from huggingface_hub import snapshot_download
        from transformers import MarianMTModel, MarianTokenizer

        snapshot = snapshot_download(MODEL, revision=REVISION, allow_patterns=list(_MODEL_FILES))
        if not (Path(snapshot) / "model.safetensors").is_file():
            raise RuntimeError("缺少英文提示翻譯模型")
        tokenizer = MarianTokenizer.from_pretrained(snapshot, local_files_only=True)
        model = MarianMTModel.from_pretrained(snapshot, use_safetensors=True, local_files_only=True)
        _engine = (tokenizer, model.eval())

    import torch
    tokenizer, model = _engine
    translated = []
    with torch.inference_mode():
        for i in range(0, len(texts), 8):
            inputs = tokenizer(texts[i:i+8], padding=True, truncation=False, return_tensors="pt")
            if inputs.input_ids.shape[-1] > model.config.max_position_embeddings:
                raise RuntimeError("提示翻譯的單句超過模型上限")
            tokens = model.generate(**inputs, num_beams=3, max_new_tokens=384)
            translated.extend(tokenizer.batch_decode(tokens, skip_special_tokens=True))
    return translated


def prepare_model_prompt(job, translate=english_batch):
    parts = job.get("prompt_translation")
    if not parts:
        return job["prompt"]
    source = [part["translate"] for part in parts if isinstance(part, dict)]
    segmented = [list(chunks(text)) for text in source]
    translated = translate([piece for segments in segmented for piece in segments])
    if len(translated) != sum(map(len, segmented)) or any(not item.strip() for item in translated):
        raise RuntimeError("英文提示轉換未完成，原稿已保留，請稍後重新送出。")
    outputs = iter(item.strip() for item in translated)
    segments = iter(" ".join(next(outputs) for _ in group) for group in segmented)
    joined = []
    previous_translation = False
    for part in parts:
        is_translation = isinstance(part, dict)
        value = next(segments) if is_translation else part
        if joined and (is_translation or previous_translation) and _left_word.search(joined[-1]) and _right_word.search(value):
            joined.append(" ")
        joined.append(value)
        previous_translation = is_translation
    return "".join(joined)
