import { ChevronDownIcon, ChevronUpIcon } from "~/lib/icons";

import { IconButton } from "./ui/icon-button";

export interface DiffPanelChangeNavigation {
  canGoToPrevious: boolean;
  canGoToNext: boolean;
  previousShortcutLabel: string | null;
  nextShortcutLabel: string | null;
  onGoToPrevious: () => void;
  onGoToNext: () => void;
}

function withShortcut(label: string, shortcutLabel: string | null): string {
  return shortcutLabel ? `${label} (${shortcutLabel})` : label;
}

export function DiffPanelChangeNavigationButtons(props: {
  navigation: DiffPanelChangeNavigation;
  className?: string;
}) {
  const { navigation } = props;
  return (
    <>
      <IconButton
        variant="ghost"
        size="icon-xs"
        className={props.className}
        disabled={!navigation.canGoToPrevious}
        label="Previous change"
        title={withShortcut("Previous change", navigation.previousShortcutLabel)}
        onClick={navigation.onGoToPrevious}
      >
        <ChevronUpIcon className="size-3.5" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="icon-xs"
        className={props.className}
        disabled={!navigation.canGoToNext}
        label="Next change"
        title={withShortcut("Next change", navigation.nextShortcutLabel)}
        onClick={navigation.onGoToNext}
      >
        <ChevronDownIcon className="size-3.5" />
      </IconButton>
    </>
  );
}
