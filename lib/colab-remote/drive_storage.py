"""Persist complete model cache entries and finished jobs in a mounted Google Drive.

This module never mounts a drive or obtains credentials. The caller must mount
the requested Drive first; an unmounted path is a hard error, not local fallback.
"""
import hashlib
import json
import os
import shutil
import time
import uuid
from pathlib import Path

CHUNK_SIZE = 8 * 1024 * 1024


def copy_verified(source, destination, expected_hash=None):
    """Copy via a temporary file; verify length and optional SHA-256 before publish."""
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".partial-" + uuid.uuid4().hex[:8])
    digest = hashlib.sha256()
    size = 0
    try:
        with source.open("rb") as src, partial.open("xb") as dst:
            while chunk := src.read(CHUNK_SIZE):
                dst.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        if not size or size != source.stat().st_size:
            raise OSError("File copy did not produce a complete nonempty file")
        hexdigest = digest.hexdigest()
        if expected_hash and hexdigest != expected_hash:
            raise ValueError("Cached model checksum does not match")
        partial.replace(destination)
        return {"sha256": hexdigest, "bytes": size}
    finally:
        partial.unlink(missing_ok=True)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial-" + uuid.uuid4().hex[:8])
    try:
        partial.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


class DriveStore:
    def __init__(self, root, *, require_mount=True):
        self.root = Path(root)
        if require_mount and not os.path.ismount("/content/drive"):
            raise RuntimeError("Google Drive 尚未掛載；請先完成 Colab Drive 授權")
        if not self.root.is_dir():
            raise RuntimeError(f"找不到 Google Drive 資料夾：{self.root}")
        self.run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
        self.output_dir = self.root / "生成作品" / self.run_id
        self.log_dir = self.root / "執行紀錄" / self.run_id

    def cache_paths(self, name, folder):
        folder_path = Path(folder)
        if folder_path.is_absolute() or ".." in folder_path.parts:
            raise ValueError("Unsafe model folder")
        model = self.root / "模型" / folder_path / Path(name).name
        return model, model.with_name(model.name + ".h3-cache.json")

    def restore_model(self, repo, name, folder, destination):
        model, meta = self.cache_paths(name, folder)
        if not model.is_file() or not meta.is_file():
            return False
        try:
            recorded = json.loads(meta.read_text(encoding="utf-8"))
            if not isinstance(recorded, dict):
                return False
            if recorded.get("repo") != repo or recorded.get("filename") != name:
                return False
            if recorded.get("bytes") != model.stat().st_size or not recorded.get("sha256"):
                return False
            copy_verified(model, destination, expected_hash=recorded["sha256"])
            return True
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False

    def has_model(self, repo, name, folder):
        model, meta = self.cache_paths(name, folder)
        try:
            recorded = json.loads(meta.read_text(encoding="utf-8"))
            return (isinstance(recorded, dict) and model.is_file() and recorded.get("repo") == repo and
                    recorded.get("filename") == name and bool(recorded.get("sha256")) and
                    recorded.get("bytes") == model.stat().st_size)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False

    def cache_model(self, repo, name, folder, source):
        model, meta = self.cache_paths(name, folder)
        info = copy_verified(source, model)
        atomic_json(meta, dict(repo=repo, filename=name, **info))

    def start(self, manifest, inputs_dir):
        self.output_dir.mkdir(parents=True, exist_ok=False)
        self.log_dir.mkdir(parents=True, exist_ok=False)
        atomic_json(self.log_dir / "manifest.json", manifest)
        atomic_json(self.root / "工作流程" / f"{self.run_id}.json", manifest)
        inputs_dir = Path(inputs_dir)
        references = set()
        for job in manifest["jobs"]:
            references.update(job.get("inputs") or [])
            references.update(job.get("voices") or [])
            references.update(filter(None, (job.get("first"), job.get("last"))))
        for name in sorted(references):
            if name.startswith("@"):
                continue  # an output from an earlier job in this batch
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe reference path")
            destination = self.root / "素材" / self.run_id / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(inputs_dir / relative, destination)

    def save_output(self, path):
        path = Path(path)
        copy_verified(path, self.output_dir / path.name)

    def save_state(self, state):
        atomic_json(self.log_dir / "status.json", state)

    def save_log(self, path):
        path = Path(path)
        if path.is_file() and path.stat().st_size:
            copy_verified(path, self.log_dir / "remote_job.log")
