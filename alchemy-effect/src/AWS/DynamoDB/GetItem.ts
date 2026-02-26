import type { ConsumedCapacity } from "distilled-aws/dynamodb";
import * as DynamoDB from "distilled-aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import { fromAttributeValue } from "./AttributeValue.ts";
import type { Table } from "./Table.ts";

export interface GetItemRequest<T extends Table> extends Omit<
  DynamoDB.GetItemInput,
  "TableName" | "Key"
> {
  Key: Table.Key<T>;
}

export interface GetItemResult<T extends Table, Key extends Table.Key<T>> {
  Item: (InstanceType<T["props"]["items"]> & Key) | undefined;
  ConsumedCapacity?: ConsumedCapacity;
}

export class GetItem extends Binding.Service<
  GetItem,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: GetItemRequest<T>,
    ) => Effect.Effect<GetItemResult<T, Table.Key<T>>, any, any>
  >
>()("AWS.DynamoDB.GetItem") {}

export const GetItemLive = Layer.effect(
  GetItem,
  // @ts-expect-error
  Effect.gen(function* () {
    const Policy = yield* GetItemPolicy;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* Policy(table);
      return Effect.fn(function* (request: GetItemRequest<T>) {
        const tableName = yield* TableName;
        const { Item, ...rest } = yield* DynamoDB.getItem({
          ...request,
          TableName: tableName,
          Key: {
            [table.props.partitionKey]: {
              S: (request.Key as any)[table.props.partitionKey] as string,
            },
            ...(table.props.sortKey
              ? {
                  [table.props.sortKey]: {
                    S: (request.Key as any)[table.props.sortKey] as string,
                  },
                }
              : {}),
          },
        });

        return {
          ...rest,
          Item: Item
            ? (Object.fromEntries(
                yield* Effect.promise(() =>
                  Promise.all(
                    Object.entries(Item!).map(async ([key, value]) => [
                      key,
                      await fromAttributeValue(value!),
                    ]),
                  ),
                ),
              ) as any)
            : undefined,
        };
      });
    });
  }),
);

export class GetItemPolicy extends Binding.Policy<
  GetItemPolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.GetItem") {}

export const GetItemPolicyLive = Layer.effect(
  GetItemPolicy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* <T extends Table>(table: T) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "GetItem",
              Effect: "Allow",
              Action: ["dynamodb:GetItem"],
              Resource: [Output.interpolate`${table.tableArn}`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `GetItemPolicy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
