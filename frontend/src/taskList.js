// Task lists: notes that open on the task board instead of the editor.
// A `.tasks.md` file always is one; any other note is one when it holds
// nothing but tasks (headings and blank lines aside).

export const TASK_LIST_SUFFIX = '.tasks.md';

// Same bullets as the server's task parser (tasks.go taskLineRe), top level only.
const TASK_LINE = /^[-*+][ \t]+\[[ xX]\]/;
const HEADING = /^#{1,6}([ \t]|$)/;
const COMMENT = /^<!--.*-->[ \t]*$/;

export function isTaskListPath(path) {
  return typeof path === 'string' && path.toLowerCase().endsWith(TASK_LIST_SUFFIX);
}

// isTaskOnlyDoc reports whether a note is only tasks: every top-level line is a
// task, a heading, a one-line comment or blank, indented lines belong to a task
// (its fields, steps and notes), and there is at least one task. A leading
// frontmatter block is skipped.
export function isTaskOnlyDoc(content) {
  if (typeof content !== 'string') return false;
  let text = content.replace(/^\uFEFF/, '');
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (fm) text = text.slice(fm[0].length);
  let tasks = 0;
  let inTask = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (/^[ \t]/.test(line)) {
      if (!inTask) return false;
      continue;
    }
    if (TASK_LINE.test(line)) {
      tasks++;
      inTask = true;
    } else if (HEADING.test(line) || COMMENT.test(line)) {
      inTask = false;
    } else {
      return false;
    }
  }
  return tasks > 0;
}

// taskListName turns what was typed in "+ Tasks" into a `.tasks.md` file name.
export function taskListName(name) {
  const base = name.trim().replace(/^\/+/, '');
  if (isTaskListPath(base)) return base;
  return base.replace(/\.md$/i, '') + TASK_LIST_SUFFIX;
}
