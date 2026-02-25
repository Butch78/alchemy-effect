import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as ESBuild from "../Bundle/ESBuild.ts";
import * as Account from "./Account.ts";
import * as Assets from "./Assets.ts";
import * as Credentials from "./Credentials.ts";
import * as DynamoDB from "./DynamoDB/index.ts";
import * as EC2 from "./EC2/index.ts";
import * as Endpoint from "./Endpoint.ts";
import * as Kinesis from "./Kinesis/index.ts";
import * as Lambda from "./Lambda/index.ts";
import * as Region from "./Region.ts";
import * as S3 from "./S3/index.ts";
import * as SQS from "./SQS/index.ts";

/**
 * AWS providers with optional Assets layer for S3-based code deployment.
 * If the assets bucket exists (created via `alchemy-effect bootstrap`),
 * Lambda functions will use S3 for code deployment instead of inline ZipFile.
 */
export const providers = () =>
  pipe(
    resources(),
    Layer.provideMerge(bindings()),
    Layer.provideMerge(utils()),
    Layer.provideMerge(Assets.AssetsProvider()),
    Layer.provideMerge(Account.fromStageConfig()),
    Layer.provideMerge(Region.fromStageConfig()),
    Layer.provideMerge(Credentials.fromStageConfig()),
    Layer.provideMerge(Endpoint.fromStageConfig()),
    Layer.orDie,
  );

export const credentials = () =>
  pipe(
    Account.fromStageConfig(),
    Layer.provideMerge(Region.fromStageConfig()),
    Layer.provideMerge(Credentials.fromStageConfig()),
    Layer.provideMerge(Endpoint.fromStageConfig()),
  );

export const resources = () =>
  Layer.mergeAll(
    DynamoDB.TableProvider(),
    EC2.EgressOnlyInternetGatewayProvider(),
    EC2.EIPProvider(),
    EC2.InternetGatewayProvider(),
    EC2.NatGatewayProvider(),
    EC2.NetworkAclAssociationProvider(),
    EC2.NetworkAclEntryProvider(),
    EC2.NetworkAclProvider(),
    EC2.RouteProvider(),
    EC2.RouteTableAssociationProvider(),
    EC2.RouteTableProvider(),
    EC2.SecurityGroupProvider(),
    EC2.SecurityGroupRuleProvider(),
    EC2.SubnetProvider(),
    EC2.VpcEndpointProvider(),
    EC2.VpcProvider(),
    Kinesis.StreamProvider(),
    Lambda.FunctionProvider(),
    S3.BucketProvider(),
    SQS.QueueProvider(),
  );

export const bindings = () =>
  Layer.mergeAll(
    DynamoDB.GetItemBinding.layer(),
    Kinesis.PutRecordBinding.layer(),
    Kinesis.PutRecordsBinding.layer(),
    S3.AbortMultipartUploadBinding.layer(),
    S3.AbortMultipartUploadBinding.layer(),
    S3.BucketEventSourceBinding.layer(),
    S3.CompleteMultipartUploadBinding.layer(),
    S3.CopyObjectBinding.layer(),
    S3.CreateMultipartUploadBinding.layer(),
    S3.DeleteObjectBinding.layer(),
    S3.GetObjectBinding.layer(),
    S3.HeadObjectBinding.layer(),
    S3.ListObjectsV2Binding.layer(),
    S3.PutObjectBinding.layer(),
    S3.UploadPartBinding.layer(),
    SQS.SendMessageBatchBinding.layer(),
    SQS.SendMessageBinding.layer(),
    SQS.DeleteMessageBatchBinding.layer(),
    SQS.QueueEventSourceBinding.layer(),
  );

const utils = () => Layer.mergeAll(ESBuild.esBuild());
