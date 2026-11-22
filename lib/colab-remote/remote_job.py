# -*- coding: utf-8 -*-
"""Runs ON the Colab VM. Started in the background by start.py; progress goes to /content/h3job/status.json.

One batch = /content/h3job/manifest.json (written by the local h3run.py). Steps:
  1 install (skipped when the marker exists): ComfyUI + 3 node packs + H3 Toybox (headless engine)
  2 models: H3 PRISM int8 + Qwen3-VL text encoder + video/audio VAE + LoRAs; the P-H3 picture set only when
    the batch has an image job
  3 start ComfyUI (127.0.0.1:8188) and H3 Toybox (127.0.0.1:8190), both private to the VM
  4 every job in order -> /content/h3job/out/<id>.<ext>
Videos, extensions and pictures go through Toybox's own API (the same code as the H3 Toybox notebook); TTS goes
straight to ComfyUI with the 32x32 H3 graph (sound only, audio VAE decode).
"""
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
import urllib.parse
import urllib.request
from pathlib import Path

from media_metadata import poster_for, prepare_video, probe
from prompt_translation import prepare_model_prompt

# H3JOB_LOCAL_TEST=1 runs the job part against servers already running on a desktop (no install, no downloads);
# scripts/h3local.py uses it for the local mode (ComfyUI Desktop), together with H3JOB_FETCH and H3JOB_COMFY_INPUT
LOCAL_TEST = os.environ.get("H3JOB_LOCAL_TEST") == "1"
JOB = Path(os.environ.get("H3JOB_DIR", "/content/h3job"))
OUT = JOB / "out"
STATUS = JOB / "status.json"
COMFY = Path(os.environ.get("H3JOB_COMFY", "/content/ComfyUI"))
APP_REPO = Path("/content/minimax-h3-colab")
APP = APP_REPO / "toybox"
DATA = JOB / "toybox_data"
MARK = Path("/content/.h3skill_setup_v1")
COMFY_URL = os.environ.get("H3JOB_COMFY_URL", "http://127.0.0.1:8188")
TOYBOX_URL = os.environ.get("H3JOB_TOYBOX_URL", "http://127.0.0.1:8190")
STATE = {"stage": "starting", "log": [], "jobs": {}, "done": False, "error": None, "started": time.time()}
STORE = None  # configured only after a real Google Drive mount has been verified

