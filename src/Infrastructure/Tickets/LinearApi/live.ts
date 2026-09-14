import { LinearClient } from '@linear/sdk';
import { Clock, Config, ConfigProvider, Data, Duration, Effect, Layer, Schema } from 'effect';

import {
  LinearApi,
  type LinearIssue,
  LinearIssueNotFound,
  LinearLabel,
  type LinearMetadata,
  LinearProject,
  type LinearRelationInput,
  LinearRelationType,
  LinearRequestError,
  LinearViewer,
  LinearWorkflowState,
} from '~/Core/Tickets/Ports/LinearApi';

const PAGE_SIZE = 50;
const RATE_LIMIT_RETRIES = 5;

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

const Connection = <S extends Schema.Top>(node: S) =>
  Schema.Struct({
    nodes: Schema.Array(node),
    pageInfo: PageInfo,
  });

const RelatedIssueNode = Schema.Struct({
  id: Schema.NonEmptyString,
});

const OutgoingRelationNode = Schema.Struct({
  id: Schema.NonEmptyString,
  type: LinearRelationType,
  relatedIssue: RelatedIssueNode,
});

const IncomingRelationNode = Schema.Struct({
  id: Schema.NonEmptyString,
  type: LinearRelationType,
  issue: RelatedIssueNode,
});

const GraphQLIssue = Schema.Struct({
  id: Schema.NonEmptyString,
  identifier: Schema.NonEmptyString,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  createdAt: Schema.NonEmptyString,
  assignee: Schema.NullOr(Schema.Struct({ id: Schema.NonEmptyString })),
  state: LinearWorkflowState,
  project: Schema.NullOr(LinearProject),
  labels: Connection(LinearLabel),
  relations: Connection(OutgoingRelationNode),
  inverseRelations: Connection(IncomingRelationNode),
});

const ViewerQuery = Schema.Struct({
  viewer: LinearViewer,
});

const TeamStatesQuery = Schema.Struct({
  team: Schema.NullOr(
    Schema.Struct({
      states: Connection(LinearWorkflowState),
    })
  ),
});

const LabelsQuery = Schema.Struct({
  issueLabels: Connection(LinearLabel),
});

const ProjectsQuery = Schema.Struct({
  projects: Connection(LinearProject),
});

const IssuesQuery = Schema.Struct({
  issues: Connection(GraphQLIssue),
});

const IssueQuery = Schema.Struct({
  issue: Schema.NullOr(GraphQLIssue),
});

const IssueLabelsQuery = Schema.Struct({
  issue: Schema.NullOr(Schema.Struct({ labels: Connection(LinearLabel) })),
});

const IssueRelationsQuery = Schema.Struct({
  issue: Schema.NullOr(Schema.Struct({ relations: Connection(OutgoingRelationNode) })),
});

const IssueInverseRelationsQuery = Schema.Struct({
  issue: Schema.NullOr(Schema.Struct({ inverseRelations: Connection(IncomingRelationNode) })),
});

const MutationPayload = Schema.Struct({
  success: Schema.Boolean,
});

const IssueUpdateQuery = Schema.Struct({
  issueUpdate: MutationPayload,
});

const RelationCreateQuery = Schema.Struct({
  issueRelationCreate: MutationPayload,
});

const RelationDeleteQuery = Schema.Struct({
  issueRelationDelete: MutationPayload,
});

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  createdAt
  assignee { id }
  state { id name type }
  project { id name slugId }
  labels(first: ${PAGE_SIZE}) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
  relations(first: ${PAGE_SIZE}) {
    nodes { id type relatedIssue { id } }
    pageInfo { hasNextPage endCursor }
  }
  inverseRelations(first: ${PAGE_SIZE}) {
    nodes { id type issue { id } }
    pageInfo { hasNextPage endCursor }
  }
`;

const VIEWER_QUERY = `
  query Viewer {
    viewer { id name }
  }
