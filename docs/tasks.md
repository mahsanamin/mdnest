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

**Task lists.** A note whose top‑level lines are only tasks, headings, one‑line
comments or blank lines (indented lines belonging to a task) opens on the board
instead of the editor, and so does any file named `*.tasks.md`, even empty. The
suffix is the explicit marker rather than frontmatter, which the Live editor
would rewrite; the file is plain markdown either way.

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
  - milestone: m1-reset
  - tags: [design, ui, frontend]
  - defaultExpanded: true
  - created-by: alice
  - created: 2024-01-08T09:30:00Z
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
| `milestone` | a milestone id (e.g. `m1-reset`) | The [milestone](#milestones) the task belongs to. Shown as a chip with the milestone's title. |
| `created-by` | a username | Who created the task. Written by mdnest when a task is created on the board, through the API or by an agent; never changed by an edit. Absent in single mode and on tasks written by hand. |
| `created` | UTC time, RFC 3339 (e.g. `2026-10-23T12:05:12Z`) | When the task was created. Written and kept like `created-by`. |
| `completed` | UTC time, RFC 3339 | When the task was last closed through mdnest (checked, moved or saved into the Done column, or created there). Removed when it is reopened, kept by edits; not editable. |
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
| `milestones` | The namespace's [milestones](#milestones). |

### Milestones

A milestone groups tasks towards a goal, over an optional period. Milestones
are defined next to the columns in `.mdnest/board.json`, and a task joins one with
its `milestone:` field:

```json
"milestones": [
  { "id": "m1-reset", "title": "M1 Reset", "start": "2026-11-01", "due": "2026-11-15", "description": "Board and notes match the code." },
  { "id": "m0-pilot", "title": "M0 Pilot", "closed": true }
]
```

```markdown
- [ ] Archive the old run reports
  - milestone: m1-reset
```

| Field | Meaning |
|-------|---------|
| `id` | Stable identifier written in the tasks: letters, digits, `.`, `_` or `-`. |
| `title` | Display name. |
| `start` | Optional `YYYY-MM-DD`, not after `due`. With `due`, the share of the period already gone is shown next to the progress, and tasks created after it count as scope added. |
| `due` | Optional `YYYY-MM-DD`. The milestone shows as late while it has open tasks past that date. |
| `description` | Optional text. |
| `closed` | A closed milestone is no longer offered for new tasks; its tasks keep it. |

A milestone's progress weighs its tasks: a done task counts 1, an open task the
share of its done steps, an open task without steps 0. Its page also shows the
tasks done (x/y), the steps done (a/b), the open tasks past their own due date or
blocked, and the participants (assignees and creators of its tasks).
Deleting a milestone leaves its tasks untouched: their `milestone:` field then
shows the bare id.

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
