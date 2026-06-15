#!/usr/bin/env python3
"""Local, free fallback transcription of lecture videos to .srt subtitles.

This is the audio-only BACKUP for when you don't want to spend Gemini tokens.
Primary video understanding is Gemini; use this only as the cheap local path.

It uses faster-whisper (CTranslate2 reimplementation of OpenAI Whisper):
free, runs fully locally, ~4x faster than openai-whisper, same model weights.

------------------------------------------------------------------------------
INSTALL
------------------------------------------------------------------------------
    pip install faster-whisper

GPU (NVIDIA) is auto-detected and used if available (much faster). For GPU you
also need a CUDA-enabled build of PyTorch / the cuDNN+cuBLAS libraries that
faster-whisper documents; CPU works out of the box (slower, int8).

ffmpeg must be on your PATH so audio can be decoded from the video container.
    - Windows:  winget install Gyan.FFmpeg   (or: choco install ffmpeg)
    - macOS:    brew install ffmpeg
    - Linux:    sudo apt install ffmpeg

------------------------------------------------------------------------------
USAGE
------------------------------------------------------------------------------
    python transcribe.py <path> [--model large-v3] [--language zh] \
                                 [--device auto] [--compute-type auto] [--force]

    <path>  A single video file OR a directory. If a directory, every
            .mp4/.mov/.mkv/.webm under it (recursively) is transcribed.

For each video a sibling <basename>.srt is written next to it. Existing .srt
files are skipped (idempotent) unless --force is given.

Defaults: model 'large-v3' (best Chinese accuracy), language 'zh'. Device and
compute-type are chosen automatically: cuda+float16 when a GPU is available,
otherwise cpu+int8.

Examples:
    python transcribe.py lecture01.mp4
    python transcribe.py ./videos --model medium --language en
    python transcribe.py ./videos --force
"""

import argparse
import os
import sys

VIDEO_EXTENSIONS = (".mp4", ".mov", ".mkv", ".webm")


