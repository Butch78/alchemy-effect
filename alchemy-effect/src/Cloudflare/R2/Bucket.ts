import type { R2 } from "cloudflare/resources";
import * as Effect from "effect/Effect";

import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";
import { CloudflareApi } from "../CloudflareApi.ts";
import { Worker } from "../Workers/Worker.ts";

export type BucketName = string;

export type BucketProps = {
  name?: string;
  storageClass?: Bucket.StorageClass;
  jurisdiction?: Bucket.Jurisdiction;
  locationHint?: Bucket.Location;
};

export interface Bucket extends Resource<
  Bucket,
  "Cloudflare.R2.Bucket",
  BucketProps,
  {
    bucketName: BucketName;
    storageClass: Bucket.StorageClass;
    jurisdiction: Bucket.Jurisdiction;
    location: Bucket.Location | undefined;
    accountId: string;
  },
  Bucket
> {}

export const Bucket = Resource<Bucket>("Cloudflare.R2.Bucket");

export declare namespace Bucket {
  export type StorageClass = "Standard" | "InfrequentAccess";
  export type Jurisdiction = "default" | "eu" | "fedramp";
  export type Location = "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc";
}

export const BucketProvider = () =>
  Bucket.provider.effect(
    Effect.gen(function* () {
      const api = yield* CloudflareApi;
      const accountId = yield* Account;

      const createBucketName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return (yield* createPhysicalName({
            id,
            maxLength: 63,
          })).toLowerCase();
        });

      const mapResult = <Props extends BucketProps>(
        bucket: R2.Bucket,
      ): Bucket["attr"] =>
        ({
          bucketName: bucket.name,
          storageClass: bucket.storage_class ?? "Standard",
          jurisdiction: bucket.jurisdiction ?? "default",
          location: bucket.location,
          accountId,
        }) as Bucket["attr"];

      return {
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          const name = yield* createBucketName(id, news.name);
          if (
            output.accountId !== accountId ||
            output.bucketName !== name ||
            output.jurisdiction !== (news.jurisdiction ?? "default") ||
            olds.locationHint !== news.locationHint
          ) {
            return { action: "replace" };
          }
          if (output.storageClass !== (news.storageClass ?? "Standard")) {
            return {
              action: "update",
              stables: output.bucketName === name ? ["name"] : undefined,
            };
          }
        }),
        create: Effect.fnUntraced(function* ({ id, news }) {
          const name = yield* createBucketName(id, news.name);
          const bucket = yield* api.r2.buckets
            .create({
              account_id: accountId,
              name,
              storageClass: news.storageClass,
              jurisdiction: news.jurisdiction,
              locationHint: news.locationHint,
            })
            .pipe(
              // Handle idempotency: if bucket already exists and we own it, adopt it
              Effect.catchTag("Conflict", () =>
                api.r2.buckets.get(name, { account_id: accountId }),
              ),
            );
          return mapResult<BucketProps>(bucket);
        }),
        update: Effect.fnUntraced(function* ({ news, output }) {
          const bucket = yield* api.r2.buckets.edit(output.bucketName, {
            account_id: output.accountId,
            storage_class: news.storageClass ?? output.storageClass,
            jurisdiction: output.jurisdiction,
          });
          return mapResult<BucketProps>(bucket);
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* api.r2.buckets
            .delete(output.bucketName, {
              account_id: output.accountId,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fnUntraced(function* ({ id, output, olds }) {
          const name =
            output?.bucketName ?? (yield* createBucketName(id, olds?.name));
          const params = {
            account_id: output?.accountId ?? accountId,
            name,
          };
          return yield* api.r2.buckets
            .get(params.name, { account_id: params.account_id })
            .pipe(
              Effect.map(mapResult<BucketProps>),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
        }),
      };
    }),
  );

export interface Bind<B = Bucket> extends Capability<
  "Cloudflare.R2.Bucket.Bind",
  B
> {}

export const Bind = Binding<
  <B extends Bucket>(bucket: B) => Binding<Worker, Bind<To<B>>>
>(Worker, "Cloudflare.R2.Bucket.Bind");

export const bindFromWorker = () =>
  Bind.provider.succeed({
    attach: ({ source }) => ({
      bindings: [
        {
          type: "r2_bucket",
          name: source.id,
          bucket_name: source.attr.bucketName,
          jurisdiction:
            source.attr.jurisdiction === "default"
              ? undefined
              : source.attr.jurisdiction,
        },
      ],
    }),
  });
