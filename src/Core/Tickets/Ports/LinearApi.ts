import { Context, Data, type Effect, Schema } from 'effect';

export class LinearRequestError extends Data.TaggedError('LinearRequestError') {}

export class LinearIssueNotFound extends Data.TaggedError('LinearIssueNotFound') {}

export const LinearViewer = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
});

export type LinearViewer = typeof LinearViewer.Type;

export const LinearWorkflowState = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  type: Schema.String,
});

export type LinearWorkflowState = typeof LinearWorkflowState.Type;

export const LinearLabel = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
});

export type LinearLabel = typeof LinearLabel.Type;

export const LinearProject = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  slugId: Schema.NonEmptyString,
});

export type LinearProject = typeof LinearProject.Type;

export const LinearMetadata = Schema.Struct({
  viewer: LinearViewer,
  states: Schema.Array(LinearWorkflowState),
  labels: Schema.Array(LinearLabel),
  projects: Schema.Array(LinearProject),
});

export type LinearMetadata = typeof LinearMetadata.Type;

export const LinearRelationType = Schema.Literals(['blocks', 'duplicate', 'related']);

export type LinearRelationType = typeof LinearRelationType.Type;

export const LinearIssueRelation = Schema.Struct({
  relationId: Schema.NonEmptyString,
  issueId: Schema.NonEmptyString,
  type: LinearRelationType,
});

export type LinearIssueRelation = typeof LinearIssueRelation.Type;

export const LinearIssue = Schema.Struct({
  id: Schema.NonEmptyString,
  identifier: Schema.NonEmptyString,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  createdAt: Schema.NonEmptyString,
  assigneeId: Schema.NullOr(Schema.NonEmptyString),
  state: LinearWorkflowState,
  project: Schema.NullOr(LinearProject),
  labels: Schema.Array(LinearLabel),
  relations: Schema.Array(LinearIssueRelation),
  inverseRelations: Schema.Array(LinearIssueRelation),
});

export type LinearIssue = typeof LinearIssue.Type;

export interface LinearRelationInput {
  readonly issueId: string;
  readonly relatedIssueId: string;
  readonly type: LinearRelationType;
}

export class LinearApi extends Context.Service<
  LinearApi,
  {
    readonly metadata: (teamId: string) => Effect.Effect<LinearMetadata, LinearRequestError>;
    readonly issues: (teamId: string) => Effect.Effect<readonly LinearIssue[], LinearRequestError>;
    readonly issue: (id: string) => Effect.Effect<LinearIssue, LinearIssueNotFound | LinearRequestError>;
    readonly setState: (issueId: string, stateId: string) => Effect.Effect<void, LinearRequestError>;
    readonly setAssignee: (issueId: string, assigneeId: string | null) => Effect.Effect<void, LinearRequestError>;
    readonly setLabels: (
      issueId: string,
      addedLabelIds: readonly string[],
      removedLabelIds: readonly string[]
    ) => Effect.Effect<void, LinearRequestError>;
    readonly createRelation: (input: LinearRelationInput) => Effect.Effect<void, LinearRequestError>;
    readonly deleteRelation: (relationId: string) => Effect.Effect<void, LinearRequestError>;
  }
>()('LinearApi') {}