def format_timestamp(seconds: float) -> str:
    """Format a float number of seconds as an SRT timestamp HH:MM:SS,mmm."""
    if seconds < 0:
        seconds = 0.0
    total_milliseconds = int(round(seconds * 1000.0))
    hours, remainder = divmod(total_milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def collect_inputs(path: str) -> list:
    """Return a sorted list of video files for a file-or-directory path."""
    if os.path.isfile(path):
        return [os.path.abspath(path)]

    if os.path.isdir(path):
        found = []
        for root, _dirs, files in os.walk(path):
            for name in files:
                if name.lower().endswith(VIDEO_EXTENSIONS):
                    found.append(os.path.abspath(os.path.join(root, name)))
        return sorted(found)

    return []


def srt_path_for(video_path: str) -> str:
    """Return the sibling .srt path for a given video file."""
    base, _ext = os.path.splitext(video_path)
    return base + ".srt"


def pick_device_and_compute(device: str, compute_type: str):
    """Resolve 'auto' device/compute-type to concrete values.

    Prefer cuda+float16 when an NVIDIA GPU is usable, otherwise cpu+int8.
    """
    resolved_device = device
    if device == "auto":
        resolved_device = "cpu"
        try:
            import ctranslate2  # bundled with faster-whisper

            if ctranslate2.get_cuda_device_count() > 0:
                resolved_device = "cuda"
        except Exception:
            resolved_device = "cpu"

    resolved_compute = compute_type
    if compute_type == "auto":
        resolved_compute = "float16" if resolved_device == "cuda" else "int8"

    return resolved_device, resolved_compute


def write_srt(segments, out_path: str) -> int:
    """Write whisper segments to an SRT file. Returns the number of cues."""
    count = 0
    # Write to a temp file first so an interrupted run never leaves a partial
    # .srt that the idempotent skip-check would later treat as complete.
    tmp_path = out_path + ".part"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        for index, segment in enumerate(segments, start=1):
            text = (segment.text or "").strip()
            if not text:
                continue
            count += 1
            start = format_timestamp(segment.start)
            end = format_timestamp(segment.end)
            handle.write(f"{count}\n{start} --> {end}\n{text}\n\n")
            # Live progress: print each cue as it is produced.
            print(f"    [{start} --> {end}] {text}", flush=True)
    os.replace(tmp_path, out_path)
    return count


def transcribe_file(model, video_path: str, language: str, force: bool) -> str:
    """Transcribe one video to a sibling .srt. Returns a status string."""
    out_path = srt_path_for(video_path)

    if os.path.exists(out_path) and not force:
        print(f"  SKIP (exists): {out_path}")
        return "skipped"

    print(f"  Transcribing: {video_path}")
    try:
        segments, info = model.transcribe(
            video_path,
            language=None if language in (None, "", "auto") else language,
            vad_filter=True,
        )
        detected = getattr(info, "language", None)
        if detected:
            prob = getattr(info, "language_probability", 0.0) or 0.0
            print(f"    language: {detected} ({prob:.2f})")

        cues = write_srt(segments, out_path)
    except Exception as exc:  # noqa: BLE001 - report, keep batch going
        print(f"  ERROR transcribing {video_path}: {exc}", file=sys.stderr)
        # Clean up any partial file from this attempt.
        for leftover in (out_path + ".part",):
            try:
                if os.path.exists(leftover):
                    os.remove(leftover)
            except OSError:
                pass
        return "error"

    print(f"  WROTE {cues} cues -> {out_path}")
    return "done"


def parse_args(argv) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="transcribe.py",
        description=(
            "Local FREE fallback: transcribe lecture videos to .srt with "
            "faster-whisper (use instead of spending Gemini tokens)."
        ),
    )
    parser.add_argument(
        "path",
        help="A single video file OR a directory to scan recursively.",
    )
    parser.add_argument(
        "--model",
        default="large-v3",
        help="Whisper model size/name (default: large-v3, best for Chinese).",
    )
    parser.add_argument(
        "--language",
        default="zh",
        help="Spoken language code, e.g. zh, en. Use 'auto' to detect.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "cuda"],
        help="Compute device (default: auto -> cuda if available else cpu).",
    )
    parser.add_argument(
        "--compute-type",
        default="auto",
        help=(
            "CTranslate2 compute type, e.g. float16, int8, int8_float16 "
            "(default: auto -> float16 on cuda, int8 on cpu)."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-transcribe even if a sibling .srt already exists.",
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    # Import here so --help and arg parsing work without the dependency, and
    # so a missing package produces a friendly message instead of a traceback.
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "faster-whisper is not installed.\n"
            "  pip install faster-whisper\n"
            "Hint: this is the FREE local fallback to transcribe videos "
            "without spending Gemini tokens (ffmpeg must also be on PATH).",
            file=sys.stderr,
        )
        return 2

    inputs = collect_inputs(args.path)
    if not inputs:
        if not os.path.exists(args.path):
            print(f"Path not found: {args.path}", file=sys.stderr)
        else:
            print(
                f"No videos ({', '.join(VIDEO_EXTENSIONS)}) found under: "
                f"{args.path}",
                file=sys.stderr,
            )
        return 1

    device, compute_type = pick_device_and_compute(
        args.device, args.compute_type
    )

    print(
        f"Loading model '{args.model}' on {device} ({compute_type})... "
        "first run downloads weights and may take a while.",
        flush=True,
    )
    try:
        model = WhisperModel(
            args.model, device=device, compute_type=compute_type
        )
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to load model '{args.model}': {exc}", file=sys.stderr)
        if device == "cuda":
            print(
                "Hint: GPU load failed. Retry with --device cpu, or install "
                "the CUDA libraries faster-whisper requires.",
                file=sys.stderr,
            )
        return 3

    total = len(inputs)
    print(f"Found {total} video(s) to process.\n")

    stats = {"done": 0, "skipped": 0, "error": 0}
    for position, video_path in enumerate(inputs, start=1):
        print(f"[{position}/{total}] {os.path.basename(video_path)}")
        status = transcribe_file(model, video_path, args.language, args.force)
        stats[status] = stats.get(status, 0) + 1
        print("")

    print("=" * 60)
    print(
        "Summary: "
        f"{stats['done']} transcribed, "
        f"{stats['skipped']} skipped, "
        f"{stats['error']} failed "
        f"(of {total} total)."
    )

    return 0 if stats["error"] == 0 else 4


if __name__ == "__main__":
    sys.exit(main())
