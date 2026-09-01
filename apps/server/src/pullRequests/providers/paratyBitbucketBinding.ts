import type { McpConsumerBinding } from "../../outboundMcp/consumerBinding.ts";
import {
  PARATY_BITBUCKET_CONSUMER_ID,
  decodeParatyBitbucketComments,
  decodeParatyBitbucketDetail,
  decodeParatyBitbucketDiff,
  decodeParatyBitbucketList,
  encodeParatyBitbucketComments,
  encodeParatyBitbucketDetail,
  encodeParatyBitbucketDiff,
  encodeParatyBitbucketList,
} from "./paratyBitbucketSchemas.ts";

export { PARATY_BITBUCKET_CONSUMER_ID } from "./paratyBitbucketSchemas.ts";

export const PARATY_BITBUCKET_TOOLS = {
  list: "paraty_bitbucket_pr_list",
  detail: "paraty_bitbucket_pr_get",
  diff: "paraty_bitbucket_pr_diff",
  comments: "paraty_bitbucket_pr_comment_list",
} as const;

export type ParatyBitbucketOperation = keyof typeof PARATY_BITBUCKET_TOOLS;

export const paratyBitbucketPullRequestBinding: McpConsumerBinding<ParatyBitbucketOperation> = {
  id: PARATY_BITBUCKET_CONSUMER_ID,
  presetIds: new Set(["paraty"]),
  requiredTools: new Set(Object.values(PARATY_BITBUCKET_TOOLS)),
  optionalTools: new Set(),
  operations: {
    list: {
      tool: PARATY_BITBUCKET_TOOLS.list,
      encode: encodeParatyBitbucketList,
      decode: decodeParatyBitbucketList,
    },
    detail: {
      tool: PARATY_BITBUCKET_TOOLS.detail,
      encode: encodeParatyBitbucketDetail,
      decode: decodeParatyBitbucketDetail,
    },
    diff: {
      tool: PARATY_BITBUCKET_TOOLS.diff,
      encode: encodeParatyBitbucketDiff,
      decode: decodeParatyBitbucketDiff,
    },
    comments: {
      tool: PARATY_BITBUCKET_TOOLS.comments,
      encode: encodeParatyBitbucketComments,
      decode: decodeParatyBitbucketComments,
    },
  },
};