ASSETS = "dseditor/minimax-h3-studio-assets"
BASE_MODELS = [  # (repo, file in repo, models/ subfolder)
    ("OliviaRossi/Minimax-h3_Singularity-x-10Eros-Max_PRISM", "Minimax-h3_Singularity_x_10Eros-Max_PRISM_int8.safetensors", "diffusion_models"),
    ("Comfy-Org/MiniMax-H3", "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "text_encoders"),
    ("Comfy-Org/MiniMax-H3", "vae/minimax_h3_video_vae_int8_convrot.safetensors", "vae"),
    ("Comfy-Org/MiniMax-H3", "vae/minimax_h3_audio_vae_fp32.safetensors", "vae"),
    ("Comfy-Org/MiniMax-H3", "loras/pika_h3_flex_ref2va_v1_bf16.safetensors", "loras"),  # video + TTS
] + [(ASSETS, f, str(Path(f).parent)) for f in [
    "loras/minimax_h3_turbo_v4_step600_ema_DasiwaREF2VAHybridV1_0_curveproj1025_compat_v001.safetensors",
    "loras/MysticXXX_MMH3-V2.safetensors",
    "loras/H3_Combat_V2.safetensors",          # motion LoRAs: only wired in when intensity is not "off"
    "loras/Motion_Repair.safetensors",
    "loras/H3_SPEED_slider.safetensors",
    "semantic_bridge/t8_compat/BUNNY_H3_ActionLogic_Bridge_V1_T8_Compat.safetensors",
    "latent_upscale_models/minimax_h3_latent_upscaler_3d_fp16_V2.safetensors",
]]
PICTURE_MODELS = [  # P-H3-Image (PrunaAI): a LoRA on the same H3 model + its own encoder and image VAE (~10 GB)
    ("PrunaAI/P-H3-Image-Comfy", "loras/p-h3-image_lora_bf16.safetensors", "loras"),
    ("PrunaAI/P-H3-Image-Comfy", "text_encoders/p-h3-image_text_encoder_int8_convrot.safetensors", "text_encoders"),
    ("PrunaAI/P-H3-Image-Comfy", "vae/p-h3-image_vae_int8_convrot.safetensors", "vae"),
]
NODES = {
    "minimax-h3-audio-t8": "https://github.com/T8mars/comfyui-minimax-h3-audio-T8",
    "comfyui-SelfLift": "https://github.com/facok/comfyui-SelfLift",
    "ComfyUI-H3-Motion-Context": "https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context",
}


# ---------------------------------------------------------------- status
def save():
    tmp = STATUS.with_suffix(".tmp")
    tmp.write_text(json.dumps(STATE, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATUS)


def log(msg, stage=None):
    if stage:
        STATE["stage"] = stage
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    STATE["log"] = (STATE["log"] + [line])[-60:]
    save()


def sh(args, **kw):
    subprocess.run(args, check=True, **kw)


# ---------------------------------------------------------------- 1 install
def clone(url, dest):
    if not Path(dest).exists():
        sh(["git", "clone", "--depth", "1", url, str(dest)])
    else:
        subprocess.run(["git", "-C", str(dest), "pull", "--ff-only"], check=False)


def install():
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("no GPU on this runtime")
    cap = torch.cuda.get_device_capability(0)
    if cap < (8, 0):
        raise RuntimeError(f"GPU capability {cap} cannot run the int8 H3 model (T4 is too old); use L4 or G4")
    if MARK.exists() and (APP / "server.py").is_file() and (COMFY / "main.py").is_file():
        log("重用本次 GPU 已安裝的 H3 環境", "install")
        return
    log(f"install: GPU {torch.cuda.get_device_name(0)}, capability {cap}", "install")
    clone("https://github.com/Comfy-Org/ComfyUI.git", COMFY)
    if not (torch.version.cuda or "").startswith("13"):
        log("install: CUDA 13 PyTorch (the int8 ConvRot weights need it)")
        sh([sys.executable, "-m", "pip", "install", "-q", "torch", "torchvision", "torchaudio",
            "--index-url", "https://download.pytorch.org/whl/cu130"])
    sh([sys.executable, "-m", "pip", "install", "-q", "-r", str(COMFY / "requirements.txt"), "huggingface_hub", "hf_xet"])
    for name, url in NODES.items():
        clone(url, COMFY / "custom_nodes" / name)
    clone("https://github.com/T8mars/comfyui-minimax-h3-prompt-enhancer-T8", "/content/t8-enhancer")
    clone("https://github.com/dseditor/minimax-h3-colab.git", APP_REPO)
    MARK.write_text(time.ctime())
    log("install: done")


def install_upscale_environment():
    if (COMFY / "folder_paths.py").is_file() and (MARK.exists() or (JOB / ".vsr_comfy_ready").is_file()):
        return
    log("準備 NVIDIA 放大環境", "install")
    clone("https://github.com/Comfy-Org/ComfyUI.git", COMFY)
    sh([sys.executable, "-m", "pip", "install", "-q", "-r", str(COMFY / "requirements.txt")])
    (JOB / ".vsr_comfy_ready").touch()


# ---------------------------------------------------------------- 2 models
def download(files, model_source="drive-first"):
    from huggingface_hub import hf_hub_download
    if model_source not in ("drive-first", "source-first"):
        raise ValueError("Unknown model source")
    for index, (repo, name, folder) in enumerate(files):
        STATE["progress"] = {"stage": "models", "completed": index, "total": len(files), "detail": Path(name).name}
        save()
        target = COMFY / "models" / folder / Path(name).name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file():
            restored = bool(STORE and model_source == "drive-first" and STORE.restore_model(repo, name, folder, target))
            if restored:
                log(f"model cache hit: {target.name}", "models")
            else:
                try:
                    got = Path(hf_hub_download(repo_id=repo, filename=name, local_dir="/content/hf"))
                    shutil.move(str(got), str(target))
                except Exception:
                    # A failed source-first download may still use a verified Drive copy.
                    if not (STORE and model_source == "source-first" and STORE.restore_model(repo, name, folder, target)):
                        raise
                    restored = True
                    log(f"model source unavailable; using Drive cache: {target.name}", "models")
                if STORE and not restored and (model_source == "source-first" or not STORE.has_model(repo, name, folder)):
                    log(f"saving model cache to Drive: {target.name}", "models")
                    STORE.cache_model(repo, name, folder, target)
        elif STORE and not STORE.has_model(repo, name, folder):
            log(f"saving existing model cache to Drive: {target.name}", "models")
            STORE.cache_model(repo, name, folder, target)
        log(f"model ready: {target.name} ({target.stat().st_size / 2**30:.1f} GiB)")
    STATE["progress"] = {"stage": "models", "completed": len(files), "total": len(files)}
    save()
    guides = APP / "guides"
    guides.mkdir(exist_ok=True)
    for g in ("VIDEO_PROMPT_WRITING_GUIDE_ref_en.md", "VIDEO_PROMPT_WRITING_GUIDE_base_en.md"):
        if not (guides / g).exists():
            got = Path(hf_hub_download(repo_id="MiniMaxAI/MiniMax-H3", filename="docs/" + g, local_dir="/content/hf"))
            shutil.copy(str(got), str(guides / g))


# ---------------------------------------------------------------- 3 servers
def wait_http(url, name, logfile, tries=180):
    for _ in range(tries):
        try:
            urllib.request.urlopen(url, timeout=2)
            return
        except Exception:
            time.sleep(2)
    raise RuntimeError(f"{name} did not start:\n" + Path(logfile).read_text(errors="ignore")[-2000:])


def start_servers(pictures):
    from video_lora import BRIDGE_VERSION

    try:
        urllib.request.urlopen(COMFY_URL + "/system_stats", timeout=2)
        log("ComfyUI already running")
    except Exception:
        subprocess.Popen([sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188"], cwd=str(COMFY),
                         stdout=open("/content/comfyui.log", "w"), stderr=subprocess.STDOUT, start_new_session=True)
        wait_http(COMFY_URL + "/system_stats", "ComfyUI", "/content/comfyui.log")
        log("ComfyUI started")
    DATA.mkdir(parents=True, exist_ok=True)
    (COMFY / "input").mkdir(exist_ok=True)
    cfg_path = DATA / "config.json"
    previous = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    cfg = dict(previous)
    cfg.update({"comfy_url": COMFY_URL, "comfy_input_dir": str(COMFY / "input"),
                "skills_dir": "/content/t8-enhancer/directional_skills", "free_after_rewrite": True,
                "songyin_video_lora_bridge": BRIDGE_VERSION})
    cfg.pop("guides", None)
    have = all((COMFY / "models" / folder / Path(f).name).is_file() for _, f, folder in PICTURE_MODELS)
    cfg["image"] = dict(cfg.get("image") or {}, engine="ph3", installed=have)
    changed = cfg != previous
    if changed:
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    try:
        urllib.request.urlopen(TOYBOX_URL + "/api/config", timeout=2)
        if not changed:
            log("重用已啟動的 H3 Toybox", "engine")
            return
        # Reload Toybox when its settings or installed models change.
        subprocess.run(["pkill", "-f", "toybox/server.py"], check=False)
        time.sleep(2)
    except Exception:
        pass
    subprocess.Popen([sys.executable, str(JOB / "video_lora.py"), str(APP / "server.py")], cwd=str(APP),
                     env=dict(os.environ, H3TOYBOX_PORT="8190", H3TOYBOX_DATA=str(DATA),
                              H3TOYBOX_SECRETS=str(JOB / "secrets.json")),
                     stdout=open("/content/toybox.log", "w"), stderr=subprocess.STDOUT, start_new_session=True)
    wait_http(TOYBOX_URL + "/api/config", "H3 Toybox", "/content/toybox.log", tries=30)
    log(f"H3 Toybox started (pictures {'on' if have else 'off'})")


# ---------------------------------------------------------------- 4 jobs
def call(url, body=None, data=None, headers=None, timeout=120):
    req = urllib.request.Request(url, headers=headers or {"Content-Type": "application/json"},
                                 data=data if data is not None else (None if body is None else json.dumps(body).encode()))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{url} -> {e.code}: {e.read().decode('utf-8', 'replace')[:800]}")
    return json.loads(raw) if raw.strip() else {}


UPLOADED = {}


def library_id(rel):
    """Upload one input file (relative to the job folder) into the Toybox library, once."""
    if rel not in UPLOADED:
        if rel.startswith("@"):  # the output of an earlier job in this batch, e.g. "@frame01"
            st = STATE["jobs"].get(rel[1:], {})
            if st.get("status") != "done":
                raise RuntimeError(f"{rel}: that job has not produced a file (it must come earlier and succeed)")
            path = OUT / st["file"]
        else:
            path = JOB / "inputs" / rel
        if not path.is_file():
            raise RuntimeError(f"input not found: {rel}")
        item = call(TOYBOX_URL + "/api/upload", data=path.read_bytes(),
                    headers={"X-Filename": urllib.parse.quote(path.name), "Content-Type": "application/octet-stream"})
        UPLOADED[rel] = item["id"]
    return UPLOADED[rel]


TOYBOX_JOB = {}  # our job id -> Toybox job id (an extension takes an earlier clip from the same batch)


def wait_toybox(tid, timeout, job_id):
    t0 = time.time()
    while time.time() - t0 < timeout:
        job = next((j for j in call(TOYBOX_URL + "/api/jobs") if j["id"] == tid), None)
        if job and job.get("progress"):
            progress = job["progress"]
            STATE["jobs"][job_id]["progress"] = {k: progress[k] for k in ("stage", "percent", "eta", "live") if k in progress}
            save()
        if job and job.get("status") == "done":
            return job
        if job and job.get("status") in ("error", "failed"):
            raise RuntimeError(job.get("error") or "generation failed")
        time.sleep(4)
    raise RuntimeError(f"no result after {timeout} s")


def comfy_file(info):
    if os.environ.get("H3JOB_FETCH") == "1":  # local ComfyUI Desktop: its output folder can be anywhere, so ask it
        q = urllib.parse.urlencode({"filename": info["filename"], "subfolder": info.get("subfolder", ""),
                                    "type": info.get("type", "output")})
        dst = JOB / "fetch" / info["filename"]
        dst.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(f"{COMFY_URL}/view?{q}", timeout=300) as r, open(dst, "wb") as f:
            shutil.copyfileobj(r, f)
        return dst
    return COMFY / "output" / info.get("subfolder", "") / info["filename"]


def comfy_input():
    return Path(os.environ.get("H3JOB_COMFY_INPUT") or COMFY / "input")


def toybox_data():
    return Path(os.environ.get("H3JOB_TOYBOX_DATA", DATA))


def run_image(j):
    tray = [{"id": library_id(r)} for r in j.get("inputs", [])]
    job = call(TOYBOX_URL + "/api/generate", {"mode": "image", "prompt": j["prompt"], "tray": tray,
                                              "aspect": j.get("aspect", "auto"), "image_size": j.get("size", "2K"),
                                              "seed": j.get("seed")})
    done = wait_toybox(job["id"], 900, j["id"])
    return comfy_file(done["image"]), done


VIDEO_REFERENCES = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
AUDIO_REFERENCES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}


def validate_reference_clips(job):
    if job["type"] != "video" or job.get("operation") == "upscale" or job.get("mode", "ref") != "ref":
        return
    totals = {"video": 0, "audio": 0}
    for reference in job.get("inputs", []):
        if reference.startswith("@"):
            continue  # Earlier batch outputs are resolved by the runner.
        path = JOB / "inputs" / reference
        ext = path.suffix.lower()
        if ext in VIDEO_REFERENCES:
            kind = "video"
        elif ext in AUDIO_REFERENCES:
            kind = "audio"
        else:
            continue
        try:
            spec = probe(path)
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            raise RuntimeError(f"無法讀取 {kind} 參考檔案：{path.name}") from error
        seconds = spec["duration"]
        track = spec["videoCodec"] if kind == "video" else spec["audioCodec"]
        if not track or seconds is None:
            raise RuntimeError(f"參考檔案缺少對應的影音軌：{path.name}")
        seconds = round(seconds, 2)
        if not 2 <= seconds <= 15:
            raise RuntimeError(f"參考影片和音訊每段須為 2–15 秒：{path.name} 實測 {seconds:g} 秒")
        totals[kind] += seconds
        if totals[kind] > 15.0001:
            label = "影片" if kind == "video" else "音訊"
            raise RuntimeError(f"同類參考{label}合計超過 15 秒")


def run_video(j):
    mode = j.get("mode", "ref")
    seconds = int(j["seconds"])
    if not 2 <= seconds <= 15:
        raise ValueError("影片長度必須為 2–15 秒")
    body = {"mode": {"ref": "ref", "frames": "frames", "first_last": "frames", "text": "text"}[mode],
            "prompt": j["prompt"], "seconds": seconds, "aspect": j.get("aspect", "auto"),
            "resolution": j.get("resolution", "480P"), "intensity": j.get("intensity", "off"),
            "fast": j.get("fast", True), "skill": j.get("skill", ""), "seed": j.get("seed")}
    if j.get("lora"):
        from video_lora import PRESET
        if j["lora"] != PRESET:
            raise ValueError("影片 LoRA 設定不正確")
        body.update(songyin_lora=PRESET, fast=False)
    if body["mode"] == "ref":
        body["tray"] = [{"id": library_id(r)} for r in j.get("inputs", [])]
        if j.get("extend"):
            src = str(j["extend"]).lstrip("@")
            if src in TOYBOX_JOB:  # a clip made earlier in this batch
                item = call(TOYBOX_URL + "/api/library/from_job", {"id": TOYBOX_JOB[src]})
                src_id = item["id"]
            else:  # a video the user supplied
                src_id = library_id(j["extend"])
            body["tray"].insert(0, {"id": src_id, "extend": True})
    elif body["mode"] == "frames":
        body["first_id"] = library_id(j["first"]) if j.get("first") else None
        body["last_id"] = library_id(j["last"]) if j.get("last") else None
    job = call(TOYBOX_URL + "/api/generate", body)
    if j.get("lora") and job.get("songyin_lora") != j["lora"]:
        raise RuntimeError("生成引擎未確認 LoRA 已套用")
    if float(job.get("seconds", -1)) != seconds:
        raise RuntimeError(f"要求 {seconds} 秒，生成引擎未接受這個片長")
    TOYBOX_JOB[j["id"]] = job["id"]
    done = wait_toybox(job["id"], int(j.get("timeout", 2400)), j["id"])
    if done.get("full_video"):  # an extension: the new clip already joined after the source
        return toybox_data() / "outputs" / done["full_video"], done
    return comfy_file(done["video"]), done


def run_tts(j):
    """32x32 H3: the picture is thrown away, only the audio latent is decoded (h3_tts32_api.json)."""
    wf = json.loads((JOB / "h3_tts32_api.json").read_text(encoding="utf-8"))
    if os.environ.get("H3JOB_TTS_LORA"):
        wf["63"]["inputs"]["lora_name"] = os.environ["H3JOB_TTS_LORA"]
    wf["7"]["inputs"]["prompt"] = j["prompt"]
    wf["56"]["inputs"]["value"] = int(j.get("seconds", 10))
    wf["54"]["inputs"]["seed"] = int(j["seed"]) if j.get("seed") is not None else int.from_bytes(os.urandom(6), "big")
    for k, rel in enumerate(j.get("voices", [])[:3]):  # <Audio N>: voice-timbre references, in order
        src = OUT / STATE["jobs"][rel[1:]]["file"] if rel.startswith("@") else JOB / "inputs" / rel
        name = f"h3skill_{j['id']}_{k}{Path(src).suffix}"
        shutil.copy(str(src), str(comfy_input() / name))
        wf[f"ra{k}"] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
        wf["7"]["inputs"][f"ref_audios.ref_audio_{k}"] = [f"ra{k}", 0]
    pid = call(COMFY_URL + "/prompt", {"prompt": wf, "client_id": "h3skill"})["prompt_id"]
    STATE["jobs"][j["id"]]["progress"] = {"stage": "sampling", "live": False}
    save()
    t0 = time.time()
    while time.time() - t0 < 900:
        h = call(COMFY_URL + f"/history/{pid}").get(pid)
        if h and h.get("status", {}).get("completed") is not None:
            if h["status"].get("status_str") == "error":
                msgs = [m[1] for m in h["status"].get("messages", []) if m[0] == "execution_error"]
                raise RuntimeError(f"ComfyUI: {msgs[0].get('exception_message', '')[:400] if msgs else 'error'}")
            a = next(o["audio"][0] for o in h["outputs"].values() if o.get("audio"))
            flac = comfy_file(a)
            wav = flac.with_suffix(".wav")
            if not shutil.which("ffmpeg"):  # a desktop without ffmpeg: hand over the FLAC as it is
                return flac, {"seconds": j.get("seconds", 10)}
            sh(["ffmpeg", "-v", "error", "-y", "-i", str(flac), str(wav)])
            return wav, {"seconds": j.get("seconds", 10)}
        time.sleep(2)
    raise RuntimeError("TTS: no result after 900 s")


RUNNERS = {"image": run_image, "video": run_video, "tts": run_tts}


def upscale_saved_job(job, target):
    from video_upscale import upscale

    name = job["source"]
    if Path(name).name != name or name not in (job["id"] + "_source.mp4", job["id"] + "_source.webm"):
        raise RuntimeError("放大來源檔案名稱不正確")
    source = JOB / "inputs" / name
    media, details = upscale(source, target, job["upscale"], COMFY, JOB / "upscalers")
    if details["status"] != "done":
        raise RuntimeError("原片尺寸已達可放大的上限")
    return media, details


def prepare_archive_parts(path):
    if path.stat().st_size <= 12 * 1024 * 1024:
        return {}
    parts = path.with_name(path.stem + "-chunks")
    parts.mkdir(exist_ok=True)
    chunk_bytes = 8 * 1024 * 1024
    with path.open("rb") as source:
        index = 0
        while chunk := source.read(chunk_bytes):
            (parts / f"{index}.part").write_bytes(chunk)
            index += 1
    return {"archive_chunk_bytes": chunk_bytes}


def main():
    global STORE
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((JOB / "manifest.json").read_text(encoding="utf-8"))
    queue_id = manifest.get("queue_id")
    if queue_id:
        STATE["queue_id"] = queue_id
        from queue_control import read_queue, start_job
    log("準備工作與參考素材", "starting")
    if manifest.get("drive_root") and not LOCAL_TEST:
        from drive_storage import DriveStore
        STORE = DriveStore(manifest["drive_root"])
        STORE.start(manifest, JOB / "inputs")
        STATE["drive_folder"] = str(STORE.output_dir)
    jobs = manifest["jobs"]
    for j in jobs:
        STATE["jobs"][j["id"]] = {"type": j["type"], "status": "queued"}
    if queue_id:
        for job_id in read_queue(JOB, queue_id)["cancelled"]:
            STATE["jobs"][job_id].update(status="cancelled")
    save()
    for j in jobs:
        if STATE["jobs"][j["id"]]["status"] != "queued":
            continue
        try:
            validate_reference_clips(j)
        except RuntimeError as error:
            STATE["jobs"][j["id"]].update(status="error", error=str(error))
            log(f"{j['id']}: {error}", "starting")
    pending = [j for j in jobs if STATE["jobs"][j["id"]]["status"] == "queued"]
    if not pending:
        failed = any(state["status"] == "error" for state in STATE["jobs"].values())
        STATE.update(done=True, stage="failed" if failed else "finished", finished=time.time())
        save()
        return
    needs_generation = any(j.get("operation") != "upscale" for j in pending)
    if not LOCAL_TEST and needs_generation:
        log("準備 GPU 環境與推論元件", "install")
        install()
        pictures = any(j["type"] == "image" for j in pending) or manifest.get("install_pictures", False)
        log("models: downloading what is missing", "models")
        download(BASE_MODELS + (PICTURE_MODELS if pictures else []), manifest.get("model_source", "drive-first"))
        if any(j["type"] == "video" and j.get("lora") for j in pending):
            from video_lora import PRESET, prepare_weight
            if any(j.get("lora") not in (None, PRESET) for j in pending):
                raise ValueError("影片 LoRA 設定不正確")
            log("準備 Extreme Realism V3 LoRA", "models")
            prepare_weight(COMFY, STORE, manifest.get("model_source", "drive-first"))
        log("啟動生成引擎", "engine")
        start_servers(pictures)
    elif not LOCAL_TEST:
        install_upscale_environment()
    STATE.pop("progress", None)
    STATE["stage"] = "generating" if needs_generation else "upscaling"
    for j in pending:
        st = STATE["jobs"][j["id"]]
        if queue_id:
            if not start_job(JOB, queue_id, j["id"], st, save):
                log(f"{j['id']}: 已移出排隊")
                continue
        else:
            st.update(status="running", started=time.time())
            save()
        try:
            standalone_upscale = j.get("operation") == "upscale"
            info, thumbnail = {}, {}
            model_prompt = None
            if standalone_upscale:
                dst = OUT / f"{j['id']}.mp4"
                st["progress"] = {"stage": "upscaling"}
                log(f"{j['id']}: NVIDIA RTX VSR {j['upscale']:g}×", "upscaling")
                media, st["upscale"] = upscale_saved_job(j, dst)
                render_seconds = round(time.time() - st["started"], 1)
            else:
                if j.get("prompt_translation"):
                    st["progress"] = {"stage": "prompt_language"}
                    log(f"{j['id']}: 正在轉換 H3 提示語言")
                try:
                    model_prompt = prepare_model_prompt(j)
                except Exception as error:
                    raise RuntimeError("英文提示轉換未完成，原稿已保留。請稍後重試，或以英文寫描述並標出台詞。") from error
                st.pop("progress", None)
                save()
                src, info = RUNNERS[j["type"]](dict(j, prompt=model_prompt))
                render_seconds = round(time.time() - st["started"], 1)
            st["progress"] = {"stage": "export"}
            save()
            if j["type"] == "video" and not standalone_upscale:
                dst = OUT / f"{j['id']}.mp4"
                media = prepare_video(src, dst, int(j["seconds"]), check_duration=not j.get("extend"))
                if j.get("upscale", 1) != 1:
                    from video_upscale import upscale, within_limits
                    requested = j["upscale"]
                    st["progress"] = {"stage": "upscaling"}
                    log(f"{j['id']}: NVIDIA RTX VSR {requested:g}×")
                    try:
                        media, st["upscale"] = upscale(dst, dst, requested, COMFY, JOB / "upscalers")
                    except Exception as error:
                        if not within_limits(media["width"], media["height"]):
                            raise RuntimeError("影片超過 4K 尺寸上限，無法收錄。") from error
                        st["upscale"] = {"status": "failed", "requested": requested}
                        log(f"{j['id']}: RTX VSR 放大失敗，保留原片。{str(error)[:240]}")
            elif not standalone_upscale:
                dst = OUT / f"{j['id']}{Path(src).suffix}"
                shutil.copy(str(src), str(dst))
                media = probe(dst)
                if j["type"] == "image":
                    media.update(duration=None, fps=None)
            if j["type"] in ("video", "image"):
                try:
                    thumbnail = poster_for(dst, OUT / f"{j['id']}-poster.jpg")
                except (subprocess.SubprocessError, OSError):
                    log(f"{j['id']}: 未能擷取縮圖")
            if STORE:
                STORE.save_output(dst)
                if thumbnail:
                    STORE.save_output(OUT / thumbnail["poster"])
            parts = {}
            if STORE and j["type"] == "video":
                try:
                    parts = prepare_archive_parts(dst)
                except OSError:
                    log(f"{j['id']}: 影片無法準備分段收錄")
            st.update(status="done", file=dst.name, bytes=dst.stat().st_size, seconds_used=render_seconds,
                      finished=time.time(), media=media, requested_seconds=j.get("seconds"),
                      final_prompt=info.get("final_prompt") or model_prompt or "", seed=info.get("seed"), **thumbnail, **parts)
            st.pop("progress", None)
            log(f"{j['id']}: done in {st['seconds_used']} s -> {dst.name}")
        except Exception as e:
            st.update(status="error", error=str(e)[:1500])
            log(f"{j['id']}: ERROR {e}")
            if manifest.get("stop_on_error"):
                break
        save()
        if STORE:
            STORE.save_state(STATE)
    STATE.update(done=True, stage="finished", finished=time.time())
    save()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        STATE.update(done=True, stage="failed", error=f"{e}\n{traceback.format_exc()[-1500:]}")
        save()
        raise
    finally:
        if STORE:
            try:
                STORE.save_state(STATE)
                STORE.save_log(JOB / "remote_job.log")
            except Exception as e:
                STATE.update(done=True, stage="failed", error=f"無法將工作紀錄儲存至 Google Drive：{e}")
                save()
                raise
