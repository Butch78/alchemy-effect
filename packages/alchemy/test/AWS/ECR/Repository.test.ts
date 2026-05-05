import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Repository } from "@/AWS/ECR";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as ECR from "@distilled.cloud/aws/ecr";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("create and delete repository with default props", (stack) =>
  Effect.gen(function* () {
    const repo = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Repository("DefaultRepo");
      }),
    );

    expect(repo.repositoryName).toBeDefined();
    expect(repo.repositoryArn).toBeDefined();
    expect(repo.repositoryUri).toBeDefined();

    const described = yield* ECR.describeRepositories({
      repositoryNames: [repo.repositoryName],
    });
    expect(described.repositories?.[0]?.repositoryArn).toEqual(
      repo.repositoryArn,
    );

    yield* stack.destroy();
    yield* assertRepositoryDeleted(repo.repositoryName);
  }),
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("IdempotentRepo", {
            scanOnPush: true,
            tags: { Environment: "test" },
          });
        }),
      );

      // Deploy again with identical props — reconcile must converge
      // without changing the repository.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("IdempotentRepo", {
            scanOnPush: true,
            tags: { Environment: "test" },
          });
        }),
      );

      expect(second.repositoryName).toEqual(initial.repositoryName);
      expect(second.repositoryArn).toEqual(initial.repositoryArn);
      expect(second.scanOnPush).toEqual(true);

      const tags = yield* ECR.listTagsForResource({
        resourceArn: second.repositoryArn,
      });
      const tagMap = Object.fromEntries(
        (tags.tags ?? []).map((t) => [t.Key!, t.Value!]),
      );
      expect(tagMap["Environment"]).toEqual("test");

      yield* stack.destroy();
      yield* assertRepositoryDeleted(initial.repositoryName);
    }),
);

test.provider(
  "reconcile resets imageScanningConfiguration mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("DriftScanRepo", {
            scanOnPush: true,
          });
        }),
      );

      // Mutate scanOnPush out-of-band via the raw SDK.
      yield* ECR.putImageScanningConfiguration({
        repositoryName: repo.repositoryName,
        imageScanningConfiguration: { scanOnPush: false },
      });
      const drifted = yield* ECR.describeRepositories({
        repositoryNames: [repo.repositoryName],
      });
      expect(
        drifted.repositories?.[0]?.imageScanningConfiguration?.scanOnPush,
      ).toEqual(false);

      // Re-deploy with the same desired props — reconcile should reset.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("DriftScanRepo", {
            scanOnPush: true,
          });
        }),
      );
      expect(redeployed.repositoryArn).toEqual(repo.repositoryArn);

      const reset = yield* ECR.describeRepositories({
        repositoryNames: [repo.repositoryName],
      });
      expect(
        reset.repositories?.[0]?.imageScanningConfiguration?.scanOnPush,
      ).toEqual(true);

      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
);

test.provider(
  "reconcile resets imageTagMutability mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("DriftMutabilityRepo", {
            imageTagMutability: "IMMUTABLE",
          });
        }),
      );

      // Drift to MUTABLE out-of-band.
      yield* ECR.putImageTagMutability({
        repositoryName: repo.repositoryName,
        imageTagMutability: "MUTABLE",
      });
      const drifted = yield* ECR.describeRepositories({
        repositoryNames: [repo.repositoryName],
      });
      expect(drifted.repositories?.[0]?.imageTagMutability).toEqual("MUTABLE");

      // Re-deploy — reconcile should reset to IMMUTABLE.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("DriftMutabilityRepo", {
            imageTagMutability: "IMMUTABLE",
          });
        }),
      );
      expect(redeployed.imageTagMutability).toEqual("IMMUTABLE");

      const reset = yield* ECR.describeRepositories({
        repositoryNames: [repo.repositoryName],
      });
      expect(reset.repositories?.[0]?.imageTagMutability).toEqual("IMMUTABLE");

      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
);

