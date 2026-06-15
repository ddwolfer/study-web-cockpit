# docs/ — demo media

Two assets bring the README to life. Both are quick to record and are the only
media in this repo (kept small on purpose).

## 1. `demo.gif` — the money shot

A short (~10–20s) screen recording of the cockpit in action, referenced at the
top of the root `README.md`. Capture this flow:

1. Browser chat → ask the coach to open the **URL Shortener** lesson.
2. Left panel renders the clickable notes (`show_notes`).
3. Click an amber **term** → the glossary card pops up.
4. Click a **`[MM:SS]` timestamp** → the video panel seeks.

Record with any screen recorder, then convert to GIF (e.g. `ffmpeg -i clip.mp4
-vf "fps=12,scale=900:-1" docs/demo.gif`, or [Gifski](https://gif.ski/)). Aim
for < 8 MB. Save it here as `docs/demo.gif`.

## 2. The demo lesson video

`demo-lessons/01_Demo/01. URL Shortener/` ships the notes; drop a short,
**self-recorded** screen capture of you sketching the architecture as the
lesson's `.mp4` in that folder to light up the in-browser player. The
`.gitignore` allows `.mp4` only under `demo-lessons/**` — keep it small
(< 25 MB; GitHub rejects files > 100 MB).

> Until you add these, the README shows a broken-image placeholder for the GIF
> and the lesson loads notes without a player. Everything else works on clone.
