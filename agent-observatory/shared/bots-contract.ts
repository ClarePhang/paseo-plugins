/** bots-contract/v1 契约副本（单一事实源：paseo-bots-plus/shared/bots-contract.ts；目录 $PASEO_HOME/plugin-data/bots-contract/）。 */
import { z } from "zod";

export const CONTRACT_VERSION = "bots-contract/v1";

/** observatory → bots+（只读快照；读方容错，写方原子写）。 */
export const observatoryExportV1 = z
  .object({
    version: z.literal(CONTRACT_VERSION),
    generatedAt: z.string(),
    stopReasons: z
      .array(
        z.object({
          agentId: z.string(),
          kind: z.string(),
          reason: z.string(),
          ts: z.string(),
        }),
      )
      .default([]),
    attention: z
      .array(
        z.object({
          agentId: z.string(),
          kind: z.string(),
          reason: z.string(),
          ts: z.string(),
        }),
      )
      .default([]),
  })
  .strict();
export type ObservatoryExportV1 = z.output<typeof observatoryExportV1>;