test.provider(
  "reconcile resets a lifecycle policy mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const desiredPolicy = JSON.stringify({
        rules: [
          {
            rulePriority: 1,
            description: "expire untagged after 7 days",
            selection: {
              tagStatus: "untagged",
              countType: "sinceImagePushed",
              countUnit: "days",
              countNumber: 7,
            },
            action: { type: "expire" },
          },
        ],
      });

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("DriftPolicyRepo", {
            lifecyclePolicyText: desiredPolicy,
          });
        }),
      );

      // Replace the policy out-of-band with something foreign.
      const foreignPolicy = JSON.stringify({
        rules: [
          {
            rulePriority: 1,
            description: "FOREIGN: keep last 3",
            selection: {
              tagStatus: "any",
              countType: "imageCountMoreThan",
              countNumber: 3,
            },
            action: { type: "expire" },
          },
        ],
      });
      yield* ECR.putLifecyclePolicy({
        repositoryName: repo.repositoryName,
        lifecyclePolicyText: foreignPolicy,
      });

      // Re-deploy — reconcile must reset the policy back to desired.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("DriftPolicyRepo", {
            lifecyclePolicyText: desiredPolicy,
          });
        }),
      );

      const observed = yield* ECR.getLifecyclePolicy({
        repositoryName: repo.repositoryName,
      });
      expect(JSON.parse(observed.lifecyclePolicyText!)).toEqual(
        JSON.parse(desiredPolicy),
      );

      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
);

test.provider(
  "removing lifecyclePolicyText deletes the lifecycle policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const policy = JSON.stringify({
        rules: [
          {
            rulePriority: 1,
            description: "expire untagged",
            selection: {
              tagStatus: "untagged",
              countType: "sinceImagePushed",
              countUnit: "days",
              countNumber: 1,
            },
            action: { type: "expire" },
          },
        ],
      });

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("PolicyRemovalRepo", {
            lifecyclePolicyText: policy,
          });
        }),
      );

      const before = yield* ECR.getLifecyclePolicy({
        repositoryName: repo.repositoryName,
      });
      expect(before.lifecyclePolicyText).toBeDefined();

      // Re-deploy without the policy — reconcile must delete it.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("PolicyRemovalRepo");
        }),
      );

      yield* ECR.getLifecyclePolicy({
        repositoryName: repo.repositoryName,
      })
        .pipe(
          Effect.flatMap(() =>
            Effect.fail(new Error("lifecycle policy still present")),
          ),
          Effect.catchTag("LifecyclePolicyNotFoundException", () => Effect.void),
        );

      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
);

test.provider(
  "reconcile resets tags mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("DriftTagsRepo", {
            tags: { Environment: "test" },
          });
        }),
      );

      // Mutate tags out-of-band via the raw SDK.
      yield* ECR.tagResource({
        resourceArn: repo.repositoryArn,
        tags: [
          { Key: "Drifted", Value: "yes" },
          { Key: "Environment", Value: "WRONG" },
        ],
      });

      // Re-deploy — reconcile should observe drifted cloud tags and reset them.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("DriftTagsRepo", {
            tags: { Environment: "test" },
          });
        }),
      );

      const tags = yield* ECR.listTagsForResource({
        resourceArn: repo.repositoryArn,
      });
      const tagMap = Object.fromEntries(
        (tags.tags ?? []).map((t) => [t.Key!, t.Value!]),
      );
      expect(tagMap["Environment"]).toEqual("test");
      expect(tagMap["Drifted"]).toBeUndefined();

      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
);

test.provider(
  "reconcile re-creates a repository that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repositoryName = `alchemy-test-ecr-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("RecreateRepo", { repositoryName });
        }),
      );

      // Delete the repository out of band.
      yield* ECR.deleteRepository({
        repositoryName: initial.repositoryName,
        force: true,
      });
      yield* assertRepositoryDeleted(repositoryName);

      // Re-deploying must converge by re-creating.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("RecreateRepo", { repositoryName });
        }),
      );

      expect(recreated.repositoryName).toEqual(repositoryName);
      const described = yield* ECR.describeRepositories({
        repositoryNames: [repositoryName],
      });
      expect(described.repositories?.[0]?.repositoryArn).toBeDefined();

      yield* stack.destroy();
      yield* assertRepositoryDeleted(recreated.repositoryName);
    }),
);

