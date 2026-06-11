import {
  collectContainerImages,
  toRuntimeDurableObjectNamespaces,
} from "@/Cloudflare/Workers/LocalWorkerProvider";
import { describe, expect, test } from "vitest";

const binding = (containers?: { className: string; imageName?: string }[]) => ({
  data: { containers },
});

describe("collectContainerImages", () => {
  test("maps className to imageName for entries that carry an image", () => {
    expect(
      collectContainerImages([
        binding([{ className: "SheetDo", imageName: "sql:dev" }]),
      ]),
    ).toEqual({ SheetDo: "sql:dev" });
  });

  test("skips remote-only attachments (no imageName)", () => {
    expect(
      collectContainerImages([
        binding([
          { className: "WithImage", imageName: "img:dev" },
          { className: "RemoteOnly" },
        ]),
      ]),
    ).toEqual({ WithImage: "img:dev" });
  });

  test("tolerates bindings with no containers and empty input", () => {
    expect(collectContainerImages([])).toEqual({});
    expect(collectContainerImages([binding(), binding([])])).toEqual({});
  });

  test("last entry wins on a className collision", () => {
    expect(
      collectContainerImages([
        binding([{ className: "Dup", imageName: "first:dev" }]),
        binding([{ className: "Dup", imageName: "second:dev" }]),
      ]),
    ).toEqual({ Dup: "second:dev" });
  });
});

describe("toRuntimeDurableObjectNamespaces", () => {
  test("emits sql-backed namespaces with no container by default", () => {
    expect(toRuntimeDurableObjectNamespaces({ Counter: "uniq-1" })).toEqual([
      { className: "Counter", uniqueKey: "uniq-1", sql: true },
    ]);
  });

  test("attaches container only to namespaces with a mapped image", () => {
    const result = toRuntimeDurableObjectNamespaces(
      { SheetDo: "uniq-1", Plain: "uniq-2" },
      { SheetDo: "sql:dev" },
    );
    expect(result).toEqual([
      {
        className: "SheetDo",
        uniqueKey: "uniq-1",
        sql: true,
        container: { imageName: "sql:dev" },
      },
      { className: "Plain", uniqueKey: "uniq-2", sql: true },
    ]);
  });
});
