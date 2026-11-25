import { z } from 'zod';
import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import {
  LOCAL_FILES_TOOLS,
  localFilesInputSchema,
  localFilesMutation,
  localFilesOperation,
  localFilesReviewSchema,
  serializeLocalFiles,
} from 'librechat-data-provider';
import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';
import type { Agents } from 'librechat-data-provider';
import type { HookCallback } from '@librechat/agents';
import type { ResolvedToolApprovalHook } from '~/agents/hitl/hooks';
import type { LocalFilesBinding } from './service';
import type { ServerRequest } from '~/types';
import { localFilesFailure, localFilesAvailable } from './service';
import { getSafeErrorMetadata } from '~/utils/errors';

const descriptions = {
  list: 'List one page in the user-selected local folder. Use path "" for its root and cursor for the next page.',
  read: 'Read a UTF-8 text or code file in the user-selected local folder. Contents become part of this chat.',
  write:
    'Create or replace a UTF-8 text file in the selected local folder. Supply content. Always requires the owner to review the exact change.',
  edit: 'Apply exact, unique oldText/newText replacements to a local UTF-8 file. Supply edits. Always requires local review.',
  mkdir:
    'Create a directory inside the selected local folder. Its parent must exist. Always requires local review.',
  move: 'Move one file within the selected local folder. Supply destination. Copies, verifies, then removes the source; not atomic and never overwrites a destination. Requires local review. Do not automatically retry an uncertain result.',
};

export const localFilesApprovalHook: HookCallback<'PreToolUse'> = async ({ toolName }) => {
  const operation = localFilesOperation(toolName);
  return operation && localFilesMutation(operation)
    ? { decision: 'ask', allowedDecisions: ['approve', 'reject'] }
    : {};
};

/** Remembered tool-wide grants never authorize a local disk mutation. */
export function markLocalFileApprovalRequests<T extends Agents.HumanInterruptPayload>(
  payload: T,
): T {
  if (payload.type !== 'tool_approval') return payload;
  const ids = new Set(
    payload.action_requests
      .filter((request) => {
        const operation = localFilesOperation(request.name);
        return operation != null && localFilesMutation(operation);
      })
      .map((request) => request.tool_call_id),
  );
  return {
    ...payload,
    review_configs: payload.review_configs.map((config) =>
      ids.has(config.tool_call_id)
        ? { ...config, allow_always: false, allowed_decisions: ['approve', 'reject'] }
        : config,
    ),
  };
}

export function localFilesAdmission(
  req: ServerRequest & { _isScheduledFire?: boolean },
  hooks: readonly ResolvedToolApprovalHook[],
  names: readonly string[] = [],
): {
  hostGeneratedToolNames: readonly string[];
  resolvedProgrammaticHooks: readonly ResolvedToolApprovalHook[];
} {
  if (
    !req.body.localFilesSessionId ||
    req._isScheduledFire === true ||
    !localFilesAvailable(req.config)
  )
    return { hostGeneratedToolNames: names, resolvedProgrammaticHooks: hooks };
  return {
    hostGeneratedToolNames: [...names, ...Object.values(LOCAL_FILES_TOOLS)],
    resolvedProgrammaticHooks: [
      ...hooks,
      { hook: localFilesApprovalHook, matcher: '^local_(write|edit|mkdir|move)$' },
    ],
  };
}

export function createLocalFilesTools(
  binding: LocalFilesBinding,
  conversationId: string,
  signal: AbortSignal,
  writable: boolean,
): StructuredToolInterface[] {
  return Object.entries(LOCAL_FILES_TOOLS)
    .filter(([operation]) => writable || operation === 'list' || operation === 'read')
    .map(([operation, name]) => {
      const option = localFilesInputSchema.options.find(
        (entry) => entry.shape.operation.value === operation,
      );
      if (!option) throw new Error('Local file tool has no input contract');
      const schema: z.ZodObject = option;
      return tool(
        async (args, config) => {
          const parsed = localFilesInputSchema.safeParse({ ...args, operation });
          if (!parsed.success) return JSON.stringify(localFilesFailure('INVALID_REQUEST'));
          const input = parsed.data;
          if (
            input.operation === 'write' &&
            Buffer.byteLength(input.content, 'utf8') > binding.config.maxTextBytes
          ) {
            return JSON.stringify(localFilesFailure('TOO_LARGE'));
          }
          const toolCallId = config.toolCall?.id;
          if (!toolCallId) return JSON.stringify(localFilesFailure('UNAVAILABLE'));
          const decision = binding.decisions.find((entry) => entry.tool_call_id === toolCallId);
          const review = localFilesReviewSchema.safeParse(decision?.localFiles);
          if (
            localFilesMutation(input.operation) &&
            (decision?.decision !== 'approve' ||
              (decision.scope != null && decision.scope !== 'once') ||
              !review.success ||
              review.data.sessionId !== binding.sessionId ||
              review.data.digest !==
                createHash('sha256').update(serializeLocalFiles(input)).digest('hex'))
          )
            return JSON.stringify(localFilesFailure('REVIEW_REQUIRED'));
          try {
            return JSON.stringify(
              await binding.invoke(
                {
                  conversationId,
                  toolCallId,
                  runId: '',
                  input,
                  ...(review.success ? { review: review.data } : {}),
                },
                config.signal ?? signal,
              ),
            );
          } catch (error) {
            logger.error('[Local files] Tool transport failed', getSafeErrorMetadata(error));
            return JSON.stringify(localFilesFailure('UNAVAILABLE'));
          }
        },
        {
          name,
          description: descriptions[operation as keyof typeof descriptions],
          schema: schema.omit({ operation: true }),
        },
      );
    });
}
