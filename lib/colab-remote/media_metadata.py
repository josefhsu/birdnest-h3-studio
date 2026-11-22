"""Measure and prepare browser previews for generated media."""
import json
import math
import subprocess
from fractions import Fraction
from pathlib import Path


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result > 0 else None
    except (TypeError, ValueError):
        return None


def probe(path):
    cmd = ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)]
    info = json.loads(subprocess.check_output(cmd, text=True, timeout=30))
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), {})
    audio = next((s for s in info["streams"] if s["codec_type"] == "audio"), {})
    fps = None
    if video:
        try:
            fps = number(Fraction(video.get("avg_frame_rate", "0/1")))
        except (ValueError, ZeroDivisionError):
            pass
    stream = video or audio
    duration = number(stream.get("duration")) or number(info["format"].get("duration"))
    return dict(duration=duration, width=video.get("width"), height=video.get("height"),
                fps=fps, videoCodec=video.get("codec_name"), audioCodec=audio.get("codec_name"),
                sampleRate=number(audio.get("sample_rate")), channels=audio.get("channels"),
                format=Path(path).suffix.lstrip(".").upper())


def tool(*args):
    subprocess.run(args, check=True, capture_output=True, timeout=180)


def prepare_video(source, target, seconds, *, check_duration=True):
    media = probe(source)
    duration = media["duration"]
    if duration is None:
        raise RuntimeError("無法量測生成影片的實際長度")
    tolerance = 1.25 / (media["fps"] or 24)
    if check_duration and duration < seconds - tolerance:
        raise RuntimeError(f"要求 {seconds:g} 秒，GPU 只回傳 {duration:.2f} 秒，請重新生成")
    trim = ["-t", str(seconds)] if check_duration else []
    # Stream-copy can include future reference frames at the requested cut.
    # Re-encode only when the model's frame grid needs trimming.
    video_args = (["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
                  if check_duration and duration > seconds + 0.5 / (media["fps"] or 24)
                  else ["-c:v", "copy"])
    tool("ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-map", "0:v:0",
         "-map", "0:a:0?", *trim, *video_args, "-c:a", "aac", "-movflags", "+faststart", str(target))
    final = probe(target)
    if check_duration and abs((final["duration"] or 0) - seconds) > tolerance:
        raise RuntimeError(f"輸出片長與要求的 {seconds:g} 秒不符")
    return final


def poster_for(source, target):
    tool("ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
         "-map", "0:v:0", "-frames:v", "1",
         "-vf", "scale='min(640,iw)':-2", "-q:v", "4", str(target))
    return dict(poster=Path(target).name, poster_bytes=Path(target).stat().st_size)
