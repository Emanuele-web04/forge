import type { ComputerControlMode } from "@synara/contracts";

/** Normalize durable user intent once, including older clients and saved queue entries. */
export function computerActivationMetadata(input: {
  readonly computerControlMode?: ComputerControlMode | undefined;
  readonly enableComputerControl?: boolean | undefined;
  readonly computerControlGeneration?: number | undefined;
}): {
  computerControlMode: ComputerControlMode;
  enableComputerControl: boolean;
  computerControlGeneration: number;
} {
  const computerControlMode =
    input.computerControlMode ?? (input.enableComputerControl === true ? "chat" : "off");
  return {
    computerControlMode,
    enableComputerControl: computerControlMode !== "off",
    computerControlGeneration: input.computerControlGeneration ?? 0,
  };
}
