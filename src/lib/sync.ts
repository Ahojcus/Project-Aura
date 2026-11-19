import {
  applyCssTokens,
  hydrateSharedSettings,
  useSettings,
  type ModuleKey,
  type Settings,
} from "../store/settings";
import { getWindowLabel, hasTauri } from "./bridge";
import { disableModuleContextMenu } from "./contextMenu";

const LABEL = getWindowLabel();

function modulePos(settings: Settings, key: ModuleKey) {
  const mod = settings[key] as
    | { win?: { x: number | null; y: number | null; monitor?: { x: number; y: number } | null } }
    | undefined;
  return {
    x: mod?.win?.x ?? null,
    y: mod?.win?.y ?? null,
    monitor: mod?.win?.monitor ? [mod.win.monitor.x, mod.win.monitor.y] : null,
  };
}

async function safeInvoke(cmd: string, args: Record<string, unknown>) {
  if (!hasTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke(cmd, args);
  } catch {
    /* backend not ready yet */
  }
}

/** Startup reveal cadence (ms between enabled modules). */
const MODULE_REVEAL_STEP_MS = 220;
/** Safety valve for an enabled module page that never announces readiness. */
const STARTUP_READY_TIMEOUT_MS = 10_000;
/** Recover a page that started before the coordinator began listening. */
const STARTUP_PROBE_MS = 250;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * A sign-in launch can start before Explorer and the final monitor/DPI layout
 * exist, which produces windows at the wrong scale or position. The backend
 * keeps startup pending until the shell window and at least one monitor are
 * available, then marks startup ready. Listen before checking the durable flag
 * so a settle between those two steps cannot be missed.
 */
async function waitForStartupSettle() {
  if (!hasTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const unlisten = await listen("aura:startup-settled", resolveSettled);
    if (await invoke<boolean>("startup_is_ready").catch(() => false)) {
      unlisten();
      return;
    }
    await settled;
    unlisten();
  } catch {
    /* event bridge unavailable */
  }
}

/**
 * The settings window is the single startup coordinator. Module pages announce
 * that they have booted, then wait for their reveal event. Waiting for every
 * enabled page before revealing anything makes the General order independent of
 * page-load timing without storing stale startup state across app launches.
 */
async function revealModulesAtStartup(settings: Settings) {
  if (!hasTauri()) return;
  const order = [...new Set(settings.moduleOrder.filter((key) => settings.modules[key]))];
  if (order.length === 0) return;

  const { listen, emit } = await import("@tauri-apps/api/event");
  const ready = new Set<ModuleKey>();
  const revealed = new Set<ModuleKey>();

  await listen<{ label: string }>("aura:module-ready", ({ payload }) => {
    const label = payload.label as ModuleKey;
    if (!order.includes(label)) return;
    ready.add(label);
    // A page can finish booting after its one-shot reveal has already gone
    // out. Answer it for the lifetime of the window rather than exposing a
    // mounted-but-empty page behind a visible native window.
    if (revealed.has(label)) {
      void emit("aura:module-reveal", { label });
    }
  });
  // Do not measure or reveal modules until the native shell has told us the
  // monitors and their DPI scale are final.
  await waitForStartupSettle();
  // Recover readiness announced before this listener existed. Probes are
  // awaited so no event is still in flight when the reveal pass starts.
  const deadline = Date.now() + STARTUP_READY_TIMEOUT_MS;
  while (ready.size < order.length && Date.now() < deadline) {
    await emit("aura:startup-probe").catch(() => {});
    await sleep(STARTUP_PROBE_MS);
  }

  for (let index = 0; index < order.length; index++) {
    if (index > 0) await sleep(MODULE_REVEAL_STEP_MS);
    const key = order[index];
    const current = useSettings.getState().settings;
    const cloakedOverlay =
      current.notch.cloakActive && (key === "clock" || key === "todo" || key === "statusbar");
    // The wallpaper is embedded into Explorer by its own page only after the
    // video surface has mounted. Showing it from here first leaves a black
    // backdrop, so its reveal event is its startup signal instead.
    if (key !== "wallpaper" && current.modules[key] && !cloakedOverlay) {
      await safeInvoke("set_module_visible", {
        label: key,
        visible: true,
        ...modulePos(current, key),
      });
    }
    revealed.add(key);
    await emit("aura:module-reveal", { label: key });
  }

  // The listener stays registered for late pages so a slow cold-boot page
  // still receives its reveal instead of remaining hidden.
}

