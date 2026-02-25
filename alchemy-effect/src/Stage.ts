import * as ServiceMap from "effect/ServiceMap";

export class Stage extends ServiceMap.Service<Stage, string>()("Stage") {}

export class StageConfig extends ServiceMap.Service<
  StageConfig,
  StageConfigOptions
>()("StageConfig") {}

export interface StageConfigOptions {
  /**
   * Whether to retain the stage when destroying the stack.
   *
   * @default - true if the current stage starts with "prod"
   */
  retain?: boolean;

  /**
   * Whether to adopt resources that already exist during the created phase.
   *
   * @default false
   */
  adopt?: boolean;
}
