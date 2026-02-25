import type * as lambda from "aws-lambda";

import type * as DynamoDB from "distilled-aws/dynamodb";
import type { TimeToLiveSpecification } from "distilled-aws/dynamodb";
import * as dynamodb from "distilled-aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

import { App } from "../../App.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasTags } from "../../Tags.ts";
import type { type } from "../../Util/index.ts";
import type { AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";
import { isScalarAttributeType, toAttributeType } from "./AttributeValue.ts";

export type TableRecord<Data> = Omit<lambda.DynamoDBRecord, "dynamodb"> & {
  dynamodb: Omit<lambda.StreamRecord, "NewImage" | "OldImage"> & {
    NewImage?: Data;
    OldImage?: Data;
  };
};

export type TableEvent<Data> = Omit<lambda.DynamoDBStreamEvent, "Records"> & {
  Records: TableRecord<Data>[];
};

export interface TableProps<
  Items extends any = any,
  Attributes extends AttributesSchema<Items, PartitionKey, SortKey> =
    AttributesSchema<Items, keyof Items, keyof Items | undefined>,
  PartitionKey extends keyof Items = keyof Items,
  SortKey extends keyof Items | undefined = keyof Items | undefined,
> {
  items: type<Items>;
  attributes: Attributes;
  partitionKey: PartitionKey;
  sortKey?: SortKey;
  tableName?: string | undefined;
  billingMode?: DynamoDB.BillingMode;
  deletionProtectionEnabled?: boolean;
  onDemandThroughput?: DynamoDB.OnDemandThroughput;
  provisionedThroughput?: DynamoDB.ProvisionedThroughput;
  sseSpecification?: DynamoDB.SSESpecification;
  timeToLiveSpecification?: DynamoDB.TimeToLiveSpecification;
  warmThroughput?: DynamoDB.WarmThroughput;
  tableClass?: DynamoDB.TableClass;
}

export interface TableAttrs<Props extends Input.Resolve<TableProps>> {
  tableName: Props["tableName"] extends string ? Props["tableName"] : string;
  tableId: string;
  tableArn: `arn:aws:dynamodb:${RegionID}:${AccountID}:table/${this["tableName"]}`;
  partitionKey: Props["partitionKey"];
  sortKey: Props["sortKey"];
  // etc...
}

export type AttributesSchema<
  Items,
  PartitionKey extends keyof Items,
  SortKey extends keyof Items | undefined,
> = {
  [k in PartitionKey | (SortKey extends undefined ? never : SortKey)]: S.Schema<
    ToAttribute<Items[k]>
  >;
};

export type ToAttribute<S> = S extends string
  ? string
  : S extends number
    ? number
    : S extends Uint8Array | Buffer | File | Blob
      ? Uint8Array
      : S;

export interface Table<
  ID extends string = string,
  Props extends TableProps<any, any, any, any> = TableProps<any, any, any, any>,
> extends Resource<
  Table,
  "AWS.DynamoDB.Table",
  ID,
  Props,
  TableAttrs<Input.Resolve<Props>>
> {}

export const Table = Resource<{
  <
    const ID extends string,
    const Items,
    const Attributes extends NoInfer<
      AttributesSchema<Items, PartitionKey, SortKey>
    >,
    const PartitionKey extends keyof Items,
    const SortKey extends keyof Items | undefined = undefined,
  >(
    id: ID,
    props: TableProps<Items, Attributes, PartitionKey, SortKey>,
  ): Effect.Effect<
    Table<ID, TableProps<Items, Attributes, PartitionKey, SortKey>>
  >;
}>("AWS.DynamoDB.Table");

export interface AnyTable extends Table<string, TableProps> {}

export declare namespace Table {
  export type PartitionKey<T extends Table> = T["props"]["partitionKey"];
  export type SortKey<T extends Table> = T["props"]["sortKey"];
  export type Items<T extends Table> = T["props"]["items"];
  export type Key<T extends Table> = {
    [K in PartitionKey<T>]: InstanceType<T["props"]["items"]>[K];
  } & {
    [K in Exclude<SortKey<T>, undefined>]: Exclude<
      InstanceType<T["props"]["items"]>[K],
      undefined
    >;
  };
}

// we add an explict type to simplify the Layer type errors because the Table interface has a lot of type args
export const TableProvider = () =>
  Table.provider.effect(
    Effect.gen(function* () {
      const app = yield* App;

      const createTableName = (
        id: string,
        props: Input.ResolveProps<TableProps>,
      ) =>
        Effect.gen(function* () {
          return (
            props.tableName ??
            (yield* createPhysicalName({
              id,
              // see: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TableDescription.html#DDB-Type-TableDescription-TableName
              maxLength: 255,
            }))
          );
        });

      const toKeySchema = (props: Input.ResolveProps<TableProps>) => [
        {
          AttributeName: props.partitionKey as string,
          KeyType: "HASH" as const,
        },
        ...(props.sortKey
          ? [
              {
                AttributeName: props.sortKey as string,
                KeyType: "RANGE" as const,
              },
            ]
          : []),
      ];

      const toAttributeDefinitions = (
        attributes: AttributesSchema<any, any, any>,
      ) =>
        Object.entries(attributes)
          .flatMap(([name, schema]) => {
            const type = toAttributeType(schema);
            if (isScalarAttributeType(type)) {
              // only scalars can be included in the attribute definitions
              return [
                {
                  AttributeName: name,
                  AttributeType: type,
                } as const,
              ];
            } else {
              return [];
            }
          })
          .sort((a, b) => a.AttributeName.localeCompare(b.AttributeName));

      const toAttributeDefinitionsMap = (
        attributes: AttributesSchema<any, any, any>,
      ) =>
        Object.fromEntries(
          toAttributeDefinitions(attributes).map(
            (def) => [def.AttributeName, def.AttributeType] as const,
          ),
        );

      const resolveTableIfOwned = (id: string, tableName: string) =>
        // if it already exists, let's see if it contains tags indicating we (this app+stage) owns it
        // that would indicate we are in a partial state and can safely take control
        dynamodb.describeTable({ TableName: tableName }).pipe(
          Effect.flatMap((r) =>
            dynamodb
              .listTagsOfResource({
                // oxlint-disable-next-line no-non-null-asserted-optional-chain
                ResourceArn: r.Table?.TableArn!,
              })
              .pipe(
                Effect.map((tags) => [r, tags.Tags] as const),
                Effect.flatMap(
                  Effect.fn(function* ([r, tags]) {
                    if (hasTags(yield* createInternalTags(id), tags)) {
                      return r.Table!;
                    }
                    return yield* Effect.fail(
                      new Error("Table tags do not match expected values"),
                    );
                  }),
                ),
              ),
          ),
        );

      const updateTimeToLive = (
        tableName: string,
        timeToLiveSpecification: TimeToLiveSpecification,
      ) =>
        dynamodb
          .updateTimeToLive({
            TableName: tableName,
            TimeToLiveSpecification: timeToLiveSpecification!,
          })
          .pipe(
            Effect.retry({
              while: (e) => e.name === "ResourceInUseException",
              schedule: Schedule.exponential(100),
            }),
          );

      return {
        stables: ["tableName", "tableId", "tableArn"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (
            // TODO(sam): if the name is hard-coded, REPLACE is impossible - we need a suffix
            news.tableName !== olds.tableName ||
            olds.partitionKey !== news.partitionKey ||
            olds.sortKey !== news.sortKey
          ) {
            return { action: "replace" } as const;
          }
          const oldAttrs = toAttributeDefinitionsMap(olds.attributes);
          const newAttrs = toAttributeDefinitionsMap(news.attributes);
          for (const [name, type] of Object.entries(oldAttrs)) {
            // CloudFormation requires that editing an existing AttributeDefinition is a replace
            if (newAttrs[name] !== type) {
              return { action: "replace" } as const;
            }
          }
          // TODO(sam):
          // Replacements:
          // 1. if you change ImportSourceSpecification
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          const tableName = yield* createTableName(id, news);

          const response = yield* dynamodb
            .createTable({
              TableName: tableName,
              TableClass: news.tableClass,
              KeySchema: toKeySchema(news),
              AttributeDefinitions: toAttributeDefinitions(news.attributes),
              BillingMode: news.billingMode ?? "PAY_PER_REQUEST",
              SSESpecification: news.sseSpecification,
              WarmThroughput: news.warmThroughput,
              DeletionProtectionEnabled: news.deletionProtectionEnabled,
              OnDemandThroughput: news.onDemandThroughput,
              ProvisionedThroughput: news.provisionedThroughput,
              // ResourcePolicy: (this should be determined by bindings maybe?)

              // TODO(sam): this should come from Lambda.consume ?
              // TODO(sam): that would require Lambda.consume mutates the Table declaration?
              // StreamSpecification: news.streamSpecification,
              Tags: [
                { Key: "alchemy::app", Value: app.name },
                { Key: "alchemy::stage", Value: app.stage },
                { Key: "alchemy::id", Value: id },
              ],
            })
            .pipe(
              Effect.map((r) => r.TableDescription!),
              Effect.retry({
                while: (e) =>
                  e.name === "LimitExceededException" ||
                  e.name === "InternalServerError",
                schedule: Schedule.exponential(100),
              }),
              Effect.catchTag("ResourceInUseException", () =>
                resolveTableIfOwned(id, tableName),
              ),
            );

          if (news.timeToLiveSpecification) {
            yield* updateTimeToLive(tableName, news.timeToLiveSpecification);
          }

          yield* session.note(response.TableArn!);

          return {
            tableName,
            tableId: response.TableId!,
            tableArn: response.TableArn! as TableAttrs<
              Input.Resolve<TableProps>
            >["tableArn"],
            partitionKey: news.partitionKey,
            sortKey: news.sortKey,
          } satisfies TableAttrs<Input.Resolve<TableProps>> as TableAttrs<any>;
        }),

        update: Effect.fn(function* ({ output, news, olds }) {
          yield* dynamodb.updateTable({
            TableName: output.tableName,
            TableClass: news.tableClass,
            AttributeDefinitions: toAttributeDefinitions(news.attributes),
            BillingMode: news.billingMode ?? "PAY_PER_REQUEST",
            SSESpecification: news.sseSpecification,
            WarmThroughput: news.warmThroughput,
            DeletionProtectionEnabled: news.deletionProtectionEnabled,
            OnDemandThroughput: news.onDemandThroughput,
            ProvisionedThroughput: news.provisionedThroughput,

            //
            // StreamSpecification: news.streamSpecification,
            // TimeToLiveSpecification: news.timeToLiveSpecification,

            // TODO(sam): GSIs
            // GlobalSecondaryIndexUpdates

            // TODO(sam): Global Tables
            // MultiRegionConsistency: news.multiRegionConsistency,
            // ReplicaUpdates: [{}]
            // GlobalTableWitnessUpdates: [{Create}]
          });

          if (
            news.timeToLiveSpecification &&
            (news.timeToLiveSpecification.AttributeName !==
              olds.timeToLiveSpecification?.AttributeName ||
              news.timeToLiveSpecification?.Enabled !==
                olds.timeToLiveSpecification?.Enabled)
          ) {
            // TODO(sam): can this run in parallel?
            yield* updateTimeToLive(
              output.tableName,
              news.timeToLiveSpecification,
            );
          }

          return output;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* dynamodb
            .deleteTable({
              TableName: output.tableName,
            })
            .pipe(
              Effect.timeout(1000),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) =>
                  e._tag === "ResourceInUseException" ||
                  e._tag === "InternalServerError" ||
                  e._tag === "TimeoutError",
                schedule: Schedule.exponential(100),
              }),
            );

          while (true) {
            const table = yield* dynamodb
              .describeTable({
                TableName: output.tableName,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );

            if (table === undefined) {
              break;
            }
          }
        }),
      };
    }),
  );
