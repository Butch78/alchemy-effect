import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import type { StageConfigOptions } from "./Stage.ts";

export interface AppProps {
  name: string;
  stage: string;
  config: StageConfigOptions;
}

export class App extends ServiceMap.Service<App, AppProps>()("App") {}

export const app = (input: AppProps) => Layer.succeed(App, App.of(input));
