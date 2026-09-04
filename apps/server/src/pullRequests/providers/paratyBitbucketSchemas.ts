import { Effect, Schema } from "effect";

import {
  OutboundMcpDecodeError,
  OutboundMcpInputError,
} from "../../outboundMcp/consumerBinding.ts";

export const PARATY_BITBUCKET_CONSUMER_ID = "paraty-bitbucket-pull-requests";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const Page = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }));

const Link = Schema.Struct({ href: NonEmptyString });
const Actor = Schema.Struct({
  display_name: NonEmptyString,
  nickname: Schema.NullOr(NonEmptyString),
  uuid: NonEmptyString,
  links: Schema.Struct({ avatar: Schema.NullOr(Link), html: Schema.NullOr(Link) }),
});

const PullRequest = Schema.Struct({
  id: PositiveInt,
  title: NonEmptyString,
  draft: Schema.optional(Schema.Boolean),
  description: Schema.String,
  state: Schema.Literals(["OPEN", "MERGED", "DECLINED"]),
  created_on: NonEmptyString,
  updated_on: NonEmptyString,
  closed_on: Schema.optional(Schema.NullOr(NonEmptyString)),
  merge_commit: Schema.NullOr(Schema.Unknown),
  source: Schema.Struct({ branch: Schema.Struct({ name: NonEmptyString }) }),
  destination: Schema.Struct({ branch: Schema.Struct({ name: NonEmptyString }) }),
  author: Schema.NullOr(Actor),
  reviewers: Schema.Array(Actor),
  links: Schema.Struct({ html: Link }),
});

const Comment = Schema.Struct({
  id: PositiveInt,
  content: Schema.Struct({ raw: Schema.String }),
  user: Schema.NullOr(Actor),
  created_on: NonEmptyString,
  updated_on: Schema.NullOr(NonEmptyString),
  links: Schema.Struct({ html: Link }),
});

const PageEnvelope = Schema.Struct({
  pagelen: Schema.Literal(50),
  page: Page,
  size: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  next: Schema.optional(NonEmptyString),
  values: Schema.Array(Schema.Unknown),
});

const ListSummary = Schema.Struct({
  id: PositiveInt,
  title: NonEmptyString,
  state: Schema.Literals(["OPEN", "MERGED", "DECLINED"]),
  draft: Schema.Boolean,
  author: Schema.optional(Schema.NullOr(NonEmptyString)),
  author_uuid: Schema.optional(Schema.NullOr(NonEmptyString)),
  source_branch: NonEmptyString,
  destination_branch: NonEmptyString,
  created_on: NonEmptyString,
  updated_on: NonEmptyString,
  url: NonEmptyString,
});
const ListEnvelope = Schema.Struct({
  pagelen: Schema.Literal(50),
  page: Page,
  total_count: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
  has_more: Schema.Boolean,
  skipped_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pull_requests: Schema.Array(Schema.Unknown),
});
const AggregatedComments = Schema.Struct({
  values: Schema.Array(Schema.Unknown),
  totalFetched: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fetchedPages: PositiveInt,
});

const Diff = Schema.Struct({
  patch: Schema.String,
  truncated: Schema.optional(Schema.Boolean),
});

export type ParatyBitbucketActor = typeof Actor.Type;
export type ParatyBitbucketPullRequest = typeof PullRequest.Type;
export type ParatyBitbucketComment = typeof Comment.Type;
export type ParatyBitbucketPage<A> = {
  readonly pagelen: 50;
  readonly page: number;
  readonly size: number;
  readonly next?: string;
  readonly values: ReadonlyArray<A>;
  readonly malformedCount: number;
};
export type ParatyBitbucketDiff = { readonly patch: string; readonly truncated: boolean };

function inputError(operation: string): OutboundMcpInputError {
  return new OutboundMcpInputError({
    consumerId: PARATY_BITBUCKET_CONSUMER_ID,
    operation,
    category: "invalid-input",
  });
}

