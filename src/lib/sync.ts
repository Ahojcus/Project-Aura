import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { applyCssTokens, getLabel, hasTauri, useSettings } from "../store/settings";
import type { ModuleKey, Settings } from "../store/settings";

const LABEL = getLabel();

/** Manual x/y + target display of this module's window (nulls = automatic). */
function modulePos(settings: Settings): {
  x: number | null;
  y: number | null;
  monitor: [number, number] | null;
} {
  const mod = settings[LABEL as ModuleKey] as { win?: { x: number | null; y: number | null; monitor?: { x: number; y: number } | null } } | undefined;
  return {
    x: mod?.win?.x ?? null,
    y: mod?.win?.y ?? null,
    monitor: mod?.win?.monitor ? [mod.win.monitor.x, mod.win.monitor.y] : null,
  };
}

const safeInvoke = (cmd: string, args: Record<string, unknown>) => {
  if (hasTauri()) void invoke(cmd, args);
};

/** Wire settings changes from other windows into this renderer. */
export async function setupSettingsSync(moduleKey?: ModuleKey) {
  const settings = useSettings.getState().settings;
  applyCssTokens(settings);

  // Apply our module toggle on boot (windows are created hidden).
  if (moduleKey && settings.modules[moduleKey]) {
    safeInvoke("set_module_visible", { label: LABEL, visible: true, ...modulePos(settings) });
  }

  // Autostart reconciliation: every renderer boot re-claims the OS entry when
  // the setting says on (a no-op when it already exists — idempotent enable).
  if (settings.launchOnStartup) {
    safeInvoke("autostart_set", { enabled: true });
  }

  if (hasTauri()) {
    await listen<{ settings: Settings; from: string }>(
      "aura:settings",
      ({ payload }) => {
        if (payload.from === LABEL) return;
        const before = useSettings.getState().settings;
        useSettings.getState().applyRemote(payload.settings);
        if (moduleKey) {
          const was = before.modules[moduleKey];
          const now = payload.settings.modules[moduleKey];
          if (was !== now) {
            safeInvoke("set_module_visible", { label: LABEL, visible: now, ...modulePos(payload.settings) });
          }
        }
      },
    );
  }

  // Keep CSS tokens in sync even for changes that only matter visually.
  useSettings.subscribe((state) => applyCssTokens(state.settings));
}
