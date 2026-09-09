// FILE: QueuedComposerDrainCoordinator.tsx
// Purpose: Keep the headless queued-composer drain running for the app session
//          so backgrounded threads dispatch when their live turn settles.
// Layer: Web app shell

import { useEffect } from "react";

import { resolveAssistantDeliveryMode, useAppSettings } from "../appSettings";
import {
  setQueuedComposerDrainAssistantDeliveryMode,
  startQueuedComposerDrainWatcher,
} from "../lib/queuedComposerDrain";

export function QueuedComposerDrainCoordinator() {
  const { settings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);

  useEffect(() => {
    return startQueuedComposerDrainWatcher();
  }, []);

  useEffect(() => {
    setQueuedComposerDrainAssistantDeliveryMode(assistantDeliveryMode);
  }, [assistantDeliveryMode]);

  return null;
}
