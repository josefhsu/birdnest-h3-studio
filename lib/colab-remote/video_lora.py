"""Optional H3 video LoRA preset and bridge for the private Toybox process."""
import hashlib
import importlib.util
import os
from pathlib import Path
import sys

from drive_storage import copy_verified

PRESET = "extreme-realism-v3"
REPO = "Sentinel7/h3"
REVISION = "251821a297cb6a3e1175bb1f151bb0d75f4ef4ee"
FILE = "2834417/3446189/HMNSFW-Extreme-Realism.safetensors"
SHA256 = "55aa39239ea4b408dee601cb0fa49157ec13fe2a54eccbb2fb725b124e43c1b5"
MODEL_FOLDER = "loras/studio"
LORA_NAME = "studio/" + Path(FILE).name
TURBO_LORA = "minimax_h3_turbo_v4_step600_ema_DasiwaREF2VAHybridV1_0_curveproj1025_compat_v001.safetensors"
BRIDGE_VERSION = 1


def matches_weight(path):
    if not path.is_file():
        return False
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == SHA256


def prepare_weight(comfy, store, model_source):
    from huggingface_hub import hf_hub_download

    target = comfy / "models" / MODEL_FOLDER / Path(FILE).name
    if matches_weight(target):
        return
    def restore():
        return store and store.restore_model(REPO, FILE, MODEL_FOLDER, target) and matches_weight(target)

    if model_source == "drive-first" and restore():
        return
    try:
        source = hf_hub_download(repo_id=REPO, filename=FILE, revision=REVISION)
    except Exception:
        if model_source == "source-first" and restore():
            return
        raise
    copy_verified(source, target, expected_hash=SHA256)
    if store:
        store.cache_model(REPO, FILE, MODEL_FOLDER, target)


def apply_preset(graph, sampler_id, scheduler_id):
    loaders = [
        node for node in graph.values()
        if node["class_type"] == "LoraLoaderModelOnly" and node["inputs"].get("lora_name") == TURBO_LORA
    ]
    if len(loaders) != 1 or graph[sampler_id]["class_type"] != "SelfLiftH3Sampler":
        raise RuntimeError("目前的 Toybox 影片工作流與 LoRA 不相容")
    # Reuse Turbo's model-only loader position so downstream sampler and scheduler links stay intact.
    loaders[0]["inputs"].update(lora_name=LORA_NAME, strength_model=1.0)
    graph[scheduler_id]["inputs"]["steps"] = 18
    graph[sampler_id]["inputs"]["transition_step"] = 9


def serve(server):
    spec = importlib.util.spec_from_file_location("songyin_toybox", server)
    toybox = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = toybox
    spec.loader.exec_module(toybox)
    build, generate = toybox.build_generate, toybox.generate

    def build_generate(cfg, final_text, chosen, task, req, size, src_job=None):
        graph, seed = build(cfg, final_text, chosen, task, req, size, src_job)
        if req.get("songyin_lora") == PRESET:
            apply_preset(graph, toybox.N_SAMPLER, toybox.N_SCHED)
        return graph, seed

    def generate_video(cfg, req):
        job = generate(cfg, req)
        if req.get("songyin_lora") == PRESET:
            job["songyin_lora"] = PRESET
        return job

    toybox.build_generate = build_generate
    toybox.generate = generate_video
    toybox.LIBRARY.mkdir(parents=True, exist_ok=True)
    toybox.OUTPUTS.mkdir(parents=True, exist_ok=True)
    restored = toybox.restore_inputs(toybox.load_config())
    if restored:
        print(f"Restored {restored} library files into ComfyUI's input folder", flush=True)
    toybox.ThreadingHTTPServer.allow_reuse_address = os.name != "nt"
    with toybox.ThreadingHTTPServer(("127.0.0.1", toybox.PORT), toybox.Handler) as httpd:
        toybox.MONITOR.start()
        httpd.serve_forever()


if __name__ == "__main__":
    serve(Path(sys.argv[1]).resolve())
