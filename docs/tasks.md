# Task Model

mdnest turns the GitHub‑flavoured task‑list items you already write in your notes
into a first‑class, board‑driven task tracker — **without a database**. Every task
lives as markdown inside a note, and the note is the single source of truth. The
[task board](user-guide.md#task-board) is just a projection of that markdown, so
anything you do on the board is a plain edit to the underlying note (and anything
you write in the note shows up on the board).

> **Off by default.** The board is opt-in: set `ENABLE_TASK_BOARD=true` in
> `mdnest.conf` (then `./mdnest-server reload`). While it is off, the
> `/api/tasks` and `/api/board` routes are not registered, the board button is
> hidden, and the frontend never loads the board's UI chunk — an install that
> doesn't want a task tracker carries none of it. Turning it on changes nothing
> about your notes: the checkboxes were already there, and turning it back off
> just stops projecting them.

This document specifies the on‑disk format. For how to *use* the board, see the
[User Guide](user-guide.md#task-board); for the HTTP endpoints, see the
[API Reference](api.md#task-board).

---

## A simple task

Any GFM checkbox is a task:

```markdown
- [ ] Buy milk
- [x] Ship the release
```

- `- [ ]` is open, `- [x]` (or `- [X]`) is done.
- `-`, `*` and `+` bullets are all accepted; indentation and the bullet
  character are preserved when mdnest rewrites a line.

That is all you need. Everything below is optional enrichment.

---

## A rich task

A task can carry an indented **detail block** directly under its checkbox line:
metadata, sub‑steps and a description. It stays valid, human‑readable markdown and
renders as a normal nested list in any viewer.

```markdown
- [ ] Design User Interface
  - status: doing
  - due: 2024-01-15
  - priority: high
  - workload: hard
  - assignee: alice
  - tags: [design, ui, frontend]
  - defaultExpanded: true
  - steps:
    - [x] Wireframes
    - [ ] Visual design
  - notes: |
    Design login & registration pages:
    - Responsive layout
    - Brand colors
```

The **detail block** is every line more indented than the task's checkbox line.
It ends at the first line that dedents back to (or past) the task's indentation.

### Metadata fields

Metadata are `- key: value` bullets inside the detail block. Unknown keys are
ignored, so you can keep your own notes alongside.

| Field | Value | Meaning |
|-------|-------|---------|
| `status` | a column's status value (e.g. `doing`) | Which board column the task sits in when it is not done. See [Columns](#columns-and-the-board-sidecar). |
| `due` | `YYYY-MM-DD` | Due date. The board flags it red when it is in the past and the task is not done. |
| `priority` | `high` \| `medium` \| `low` | Shown as a coloured badge. |
| `workload` | free text (e.g. `easy` / `medium` / `hard`) | Effort estimate. |
| `assignee` | free text (a username) | Who is responsible for the task. Shown as a badge; the board's create form defaults it to the current user. |
| `tags` | `[a, b, c]` | Comma‑separated list in brackets. Shown as chips. |
| `depends-on` | `[OGFC-q6s4c, OGFC-ab12x]` | Refs of tasks this one depends on. The board resolves each ref to the live task and flags this task **blocked** while a referenced task is still open. Titles written by older notes still resolve as a fallback. |
| `blocked-by` | `[OGFC-q6s4c]` | Refs of tasks blocking this one (same blocked behaviour as `depends-on`). |
| `related-to` | `[OGFC-q6s4c]` | Refs of loosely related tasks, shown as reference chips. |
| `defaultExpanded` | `true` | The board card shows its steps/notes expanded by default. |

### Steps (sub‑tasks)

**Any checkbox nested inside a task's detail block is a step** of that task — the
`steps:` line is an optional label for readability:

```markdown
- [ ] Release v2
  - steps:
    - [x] Cut the tag
    - [ ] Publish images
```

Steps are toggled independently and drive the card's progress bar
(`done / total`). They are ordinary checkboxes, so they render and edit like any
other list item.

### Description

The task description is read from **either** form (whichever is present):

- a `- notes: |` block scalar, whose indented lines are the text, **or**
- a fenced code block inside the detail block:

  ````markdown
  - [ ] With a fenced description
    ```md
    Free‑form **markdown** description.
    ```
  ````

When mdnest writes a description (from the editor) it uses the `notes: |` form.
Fenced blocks are opaque to the parser, so `- [ ]` lines inside them are *not*
mistaken for tasks or steps.

---

## Columns and the board sidecar

Columns are defined per namespace in a sidecar file, `.mdnest/board.json`
(mirroring the `.mdnest/comments` convention). When it is absent a default
**To Do / Doing / Done** board is used.

```json
{
  "version": 1,
  "defaultNote": "tasks.md",
  "columns": [
    { "id": "todo",  "title": "To Do",  "status": "todo" },
    { "id": "doing", "title": "Doing",  "status": "doing" },
    { "id": "done",  "title": "Done",   "status": "done", "done": true }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `columns[].id` | Stable identifier (never rewritten once created). |
| `columns[].title` | Display name. |
| `columns[].status` | The value written to a task's `status:` field when it is dropped in this column. |
| `columns[].done` | Marks the column that holds **checked** items. Exactly one column is normally `done`. |
| `defaultNote` | Note that new tasks are appended to when the author does not pick one. |

Legacy note: an inline `#status` tag on the task title (e.g. `- [ ] Fix bug #doing`)
is still read as a fallback status when there is no `status:` field. New writes
always use the `status:` field, so nothing leaks into your prose.

### How a task's column is resolved

1. If the checkbox is **checked** → the `done` column (the checkbox always wins).
2. Else if a `status:` field matches a column's `status` → that column.
3. Else if the title carries a legacy `#tag` matching a column → that column.
4. Else → the first non‑done column.

Moving a card on the board writes the target column's `status` into the task
(materialising a minimal detail block for a previously‑simple task) and, for the
done column, checks the box. So the two views never disagree.

---

## Editing semantics

Because the note is authoritative, every board action is a line‑level edit:

- **Create** appends a rendered task block to a note (the chosen note, else
  `defaultNote`), creating the note if it does not exist.
- **Edit** replaces a task's whole block — the checkbox line plus its detail
  block — with a freshly rendered one.
- **Move** rewrites the `status:` field and the checkbox.
- **Toggle** flips a task or step checkbox.

All edits are guarded by optimistic concurrency: the client sends the exact
source line it saw, and the server rejects the write with `409 Conflict` if that
line has since changed, so a concurrent edit can never be silently clobbered —
refresh and retry. See the [API Reference](api.md#task-board) for the request
shapes.
