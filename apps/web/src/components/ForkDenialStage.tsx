// FILE: ForkDenialStage.tsx
// Purpose: Tiny renderer for fork-denial stage copy.
// Layer: UI primitives

import { type ForkDenialStage, getForkDenialStages } from "../lib/forkDenial";

export interface ForkDenialStageChipProps {
  stage: ForkDenialStage;
}

export function ForkDenialStageChip({ stage }: ForkDenialStageChipProps) {
  return <span>{stage.label}</span>;
}

export interface ForkDenialStageListProps {
  stages: readonly ForkDenialStage[];
}

export function ForkDenialStageList({ stages }: ForkDenialStageListProps) {
  return (
    <ul>
      {stages.map((stage) => (
        <li key={stage.id}>
          <ForkDenialStageChip stage={stage} />
        </li>
      ))}
    </ul>
  );
}

export { getForkDenialStages };
