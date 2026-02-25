import type { AwsCredentialIdentity } from "@smithy/types";
import type { AccountID } from "./Account.ts";
import type { RegionID } from "./Region.ts";

export interface AwsStageConfig {
  account?: AccountID;
  region?: RegionID;
  profile?: string;
  credentials?: AwsCredentialIdentity;
  endpoint?: string;
}

declare module "../Stage.ts" {
  interface StageConfigOptions {
    aws?: AwsStageConfig;
  }
}
