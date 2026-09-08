import type { EnvironmentId, TerminalProfile, TerminalProfileSelection } from "@t3tools/contracts";
import { ChevronDown, Check, LoaderCircle, Plus } from "lucide-react";
import { useState } from "react";
import { useEnvironmentQuery } from "../state/query";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomRefresh } from "@effect/atom-react";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { toastManager } from "./ui/toast";
import { cn } from "~/lib/utils";

interface TerminalProfileSelectorProps {
  environmentId: EnvironmentId;
  onCreateTerminal: (profile?: TerminalProfileSelection) => void;
  newShortcutLabel?: string | undefined;
}

function selectionOf(profile: TerminalProfile): TerminalProfileSelection {
  return { executable: profile.executable, args: profile.args };
}

export function TerminalProfileSelector({
  environmentId,
  onCreateTerminal,
  newShortcutLabel,
}: TerminalProfileSelectorProps) {
  const profilesAtom = terminalEnvironment.profiles({ environmentId, input: {} });
  const query = useEnvironmentQuery(profilesAtom);
  const setDefaultProfile = useAtomCommand(terminalEnvironment.setDefaultProfile, {
    label: "set terminal default",
    reportFailure: false,
  });
  const refreshProfiles = useAtomRefresh(profilesAtom);
  const [pendingDefaultId, setPendingDefaultId] = useState<string | null>(null);

  const defaultProfileId = pendingDefaultId ?? query.data?.defaultProfileId ?? null;
  const selectDefault = async (profile: TerminalProfile) => {
    const previousDefaultId = query.data?.defaultProfileId ?? null;
    setPendingDefaultId(profile.id);
    const result = await setDefaultProfile({
      environmentId,
      input: selectionOf(profile),
    });
    if (result._tag === "Failure") {
      setPendingDefaultId(previousDefaultId);
      toastManager.add({
        type: "error",
        title: "Default shell was not changed",
        description:
          "The selected shell could not be saved. Your previous default is still active.",
      });
      return;
    }
    setPendingDefaultId(null);
    void refreshProfiles();
  };

  return (
    <div className="inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background shadow-xs">
      <button
        type="button"
        className="p-1 text-foreground/90 transition-colors hover:bg-accent"
        aria-label={
          newShortcutLabel
            ? `New terminal with default shell (${newShortcutLabel})`
            : "New terminal with default shell"
        }
        onClick={() => onCreateTerminal()}
      >
        <Plus className="size-3.25" />
      </button>
      <Menu
        onOpenChange={(open) => {
          if (open) {
            void refreshProfiles();
          }
        }}
      >
        <MenuTrigger
          className="border-l border-border/80 p-1 text-foreground/90 transition-colors hover:bg-accent"
          aria-label="Choose terminal shell"
        >
          <ChevronDown className="size-3.25" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-64">
          {query.isPending && !query.data ? (
            <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              Detecting shells…
            </div>
          ) : null}
          {query.data?.profiles.map((profile) => {
            const isDefault = profile.id === defaultProfileId;
            return (
              <MenuItem
                key={profile.id}
                onClick={() => onCreateTerminal(selectionOf(profile))}
                className="justify-between"
              >
                <span className="flex min-w-0 items-center gap-2 truncate">
                  {isDefault ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                  <span className="truncate">{profile.name}</span>
                </span>
                {isDefault ? (
                  <span className="shrink-0 text-xs text-muted-foreground">Default</span>
                ) : null}
              </MenuItem>
            );
          })}
          {query.data && query.data.profiles.length > 0 ? <MenuSeparator /> : null}
          <MenuSub>
            <MenuSubTrigger>Configure default shell</MenuSubTrigger>
            <MenuSubPopup className="w-64">
              {query.data?.profiles.map((profile) => {
                const isDefault = profile.id === defaultProfileId;
                const isPending = profile.id === pendingDefaultId;
                return (
                  <MenuItem
                    key={profile.id}
                    disabled={pendingDefaultId !== null}
                    onClick={() => void selectDefault(profile)}
                    className="justify-between"
                  >
                    <span className="flex min-w-0 items-center gap-2 truncate">
                      {isDefault ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                      <span className="truncate">{profile.name}</span>
                    </span>
                    {isPending ? (
                      <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
                    ) : isDefault ? (
                      <span className="shrink-0 text-xs text-muted-foreground">Default</span>
                    ) : null}
                  </MenuItem>
                );
              })}
              {query.data && query.data.profiles.length === 0 ? (
                <div className="px-2 py-1 text-xs text-muted-foreground">No shells detected</div>
              ) : null}
            </MenuSubPopup>
          </MenuSub>
          {query.data && query.data.profiles.length === 0 ? (
            <div className={cn("px-2 py-1 text-xs text-muted-foreground")}>No shells detected</div>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}
