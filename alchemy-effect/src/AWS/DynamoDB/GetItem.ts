import type { ConsumedCapacity } from "distilled-aws/dynamodb";
import * as DynamoDB from "distilled-aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
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

export const GetItem = Effect.fn(function* <T extends Table>(table: T) {
  yield* bindGetItem(table);
  const TableName = yield* table.tableName;
  return yield* AWS.withContext(
    Effect.fn(function* (request: GetItemRequest<T>) {
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
    }),
  );
});

export const bindGetItem = Binding.fn<GetItemBinding>("AWS.DynamoDB.GetItem");

export class GetItemBinding extends Binding.Service(
  "AWS.DynamoDB.GetItem",
  Effect.fn(function* <T extends Table>(table: T) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
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
        `GetItemBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