/** Announce this module page and wait for its turn in the startup order. */
async function waitForStartupReveal() {
  if (!hasTauri()) return;
  try {
    const { listen, emit } = await import("@tauri-apps/api/event");
    let resolveRevealed!: () => void;
    const revealed = new Promise<void>((resolve) => {
      resolveRevealed = resolve;
    });

    // Register before announcing: the coordinator may reveal immediately once
    // the last page is ready.
    const unlistenReveal = await listen<{ label: string }>(
      "aura:module-reveal",
      ({ payload }) => {
        if (payload.label === LABEL) resolveRevealed();
      },
    );
    // The coordinator probes after the native shell settles to recover
    // announcements that arrived before its listener was ready. A page that
    // mounts after a probe announces itself below.
    const unlistenProbe = await listen("aura:startup-probe", () => {
      void emit("aura:module-ready", { label: LABEL }).catch(() => {});
    });
    void emit("aura:module-ready", { label: LABEL }).catch(() => {});

    await revealed;
    unlistenReveal();
    unlistenProbe();
  } catch {
    /* event bridge unavailable */
  }
}

/** Wire settings changes from other windows into this renderer. */
export async function setupSettingsSync(moduleKey?: ModuleKey) {
  // Every overlay module shares this suppression; the settings window is not a
  // module and keeps the native text-editing menu.
  if (moduleKey) disableModuleContextMenu();
  // Dev and packaged launches are different origins with separate localStorage,
  // so read the shared settings file before anything is measured or revealed.
  await hydrateSharedSettings();
  const settings = useSettings.getState().settings;
  applyCssTokens(settings);
  // A per-display duplicate is shown/positioned by the backend; only the main
  // window drives native visibility for its module.
  const isExtra = moduleKey != null && LABEL !== moduleKey;

  // Windows are created hidden. One coordinator in the settings window reveals
  // the enabled modules in General order; this page stays unmounted until its
  // own reveal event. That makes the order independent of page load timing,
  // and prevents post-mount effects from revealing a module early.
  if (moduleKey) {
    // Only main pages take part in startup sequencing. Duplicates mount
    // immediately and are shown by the backend after their main module.
    // The wallpaper is the exception: its video surface must be mounted and
    // painting before the window is embedded into Explorer's WorkerW.
    if (settings.modules[moduleKey] && !isExtra) {
      if (moduleKey === "wallpaper") {
        // Mount now, but still announce readiness so the settings coordinator
        // does not wait for its startup timeout before revealing other pages.
        void waitForStartupReveal();
      } else {
        await waitForStartupReveal();
      }
    }
  } else if (hasTauri()) {
    void revealModulesAtStartup(settings).catch(() => {});
  }

  // Keep the OS autostart entry reconciled on every boot.
  if (settings.launchOnStartup) {
    await safeInvoke("autostart_set", { enabled: true });
  }

  if (hasTauri()) {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<{ settings: Settings; from: string }>("aura:settings", ({ payload }) => {
        if (payload.from === LABEL) return;
        const before = useSettings.getState().settings;
        useSettings.getState().applyRemote(payload.settings);
        const cloaked =
          payload.settings.notch.cloakActive &&
          (moduleKey === "clock" || moduleKey === "todo" || moduleKey === "statusbar");
        if (
          moduleKey &&
          !isExtra &&
          (before.modules[moduleKey] !== payload.settings.modules[moduleKey] || cloaked)
        ) {
          void safeInvoke("set_module_visible", {
            label: LABEL,
            visible: payload.settings.modules[moduleKey] && !cloaked,
            ...modulePos(payload.settings, moduleKey),
          });
        }
      });

      // Lively lesson: monitors enumerate late at boot and after DisplayPort
      // hotplug. Re-show the module so its native window is repositioned on
      // the freshly enumerated display (notch/statusbar then re-fit themselves).
      await listen("aura:displays-changed", () => {
        const settings = useSettings.getState().settings;
        const cloaked =
          settings.notch.cloakActive &&
          (moduleKey === "clock" || moduleKey === "todo" || moduleKey === "statusbar");
        if (moduleKey && !isExtra && settings.modules[moduleKey] && !cloaked) {
          void safeInvoke("set_module_visible", {
            label: LABEL,
            visible: true,
            ...modulePos(settings, moduleKey),
          });
        }
      });
    } catch {
      /* event bridge unavailable: the window still renders from localStorage */
    }
  }

  useSettings.subscribe((state) => applyCssTokens(state.settings));
}