`;

const TEAM_STATES_QUERY = `
  query TeamStates($teamId: String!, $after: String) {
    team(id: $teamId) {
      states(first: ${PAGE_SIZE}, after: $after) {
        nodes { id name type }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const LABELS_QUERY = `
  query Labels($after: String) {
    issueLabels(first: ${PAGE_SIZE}, after: $after) {
      nodes { id name }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PROJECTS_QUERY = `
  query Projects($after: String) {
    projects(first: ${PAGE_SIZE}, after: $after) {
      nodes { id name slugId }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES_QUERY = `
  query Issues($filter: IssueFilter!, $after: String) {
    issues(first: ${PAGE_SIZE}, after: $after, filter: $filter, orderBy: createdAt) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUE_QUERY = `
  query Issue($id: String!) {
    issue(id: $id) { ${ISSUE_FIELDS} }
  }
`;

const ISSUE_LABELS_QUERY = `
  query IssueLabels($id: String!, $after: String) {
    issue(id: $id) {
      labels(first: ${PAGE_SIZE}, after: $after) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ISSUE_RELATIONS_QUERY = `
  query IssueRelations($id: String!, $after: String) {
    issue(id: $id) {
      relations(first: ${PAGE_SIZE}, after: $after) {
        nodes { id type relatedIssue { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ISSUE_INVERSE_RELATIONS_QUERY = `
  query IssueInverseRelations($id: String!, $after: String) {
    issue(id: $id) {
      inverseRelations(first: ${PAGE_SIZE}, after: $after) {
        nodes { id type issue { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const SET_STATE_MUTATION = `
  mutation SetState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }
`;

const SET_ASSIGNEE_MUTATION = `
  mutation SetAssignee($id: String!, $assigneeId: String) {
    issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
  }
`;

const SET_LABELS_MUTATION = `
  mutation SetLabels($id: String!, $addedLabelIds: [String!]!, $removedLabelIds: [String!]!) {
    issueUpdate(id: $id, input: { addedLabelIds: $addedLabelIds, removedLabelIds: $removedLabelIds }) { success }
  }
`;

const CREATE_RELATION_MUTATION = `
  mutation CreateRelation($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) { success }
  }
`;

const DELETE_RELATION_MUTATION = `
  mutation DeleteRelation($id: String!) {
    issueRelationDelete(id: $id) { success }
  }
`;

class RateLimited extends Data.TaggedError('RateLimited')<{
  readonly resetAt: number | undefined;
}> {}

type ConnectionPage<A> = {
  readonly nodes: readonly A[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
};

const headerOf = (headers: Headers | undefined, name: string): string | undefined => {
  const value = headers?.get(name);
  return value === null || value === undefined || value === '' ? undefined : value;
};

const numberHeader = (headers: Headers | undefined, name: string): number | undefined => {
  const value = headerOf(headers, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const headersOf = (error: unknown): Headers | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as { headers?: Headers; response?: { headers?: Headers } };
  return record.response?.headers ?? record.headers;
};

const statusOf = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as { status?: number; response?: { status?: number } };
  return record.response?.status ?? record.status;
};

const graphqlErrorsOf = (error: unknown): readonly { extensions?: { code?: string } }[] => {
  if (typeof error !== 'object' || error === null) {
    return [];
  }
  const record = error as {
    errors?: readonly { extensions?: { code?: string } }[];
    response?: { errors?: readonly { extensions?: { code?: string } }[] };
  };
  return record.response?.errors ?? record.errors ?? [];
};

const isRateLimited = (error: unknown): boolean => {
  if (statusOf(error) === 429) {
    return true;
  }
  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'Ratelimited') {
    return true;
  }
  return graphqlErrorsOf(error).some((item) => item.extensions?.code === 'RATELIMITED');
};

const resetAtOf = (headers: Headers | undefined): number | undefined => {
  const requests = numberHeader(headers, 'x-ratelimit-requests-reset');
  const complexity = numberHeader(headers, 'x-ratelimit-complexity-reset');
  if (requests === undefined) {
    return complexity;
  }
  if (complexity === undefined) {
    return requests;
  }
  return Math.max(requests, complexity);
};

const emptyPage = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

const toIssue = (issue: typeof GraphQLIssue.Type): LinearIssue => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  description: issue.description,
  createdAt: issue.createdAt,
  assigneeId: issue.assignee?.id ?? null,
  state: issue.state,
  project: issue.project,
  labels: issue.labels.nodes,
  relations: issue.relations.nodes.map((relation) => ({
    relationId: relation.id,
    issueId: relation.relatedIssue.id,
    type: relation.type,
  })),
  inverseRelations: issue.inverseRelations.nodes.map((relation) => ({
    relationId: relation.id,
    issueId: relation.issue.id,
    type: relation.type,
  })),
});

export const LinearApiLive = Layer.effect(
  LinearApi,
  Effect.gen(function* () {
    const apiKeyEnv = yield* Config.nonEmptyString('apiKeyEnv').pipe(Config.withDefault('LINEAR_API_KEY'));
    const apiKey = yield* Config.nonEmptyString(apiKeyEnv).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv())
    );
    const client = new LinearClient({ apiKey });
    client.client.setHeader('Authorization', apiKey);

    const metadataCache = new Map<string, LinearMetadata>();
    const rateLimit = {
      remaining: Number.POSITIVE_INFINITY,
      resetAt: 0,
    };

    const recordHeaders = (headers: Headers | undefined) => {
      const remaining = numberHeader(headers, 'x-ratelimit-requests-remaining');
      const complexity = numberHeader(headers, 'x-ratelimit-complexity-remaining');
      if (remaining !== undefined && complexity !== undefined) {
        rateLimit.remaining = Math.min(remaining, complexity);
      } else if (remaining !== undefined) {
        rateLimit.remaining = remaining;
      } else if (complexity !== undefined) {
        rateLimit.remaining = complexity;
      }
      const resetAt = resetAtOf(headers);
      if (resetAt !== undefined) {
        rateLimit.resetAt = resetAt;
      }
    };

    const waitUntil = (resetAt: number | undefined) =>
      Effect.gen(function* () {
        const target = resetAt ?? rateLimit.resetAt;
        const now = yield* Clock.currentTimeMillis;
        const wait = target > now ? target - now : 1000;
        yield* Effect.sleep(Duration.millis(wait));
      });

    const waitIfExhausted = Effect.gen(function* () {
      if (rateLimit.remaining > 0) {
        return;
      }
      yield* waitUntil(rateLimit.resetAt);
    });

    const rawRequest = <A>(
      query: string,
      variables: Record<string, unknown> | undefined,
      schema: Schema.Codec<A, unknown>
    ): Effect.Effect<A, LinearRequestError> =>
      Effect.gen(function* () {
        yield* waitIfExhausted;
        const response = yield* Effect.tryPromise({
          try: () => client.client.rawRequest<unknown, Record<string, unknown>>(query, variables),
          catch: (error) => {
            recordHeaders(headersOf(error));
            return isRateLimited(error)
              ? new RateLimited({ resetAt: resetAtOf(headersOf(error)) })
              : new LinearRequestError();
          },
        });
        recordHeaders(response.headers);
        if (response.status === 429) {
          return yield* new RateLimited({ resetAt: resetAtOf(response.headers) });
        }
        return yield* Schema.decodeUnknownEffect(schema)(response.data).pipe(
          Effect.mapError(() => new LinearRequestError())
        );
      }).pipe(
        Effect.catchTag('RateLimited', (error) => waitUntil(error.resetAt).pipe(Effect.andThen(Effect.fail(error)))),
        Effect.retry({
          times: RATE_LIMIT_RETRIES,
          while: (error) => error._tag === 'RateLimited',
        }),
        Effect.mapError((error) => (error._tag === 'RateLimited' ? new LinearRequestError() : error))
      );

    const paginate = <A>(
      fetchPage: (after: string | undefined) => Effect.Effect<ConnectionPage<A>, LinearRequestError>
    ): Effect.Effect<A[], LinearRequestError> =>
      Effect.gen(function* () {
        const collected: A[] = [];
        let after: string | undefined;
        while (true) {
          const page = yield* fetchPage(after);
          collected.push(...page.nodes);
          if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) {
            return collected;
          }
          after = page.pageInfo.endCursor;
        }
      });

    const continueConnection = <A>(
      first: ConnectionPage<A>,
      fetchPage: (after: string) => Effect.Effect<ConnectionPage<A>, LinearRequestError>
    ): Effect.Effect<A[], LinearRequestError> =>
      Effect.gen(function* () {
        const collected = [...first.nodes];
        let cursor = first.pageInfo.hasNextPage ? first.pageInfo.endCursor : null;
        while (cursor !== null) {
          const page = yield* fetchPage(cursor);
          collected.push(...page.nodes);
          cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        }
        return collected;
      });

    const completeIssue = (issue: typeof GraphQLIssue.Type): Effect.Effect<LinearIssue, LinearRequestError> =>
      Effect.gen(function* () {
        const labels = yield* continueConnection(issue.labels, (after) =>
          rawRequest(ISSUE_LABELS_QUERY, { id: issue.id, after }, IssueLabelsQuery).pipe(
            Effect.map((data) => data.issue?.labels ?? emptyPage)
          )
        );
        const outgoing = yield* continueConnection(issue.relations, (after) =>
          rawRequest(ISSUE_RELATIONS_QUERY, { id: issue.id, after }, IssueRelationsQuery).pipe(
            Effect.map((data) => data.issue?.relations ?? emptyPage)
          )
        );
        const incoming = yield* continueConnection(issue.inverseRelations, (after) =>
          rawRequest(ISSUE_INVERSE_RELATIONS_QUERY, { id: issue.id, after }, IssueInverseRelationsQuery).pipe(
            Effect.map((data) => data.issue?.inverseRelations ?? emptyPage)
          )
        );
        return toIssue({
          ...issue,
          labels: { nodes: labels, pageInfo: emptyPage.pageInfo },
          relations: { nodes: outgoing, pageInfo: emptyPage.pageInfo },
          inverseRelations: { nodes: incoming, pageInfo: emptyPage.pageInfo },
        });
      });

    const loadMetadata = (teamId: string): Effect.Effect<LinearMetadata, LinearRequestError> =>
      Effect.gen(function* () {
        const viewer = yield* rawRequest(VIEWER_QUERY, undefined, ViewerQuery);
        const states = yield* paginate((after) =>
          rawRequest(TEAM_STATES_QUERY, { teamId, after }, TeamStatesQuery).pipe(
            Effect.flatMap((data) =>
              data.team === null ? Effect.fail(new LinearRequestError()) : Effect.succeed(data.team.states)
            )
          )
        );
        const labels = yield* paginate((after) =>
          rawRequest(LABELS_QUERY, { after }, LabelsQuery).pipe(Effect.map((data) => data.issueLabels))
        );
        const projects = yield* paginate((after) =>
          rawRequest(PROJECTS_QUERY, { after }, ProjectsQuery).pipe(Effect.map((data) => data.projects))
        );
        return {
          viewer: viewer.viewer,
          states,
          labels,
          projects,
        };
      });

    const requireSuccess = (success: boolean): Effect.Effect<void, LinearRequestError> =>
      success ? Effect.void : Effect.fail(new LinearRequestError());

    return {
      metadata: (teamId) =>
        Effect.gen(function* () {
          const cached = metadataCache.get(teamId);
          if (cached !== undefined) {
            return cached;
          }
          const metadata = yield* loadMetadata(teamId);
          metadataCache.set(teamId, metadata);
          return metadata;
        }),
      issues: (teamId) =>
        paginate((after) =>
          rawRequest(
            ISSUES_QUERY,
            { filter: { team: { id: { eq: teamId } } }, after },
            IssuesQuery
          ).pipe(Effect.map((data) => data.issues))
        ).pipe(Effect.flatMap((nodes) => Effect.forEach(nodes, completeIssue, { concurrency: 1 }))),
      issue: (id) =>
        Effect.gen(function* () {
          const data = yield* rawRequest(ISSUE_QUERY, { id }, IssueQuery);
          if (data.issue === null) {
            return yield* new LinearIssueNotFound();
          }
          return yield* completeIssue(data.issue);
        }),
      setState: (issueId, stateId) =>
        rawRequest(SET_STATE_MUTATION, { id: issueId, stateId }, IssueUpdateQuery).pipe(
          Effect.flatMap((data) => requireSuccess(data.issueUpdate.success))
        ),
      setAssignee: (issueId, assigneeId) =>
        rawRequest(SET_ASSIGNEE_MUTATION, { id: issueId, assigneeId }, IssueUpdateQuery).pipe(
          Effect.flatMap((data) => requireSuccess(data.issueUpdate.success))
        ),
      setLabels: (issueId, addedLabelIds, removedLabelIds) =>
        rawRequest(
          SET_LABELS_MUTATION,
          { id: issueId, addedLabelIds: [...addedLabelIds], removedLabelIds: [...removedLabelIds] },
          IssueUpdateQuery
        ).pipe(Effect.flatMap((data) => requireSuccess(data.issueUpdate.success))),
      createRelation: (input: LinearRelationInput) =>
        rawRequest(
          CREATE_RELATION_MUTATION,
          {
            input: {
              issueId: input.issueId,
              relatedIssueId: input.relatedIssueId,
              type: input.type,
            },
          },
          RelationCreateQuery
        ).pipe(Effect.flatMap((data) => requireSuccess(data.issueRelationCreate.success))),
      deleteRelation: (relationId) =>
        rawRequest(DELETE_RELATION_MUTATION, { id: relationId }, RelationDeleteQuery).pipe(
          Effect.flatMap((data) => requireSuccess(data.issueRelationDelete.success))
        ),
    };
  })
);
