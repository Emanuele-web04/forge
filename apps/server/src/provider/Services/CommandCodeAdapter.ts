/** CommandCode headless CLI implementation of the provider adapter contract. */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CommandCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "commandCode";
}

export class CommandCodeAdapter extends ServiceMap.Service<
  CommandCodeAdapter,
  CommandCodeAdapterShape
>()("synara/provider/Services/CommandCodeAdapter") {}