function decodeError(operation: string): OutboundMcpDecodeError {
  return new OutboundMcpDecodeError({
    consumerId: PARATY_BITBUCKET_CONSUMER_ID,
    operation,
    category: "invalid-response",
  });
}

function exactEncoder(
  operation: string,
  schema: Schema.Decoder<unknown>,
  keys: ReadonlySet<string>,
) {
  return (
    input: unknown,
  ): Effect.Effect<Readonly<Record<string, unknown>>, OutboundMcpInputError> =>
    Effect.try({
      try: () => {
        if (typeof input !== "object" || input === null || Array.isArray(input))
          throw inputError(operation);
        const record = input as Record<string, unknown>;
        if (Object.keys(record).some((key) => !keys.has(key))) throw inputError(operation);
        const decoded = Schema.decodeUnknownSync(schema)(record) as Readonly<Record<string, unknown>>;
        const { repository, state, ...rest } = decoded;
        return { ...rest, repo_slug: repository, ...(state === undefined ? {} : { states: [state] }) };
      },
      catch: () => inputError(operation),
    });
}

const ListInput = Schema.Struct({
  workspace: Schema.Literal("paraty"),
  repository: NonEmptyString,
  state: Schema.Literals(["OPEN", "MERGED", "DECLINED"]),
  page: Page,
  pagelen: Schema.Literal(50),
  sort: Schema.Literal("-updated_on"),
});

const PullRequestInput = Schema.Struct({
  workspace: Schema.Literal("paraty"),
  repository: NonEmptyString,
  pull_request_id: PositiveInt,
});

const CommentsInput = Schema.Struct({
  workspace: Schema.Literal("paraty"),
  repository: NonEmptyString,
  pull_request_id: PositiveInt,
  page: Page,
  pagelen: Schema.Literal(50),
});

export const encodeParatyBitbucketList = exactEncoder(
  "list",
  ListInput,
  new Set(["workspace", "repository", "state", "page", "pagelen", "sort"]),
);
export const encodeParatyBitbucketDetail = exactEncoder(
  "detail",
  PullRequestInput,
  new Set(["workspace", "repository", "pull_request_id"]),
);
export const encodeParatyBitbucketDiff = exactEncoder(
  "diff",
  PullRequestInput,
  new Set(["workspace", "repository", "pull_request_id"]),
);
export const encodeParatyBitbucketComments = exactEncoder(
  "comments",
  CommentsInput,
  new Set(["workspace", "repository", "pull_request_id", "page", "pagelen"]),
);

function payloadFromMcpResult(
  result: unknown,
  operation: string,
): Effect.Effect<unknown, OutboundMcpDecodeError> {
  return Effect.try({
    try: () => {
      if (typeof result !== "object" || result === null || Array.isArray(result))
        throw decodeError(operation);
      const envelope = result as Record<string, unknown>;
      if (envelope.isError === true) throw decodeError(operation);
      if (envelope.structuredContent !== undefined) return envelope.structuredContent;
      if (!Array.isArray(envelope.content)) throw decodeError(operation);
      const textItems = envelope.content.filter(
        (item): item is { readonly type: "text"; readonly text: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).type === "text" &&
          typeof (item as Record<string, unknown>).text === "string",
      );
      if (textItems.length !== 1) throw decodeError(operation);
      if (operation === "diff") {
        const text = textItems[0]!.text;
        const marker = "\n\n[Truncated: exceeded character limit...]";
        if (text === "" || text.startsWith("diff --git ")) {
          return {
            patch: text.endsWith(marker) ? text.slice(0, -marker.length) : text,
            truncated: text.endsWith(marker),
          };
        }
      }
      return JSON.parse(textItems[0]!.text) as unknown;
    },
    catch: () => decodeError(operation),
  });
}

