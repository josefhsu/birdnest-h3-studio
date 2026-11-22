"""Run the pinned RTX VSR Long Video node for an opted-in video."""
import importlib.util
import math
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

from media_metadata import probe

SCALES = (1.5, 2, 3, 4)
REPOSITORY = "https://github.com/tritant/ComfyUI_NVIDIA_RTX_VSR_Long_Video.git"
REVISION = "b20565455379998d3a22c07eb959d0a235034bde"


def output_limits(width, height):
    return (2160, 3840) if height > width else (3840, 2160)


def within_limits(width, height):
    if not width or not height:
        return False
    max_w, max_h = output_limits(width, height)
    return width <= max_w and height <= max_h


def fitted_scale(width, height, requested):
    if requested not in SCALES or not width or not height:
        raise ValueError("影片放大倍率或來源尺寸不正確")
    max_w, max_h = output_limits(width, height)
    return min(requested, max_w / width, max_h / height)


def checked_command(*command, timeout):
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise RuntimeError(detail[-1][:230] if detail else "NVIDIA RTX VSR 指令執行失敗")


def prepare_node(root):
    repo = root / ("rtx-vsr-" + REVISION[:12])
    if not (repo / "nodes.py").is_file():
        root.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix="rtx-node-", dir=root) as staging:
            checked_command("git", "-C", staging, "init", "-q", timeout=15)
            checked_command("git", "-C", staging, "fetch", "--depth=1", REPOSITORY, REVISION, timeout=90)
            checked_command("git", "-C", staging, "checkout", "--detach", "FETCH_HEAD", timeout=25)
            Path(staging).replace(repo)
    dependencies = ("nvvfx", "imageio_ffmpeg")
    marker = root / "vfx-0.2.0.0"
    if not marker.exists() or not all(importlib.util.find_spec(name) for name in dependencies):
        checked_command(sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                        "nvidia-vfx==0.2.0.0", "imageio-ffmpeg>=0.5.1,<1", timeout=300)
        marker.touch()
    return repo


def run_node(repo, comfy, source, destination, scale):
    # Use the existing ComfyUI environment in an isolated process.
    sys.path.insert(0, comfy)
    import folder_paths

    spec = importlib.util.spec_from_file_location(
        "songyin_rtx_vsr", Path(repo) / "__init__.py", submodule_search_locations=[repo],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from songyin_rtx_vsr.video_output import video_from_path

    with TemporaryDirectory(prefix="rtx-output-", dir=Path(destination).parent) as output:
        folder_paths.set_output_directory(output)
        node = module.NODE_CLASS_MAPPINGS["RTX_VSR_Long_Video"]()
        result = node.upscale_video(
            video_from_path(source), scale, "HIGHBITRATE_HIGH", 1.0,
            "none", 1.0, 16, "libx264",
        )
        Path(result["result"][0]).replace(destination)


def upscale(source, target, requested, comfy, tools_root):
    original = probe(source)
    width, height = original["width"], original["height"]
    scale = fitted_scale(width, height, requested)
    if scale < 1:
        raise RuntimeError("原始影片已超過 4K 尺寸上限")
    if scale == 1:
        return original, {"status": "at_limit", "requested": requested}
    started = time.monotonic()
    repo = prepare_node(tools_root)
    with TemporaryDirectory(prefix="rtx-vsr-", dir=target.parent) as output:
        staged = Path(output) / "enhanced.mp4"
        checked_command(
            sys.executable, str(Path(__file__).resolve()), str(repo), str(comfy),
            str(source), str(staged), str(scale), timeout=900,
        )
        enhanced = probe(staged)
        max_w, max_h = output_limits(width, height)
        if not (0 < (enhanced["width"] or 0) <= max_w and 0 < (enhanced["height"] or 0) <= max_h):
            raise RuntimeError("放大後的影片尺寸超出 4K 上限")
        if (enhanced["width"], enhanced["height"]) == (width, height):
            return original, {"status": "at_limit", "requested": requested}
        if original["audioCodec"] and not enhanced["audioCodec"]:
            raise RuntimeError("放大後的影片缺少原始音軌")
        tolerance = 1.25 / (original["fps"] or 24)
        if enhanced["duration"] is None or original["duration"] is None or abs(enhanced["duration"] - original["duration"]) > tolerance:
            raise RuntimeError("放大後的影片長度與原片不符")
        staged.replace(target)
    return enhanced, {"status": "done", "requested": requested,
                      "capped": not math.isclose(scale, requested), "seconds": round(time.monotonic() - started, 1),
                      "sourceWidth": width, "sourceHeight": height}


if __name__ == "__main__":
    args = sys.argv[1:]
    sys.argv[:] = sys.argv[:1]
    run_node(*args[:4], float(args[4]))
