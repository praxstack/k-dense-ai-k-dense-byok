"use client";

import { useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChromeIcon,
  GlobeIcon,
  MonitorIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useBrowserUseSettings,
  useChromeProfiles,
  type BrowserUseConfig,
  type ChromeProfile,
} from "@/lib/use-settings";

/** Label for the configured profile, falling back to the directory id. */
export function profileLabel(
  profileId: string | null,
  profiles: ChromeProfile[],
): string | null {
  if (!profileId) return null;
  const match = profiles.find((p) => p.id === profileId);
  return match?.name ?? profileId;
}

/**
 * Picker UI for browser automation — no trigger / no popover wrapper.
 * Reads/writes settings via the shared hooks.
 */
export function BrowserPickerBody() {
  const bu = useBrowserUseSettings();
  const profiles = useChromeProfiles();

  const enabled = bu.config.enabled;
  const headed = bu.config.headed;
  const profileId = bu.config.profile;
  const usingRealChrome = Boolean(profileId);

  const toggleRealChrome = (v: boolean) => {
    if (v) {
      const first = profiles.profiles[0]?.id ?? "Default";
      bu.save({ profile: first, headed: true });
    } else {
      bu.save({ profile: null });
    }
  };

  return (
    <div className="flex flex-col">
      <label className="flex items-start justify-between gap-3 px-3 py-2.5 hover:bg-muted/40 cursor-pointer">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <GlobeIcon className="size-3 shrink-0 text-muted-foreground" />
            Enable browser automation
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
            Register the browser-use MCP so Kady and the expert can drive a
            browser.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => bu.save({ enabled: Boolean(v) })}
          disabled={bu.saving}
        />
      </label>

      <label
        className={cn(
          "flex items-start justify-between gap-3 border-t px-3 py-2.5 hover:bg-muted/40 cursor-pointer",
          !enabled && "opacity-50 pointer-events-none",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <ChromeIcon className="size-3 shrink-0 text-muted-foreground" />
            Use my real Chrome (with logins)
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
            Attach to your installed Chrome so cookies, sessions, and extensions
            come along. Close Chrome first.
          </p>
        </div>
        <Switch
          checked={usingRealChrome}
          onCheckedChange={toggleRealChrome}
          disabled={bu.saving || !enabled}
        />
      </label>

      {usingRealChrome && profiles.profiles.length > 0 && (
        <div
          className={cn(
            "flex items-start justify-between gap-3 border-t px-3 py-2.5",
            !enabled && "opacity-50 pointer-events-none",
          )}
        >
          <div className="min-w-0">
            <div className="text-xs font-medium">Profile</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
              Which Chrome profile to attach to.
            </p>
          </div>
          <Select
            value={profileId ?? ""}
            onValueChange={(v) => bu.save({ profile: v })}
            disabled={bu.saving || !enabled}
          >
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue placeholder="Pick profile" />
            </SelectTrigger>
            <SelectContent>
              {profiles.profiles.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  <div className="flex flex-col items-start">
                    <span className="font-medium">{p.name}</span>
                    {p.email && p.email !== p.name ? (
                      <span className="text-[10px] text-muted-foreground">
                        {p.email}
                      </span>
                    ) : null}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <label
        className={cn(
          "flex items-start justify-between gap-3 border-t px-3 py-2.5 hover:bg-muted/40 cursor-pointer",
          (!enabled || usingRealChrome) && "opacity-50 pointer-events-none",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <MonitorIcon className="size-3 shrink-0 text-muted-foreground" />
            Show browser window
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
            {usingRealChrome
              ? "Real Chrome always shows its window."
              : "Launch Chromium with a visible window. Off = headless."}
          </p>
        </div>
        <Switch
          checked={usingRealChrome ? true : headed}
          onCheckedChange={(v) => bu.save({ headed: Boolean(v) })}
          disabled={bu.saving || !enabled || usingRealChrome}
        />
      </label>

      <div className="border-t bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground leading-relaxed">
        More options (session name) live in{" "}
        <span className="font-medium text-foreground">Settings</span> →{" "}
        <span className="font-medium text-foreground">Browser</span>.
      </div>
    </div>
  );
}

export function BrowserSelector() {
  const bu = useBrowserUseSettings();
  const profiles = useChromeProfiles();
  const [open, setOpen] = useState(false);

  const enabled = bu.config.enabled;
  const headed = bu.config.headed;
  const profileId = bu.config.profile;
  const usingRealChrome = Boolean(profileId);

  const resolvedLabel = useMemo(
    () => profileLabel(profileId, profiles.profiles),
    [profileId, profiles.profiles],
  );

  const chipLabel = !enabled
    ? "Browser: Off"
    : usingRealChrome
      ? `Browser: ${resolvedLabel ?? "Real Chrome"}`
      : headed
        ? "Browser: Headed"
        : "Browser: On";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 cursor-pointer transition-colors text-xs select-none",
            open || enabled
              ? "border-border bg-muted/60"
              : "border-transparent hover:border-border hover:bg-muted/40",
          )}
          role="button"
          tabIndex={0}
        >
          {usingRealChrome ? (
            <ChromeIcon
              className={cn(
                "size-3 shrink-0",
                enabled ? "text-foreground" : "text-muted-foreground",
              )}
            />
          ) : (
            <GlobeIcon
              className={cn(
                "size-3 shrink-0",
                enabled ? "text-foreground" : "text-muted-foreground",
              )}
            />
          )}
          <span
            className={cn(
              "whitespace-nowrap",
              enabled ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {chipLabel}
          </span>
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform ml-0.5",
              open && "rotate-180",
            )}
          />
        </div>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-96 p-0 overflow-hidden rounded-xl shadow-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Browser
          </span>
          <span className="text-[10px] text-muted-foreground">
            browser-use CLI
          </span>
        </div>
        <BrowserPickerBody />
      </PopoverContent>
    </Popover>
  );
}

export function buildBrowserContext(
  config: BrowserUseConfig,
  profiles: ChromeProfile[] = [],
): string {
  if (!config.enabled) return "";

  let mode: string;
  if (config.profile) {
    const label = profileLabel(config.profile, profiles) ?? config.profile;
    mode = `the user's real Chrome (profile "${label}") with their existing logins and cookies`;
  } else if (config.headed) {
    mode = "a headed local Chromium (fresh managed profile)";
  } else {
    mode = "a headless local Chromium (fresh managed profile)";
  }

  return (
    `\n\n[Browser]\n` +
    `Browser automation is enabled via the browser-use MCP using ${mode}. ` +
    `You may call the browser-use tools (navigate, state, click, type, screenshot, eval, etc.) ` +
    `to inspect or interact with web pages when useful for this task.`
  );
}
