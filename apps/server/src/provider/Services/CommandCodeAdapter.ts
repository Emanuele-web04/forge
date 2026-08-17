/** Command Code CLI implementation of the generic provider adapter contract. */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CommandCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "commandcode";
}

export class CommandCodeAdapter extends ServiceMap.Service<
  CommandCodeAdapter,
  CommandCodeAdapterShape
>()("synara/provider/Services/CommandCodeAdapter") {}
