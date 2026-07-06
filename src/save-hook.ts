/**
 * save-hook.ts — pure logic for tying into Obsidian's native save.
 *
 * Obsidian exposes no public save hook, so the plugin wraps the internal
 * `editor:save-file` command callback. This module isolates the wrap/restore
 * logic — no Obsidian imports — so its safety properties are unit-testable
 * (test/save-hook.test.ts): the wrapper runs the original save first, and the
 * restorer reverts ONLY if the callback is still ours (never stripping a
 * wrapper another plugin installed on top of us).
 */

/** The shape of an Obsidian command entry we care about — just its callback. */
export interface SaveCommand {
  callback?: () => unknown;
}

/**
 * Wrap `command.callback` so `afterSave` runs after the original save. Returns
 * a restore function, or null when there is no callable command to wrap (the
 * caller then relies on the palette command / a user hotkey instead).
 *
 * The wrapper always runs and returns the original callback's result, so the
 * native save is never suppressed. The restorer is identity-checked: if another
 * plugin has since replaced the callback, restoring is a no-op so that plugin's
 * wrapper survives our unload.
 */
export function installSaveHook(
  command: SaveCommand | undefined,
  afterSave: () => void,
): (() => void) | null {
  const original = command?.callback;
  if (!command || typeof original !== "function") return null;
  const wrapped = (): unknown => {
    const result = original();
    try {
      afterSave();
    } catch (e) {
      // A save hook must never break the native save it wraps.
      console.error("[knobe-lens] save hook afterSave failed:", e);
    }
    return result;
  };
  command.callback = wrapped;
  return () => {
    if (command.callback === wrapped) command.callback = original;
  };
}