function decodeStrict<A>(operation: string, schema: Schema.Decoder<A>) {
  return (result: unknown): Effect.Effect<A, OutboundMcpDecodeError> =>
    payloadFromMcpResult(result, operation).pipe(
      Effect.flatMap((payload) =>
        Schema.decodeUnknownEffect(schema)(payload).pipe(
          Effect.mapError(() => decodeError(operation)),
        ),
      ),
    );
}

function decodePage<A>(
  operation: string,
  itemSchema: Schema.Decoder<A>,
  options: { readonly tolerateMalformedEntries: boolean },
  normalize: (payload: unknown) => unknown = (payload) => payload,
) {
  return (result: unknown): Effect.Effect<ParatyBitbucketPage<A>, OutboundMcpDecodeError> =>
    payloadFromMcpResult(result, operation).pipe(
      Effect.flatMap((payload) =>
        Effect.try({ try: () => normalize(payload), catch: () => decodeError(operation) }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(PageEnvelope)),
          Effect.mapError(() => decodeError(operation)),
          Effect.flatMap((page) =>
            Effect.try({
              try: () => {
                const values: A[] = [];
                let malformedCount = 0;
                for (const candidate of page.values) {
                  try {
                    values.push(Schema.decodeUnknownSync(itemSchema)(candidate));
                  } catch (error) {
                    if (!options.tolerateMalformedEntries) throw error;
                    malformedCount += 1;
                  }
                }
                return { ...page, size: page.size ?? page.values.length, values, malformedCount };
              },
              catch: () => decodeError(operation),
            }),
          ),
        ),
      ),
    );
}

export const decodeParatyBitbucketList = (result: unknown) =>
  decodeStrict("list", ListEnvelope)(result).pipe(
    Effect.map((page): ParatyBitbucketPage<ParatyBitbucketPullRequest> => {
      const values: ParatyBitbucketPullRequest[] = [];
      let malformedCount = page.skipped_count;
      for (const candidate of page.pull_requests) {
        try {
          const entry = Schema.decodeUnknownSync(ListSummary)(candidate);
          // Normalize the compact MCP summary for the shared provider mapper.
          // Detail-only fields are fetched separately by the detail operation.
          values.push({
            id: entry.id,
            title: entry.title,
            state: entry.state,
            draft: entry.draft,
            created_on: entry.created_on,
            updated_on: entry.updated_on,
            description: "",
            merge_commit: null,
            reviewers: [],
            source: { branch: { name: entry.source_branch } },
            destination: { branch: { name: entry.destination_branch } },
            links: { html: { href: entry.url } },
            author: entry.author
              ? {
                  display_name: entry.author,
                  nickname: null,
                  uuid: entry.author_uuid ?? entry.author,
                  links: { avatar: null, html: null },
                }
              : null,
          });
        } catch {
          malformedCount += 1;
        }
      }
      return {
        pagelen: page.pagelen,
        page: page.page,
        size: page.total_count ?? page.pull_requests.length,
        ...(page.has_more ? { next: String(page.page + 1) } : {}),
        values,
        malformedCount,
      };
    }),
  );
export const decodeParatyBitbucketDetail = decodeStrict("detail", PullRequest);
export const decodeParatyBitbucketComments = decodePage(
  "comments",
  Comment,
  { tolerateMalformedEntries: false },
  (payload) => {
    if (typeof payload === "object" && payload !== null && "totalFetched" in payload) {
      const page = Schema.decodeUnknownSync(AggregatedComments)(payload);
      return { pagelen: 50, page: 1, size: page.totalFetched, values: page.values };
    }
    return payload;
  },
);
export const decodeParatyBitbucketDiff = (result: unknown) =>
  decodeStrict(
    "diff",
    Diff,
  )(result).pipe(
    Effect.map(
      (decoded): ParatyBitbucketDiff => ({
        patch: decoded.patch,
        truncated: decoded.truncated ?? false,
      }),
    ),
  );
