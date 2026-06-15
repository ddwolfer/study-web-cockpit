# lessons/

This file only exists so git tracks the `lessons/` directory. You can delete it
once you've added a real lesson.

## Per-lesson folder convention

One folder per lesson, named **`<NN-slug>`** — a **2-digit lesson number** plus a
**kebab-case slug**:

```
lessons/
  03-cap-theorem/
    slides.pdf     <- the lecture slides
    lesson.mp4     <- the lecture video (Gemini watches this)
```

- `NN` is zero-padded (`01`, `02`, ... `03-cap-theorem`) so lessons sort in order.
- `slides.pdf` and `lesson.mp4` are the two files the study loop expects in each
  lesson folder. See the project `README.md` and `CLAUDE.md` for the full loop.
