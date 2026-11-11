// What to tell someone when a note or a link cannot be opened. Opening used to
// fail silently: a link to a workspace you are not in landed on your last
// note, and a note that could not be read left an empty editor.

export function noteOpenError(e, ns, path) {
  const name = path || 'This note';
  if (e && e.name === 'PermissionError') {
    return `You don't have access to ${name} in ${ns}.`;
  }
  if (e && e.status === 404) {
    return `${name} was not found in ${ns}. It may have been moved or deleted.`;
  }
  if (e && e.status === 413) {
    return `${name} is too large to open in mdnest (over 10 MB).`;
  }
  return `Could not open ${name}.`;
}

export function workspaceLinkError(ns) {
  return `You don't have access to the workspace "${ns}", or it does not exist.`;
}
