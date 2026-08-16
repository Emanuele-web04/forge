import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DeepSeekAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "deepseek";
}

export class DeepSeekAdapter extends ServiceMap.Service<DeepSeekAdapter, DeepSeekAdapterShape>()(
  "synara/provider/DeepSeekAdapter",
) {}
