/** Empty/root folder selects the whole vault; match on directory boundaries. */
export function withinFolder(path: string, folder: string): boolean {
  const root = folder.trim().replace(/^\/+|\/+$/g, "");
  return !root || path.startsWith(`${root}/`);
}

/** Keep the selected scope attached to a folder when it or an ancestor moves. */
export function renamedVerificationFolder(folder: string, oldPath: string, newPath: string): string {
  if (folder === oldPath || folder.startsWith(`${oldPath}/`)) {
    return newPath + folder.slice(oldPath.length);
  }
  return folder;
}