test.provider(
  "changing repositoryName triggers replace, old repository is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-ecr-replace-a-${suffix}`;
      const nameB = `alchemy-test-ecr-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("RenameRepo", { repositoryName: nameA });
        }),
      );
      expect(a.repositoryName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("RenameRepo", { repositoryName: nameB });
        }),
      );
      expect(b.repositoryName).toEqual(nameB);
      expect(b.repositoryArn).not.toEqual(a.repositoryArn);

      // The old repository must be gone after replace.
      yield* assertRepositoryDeleted(nameA);

      yield* stack.destroy();
      yield* assertRepositoryDeleted(nameB);
    }),
);

test.provider(
  "destroying a non-empty repo without forceDelete returns RepositoryNotEmptyException",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repositoryName = `alchemy-test-ecr-nonempty-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("NonEmptyRepo", {
            repositoryName,
            forceDelete: false,
          });
        }),
      );

      // Push a placeholder image manifest so the repository is non-empty.
      yield* pushPlaceholderImage(repo.repositoryName);

      // Destroy should fail with RepositoryNotEmptyException because
      // forceDelete is false. The engine surfaces it as the underlying
      // tagged error.
      const result = yield* stack.destroy().pipe(Effect.flip);
      const message =
        result instanceof Error ? result.message : JSON.stringify(result);
      expect(message).toMatch(/RepositoryNotEmptyException|not empty/i);

      // Cleanup: empty the repo, then destroy.
      yield* ECR.batchDeleteImage({
        repositoryName: repo.repositoryName,
        imageIds: [{ imageTag: "placeholder" }],
      });
      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
);

test.provider(
  "destroying a non-empty repo with forceDelete: true succeeds",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repositoryName = `alchemy-test-ecr-force-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("ForceDeleteRepo", {
            repositoryName,
            forceDelete: true,
          });
        }),
      );

      yield* pushPlaceholderImage(repo.repositoryName);

      // Destroy must succeed despite the repository containing an image.
      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
);

test.provider(
  "destroying an already-deleted repository is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("DoubleDestroyRepo");
        }),
      );

      // Delete out of band, then ask the engine to destroy.
      // Provider's `delete` must catch RepositoryNotFoundException and
      // complete cleanly.
      yield* ECR.deleteRepository({
        repositoryName: repo.repositoryName,
        force: true,
      });
      yield* assertRepositoryDeleted(repo.repositoryName);

      yield* stack.destroy();
    }),
);

test.provider(
  "owned repo (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repositoryName = `alchemy-test-ecr-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("AdoptableRepo", { repositoryName });
        }),
      );
      expect(initial.repositoryName).toEqual(repositoryName);

      // Wipe state — the repository stays in ECR.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableRepo",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("AdoptableRepo", { repositoryName });
        }),
      );

      expect(adopted.repositoryArn).toEqual(initial.repositoryArn);
      expect(adopted.repositoryUri).toEqual(initial.repositoryUri);

      yield* stack.destroy();
      yield* assertRepositoryDeleted(initial.repositoryName);
    }),
);

test.provider(
  "foreign-tagged repo requires adopt(true) to take over and is re-tagged",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repositoryName = `alchemy-test-ecr-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("Original", { repositoryName });
        }),
      );

      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Repository("Different", { repositoryName });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.repositoryName).toEqual(repositoryName);
      expect(takenOver.repositoryArn).toEqual(original.repositoryArn);

      // Adoption with adopt(true) must re-tag the repo with the alchemy
      // internal tags so the next reconcile silently adopts.
      const tags = yield* ECR.listTagsForResource({
        resourceArn: takenOver.repositoryArn,
      });
      const tagMap = Object.fromEntries(
        (tags.tags ?? []).map((t) => [t.Key!, t.Value!]),
      );
      expect(tagMap["alchemy:fqn"]).toBeDefined();
      expect(tagMap["alchemy:stage"]).toBeDefined();

      yield* stack.destroy();
      yield* assertRepositoryDeleted(takenOver.repositoryName);
    }),
);

class RepositoryStillExists extends Data.TaggedError("RepositoryStillExists") {}

const assertRepositoryDeleted = Effect.fn(function* (repositoryName: string) {
  yield* ECR.describeRepositories({ repositoryNames: [repositoryName] })
    .pipe(
      Effect.flatMap(() => Effect.fail(new RepositoryStillExists())),
      Effect.retry({
        while: (e) => e._tag === "RepositoryStillExists",
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
      }),
      Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
    );
});

/**
 * Push a tiny placeholder image manifest so the repository is non-empty.
 * Uses ECR's PutImage API with an inlined OCI image manifest. We don't push
 * the actual layer blobs — ECR allows orphan manifests, which is enough to
 * trigger RepositoryNotEmptyException on a non-force delete.
 */
const pushPlaceholderImage = Effect.fn(function* (repositoryName: string) {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: {
      mediaType: "application/vnd.docker.container.image.v1+json",
      size: 0,
      digest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    layers: [],
  });
  yield* ECR.putImage({
    repositoryName,
    imageManifest: manifest,
    imageTag: "placeholder",
  }).pipe(
    Effect.catchTag("ImageAlreadyExistsException", () => Effect.void),
  );
});
