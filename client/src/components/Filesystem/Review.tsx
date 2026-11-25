import { useContext, useEffect, useState } from 'react';
import { Button } from '@librechat/client';
import { useQuery } from '@tanstack/react-query';
import { boundApprovalLabel } from '@librechat/chat';
import { useComposerPresentsApproval } from '@librechat/chat/react';
import {
  dataService,
  QueryKeys,
  localFilesInputSchema,
  localFilesOperation,
} from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import {
  useApprovalContext,
  useResumeSubmit,
} from '~/components/Chat/Messages/Content/ApprovalContext';
import { FilesystemError, filesystemError } from './engine';
import { triggerDownload } from '~/utils/downloadFile';
import { ChatContext } from '~/Providers/ChatContext';
import useLocalize from '~/hooks/useLocalize';
import { useConnections } from './connection';
import { errorKeys } from './copy';
import Loading from './Loading';

export interface LocalReviewProps {
  name?: string;
  approval: NonNullable<Agents.ToolCall['approval']>;
  toolCallId: string;
  args: string | Record<string, unknown> | undefined;
  surface?: 'thread' | 'composer';
}
export default function Review({
  name = '',
  approval,
  toolCallId,
  args,
  surface = 'thread',
}: LocalReviewProps) {
  const localize = useLocalize();
  const [failure, setFailure] = useState<ReturnType<typeof filesystemError>>();
  const conversationId = useContext(ChatContext)?.conversation?.conversationId ?? '';
  const entry = useConnections().get(conversationId);
  const { actionId } = approval;
  const composer = useComposerPresentsApproval(conversationId, actionId);
  const {
    registerToolCall,
    unregisterToolCall,
    setDecision,
    getDecision,
    getStatus,
    isReady,
    getLeadToolCallId,
  } = useApprovalContext();
  const { submitToolApproval } = useResumeSubmit();
  const preview = useQuery({
    queryKey: [
      QueryKeys.localFiles,
      entry?.owner,
      entry?.root.id,
      entry?.session?.id,
      'review',
      actionId,
      toolCallId,
      args,
    ],
    enabled: !!entry?.session,
    queryFn: async ({ signal }) => {
      let parsed: unknown;
      try {
        parsed = typeof args === 'string' ? JSON.parse(args) : args;
      } catch {
        throw new FilesystemError('INVALID_REQUEST');
      }
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new FilesystemError('INVALID_REQUEST');
      const input = localFilesInputSchema.safeParse({
        ...parsed,
        operation: localFilesOperation(name),
      });
      if (!input.success) throw new FilesystemError('INVALID_REQUEST');
      if (!entry?.session) throw new FilesystemError('UNAVAILABLE');
      const session = entry.session;
      try {
        return await entry.engine.preview(input.data, session.id, (input, cancelled) =>
          dataService.renderLocalFile(
            session,
            input,
            signal ? AbortSignal.any([cancelled, signal]) : cancelled,
          ),
        );
      } catch (error) {
        throw new FilesystemError(filesystemError(error));
      }
    },
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    registerToolCall(actionId, toolCallId);
    return () => unregisterToolCall(actionId, toolCallId);
  }, [actionId, toolCallId, registerToolCall, unregisterToolCall]);
  const status = getStatus(actionId);
  const locked = status === 'submitting' || status === 'submitted' || status === 'expired';
  const decision = getDecision(actionId, toolCallId);
  if (status === 'submitted' || (surface === 'thread' && composer)) return null;
  const ready = preview.data;
  return (
    <div
      data-testid="tool-approval"
      data-tool-call-id={toolCallId}
      className="border-border-medium my-2 flex min-w-0 flex-col gap-2 rounded-lg border p-3"
    >
      <p className="font-medium">{localize('com_fs_review_title')}</p>
      {!entry?.session && <p role="alert">{localize('com_fs_original_tab')}</p>}
      {entry?.session && preview.isLoading && <Loading />}
      {entry?.session && preview.isError && (
        <p role="alert">{localize(errorKeys[filesystemError(preview.error)])}</p>
      )}
      {ready && (
        <>
          <p className="break-all">
            <bdi>{boundApprovalLabel(ready.input.path, 4096).label}</bdi>
          </p>
          {ready.input.operation === 'move' ? (
            <>
              <p className="break-all">
                <bdi>{boundApprovalLabel(ready.input.destination, 4096).label}</bdi>
              </p>
              <p>{localize('com_fs_move_notice')}</p>
            </>
          ) : (
            ready.input.operation !== 'mkdir' && (
              <>
                <h4 className="font-medium">{localize('com_fs_before')}</h4>
                {ready.binary ? (
                  <p className="text-sm break-all">
                    {ready.binary.before
                      ? localize('com_fs_binary_details', {
                          size: ready.binary.before.size,
                          hash: ready.binary.before.hash,
                        })
                      : localize('com_fs_new_file')}
                  </p>
                ) : (
                  <pre
                    dir="auto"
                    className="max-h-60 overflow-auto text-sm break-words whitespace-pre-wrap"
                  >
                    {ready.before}
                  </pre>
                )}
                <h4 className="font-medium">{localize('com_fs_after')}</h4>
                {ready.after && (
                  <pre
                    dir="auto"
                    className="max-h-60 overflow-auto text-sm break-words whitespace-pre-wrap"
                  >
                    {ready.after}
                  </pre>
                )}
                {ready.binary && (
                  <>
                    <p className="text-sm break-all">
                      {localize('com_fs_binary_details', {
                        size: ready.binary.file.size,
                        hash: ready.binary.hash,
                      })}
                    </p>
                    <p className="text-text-secondary text-sm">
                      {localize('com_fs_binary_notice')}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (!ready.binary) return;
                        const url = URL.createObjectURL(ready.binary.file);
                        triggerDownload(url, ready.input.path.split('/').pop() ?? 'file');
                      }}
                    >
                      {localize('com_fs_download_proposal')}
                    </Button>
                  </>
                )}
              </>
            )
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          aria-pressed={decision?.decision === 'approve'}
          variant={decision?.decision === 'approve' ? 'default' : 'outline'}
          disabled={
            locked ||
            !ready ||
            !entry?.engine.canWrite ||
            !approval.allowed_decisions?.includes('approve')
          }
          onClick={() => {
            if (!ready || !entry) return;
            try {
              setDecision(actionId, toolCallId, {
                tool_call_id: toolCallId,
                decision: 'approve',
                scope: 'once',
                localFiles: entry.engine.approve(ready, toolCallId),
              });
              setFailure(undefined);
            } catch (error) {
              setFailure(filesystemError(error));
              setDecision(actionId, toolCallId, null);
            }
          }}
        >
          {localize('com_ui_approve')}
        </Button>
        <Button
          aria-pressed={decision?.decision === 'reject'}
          variant={decision?.decision === 'reject' ? 'default' : 'outline'}
          disabled={locked}
          onClick={() => {
            if (ready) entry?.engine.revoke(ready.review.id);
            setDecision(actionId, toolCallId, { tool_call_id: toolCallId, decision: 'reject' });
          }}
        >
          {localize('com_ui_reject')}
        </Button>
        {surface === 'thread' && getLeadToolCallId(actionId) === toolCallId && (
          <Button
            disabled={locked || !isReady(actionId)}
            onClick={() => submitToolApproval(actionId)}
          >
            {localize('com_ui_submit')}
          </Button>
        )}
      </div>
      <p className="text-text-secondary text-sm">{localize('com_fs_once')}</p>
      {failure && <p role="alert">{localize(errorKeys[failure])}</p>}
    </div>
  );
}
