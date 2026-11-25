import { useState } from 'react';
import { Button } from '@librechat/client';
import { useParams } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { boundApprovalLabel } from '@librechat/chat';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Folder } from './engine';
import { useConnections, setConnection, disconnect, localFilesOwner } from './connection';
import { Filesystem, FilesystemError, filesystemError } from './engine';
import { registerFolder, recallFolder, localJournal } from './storage';
import { useChatTransport } from '~/Providers/ChatTransportContext';
import { useGetStartupConfig } from '~/data-provider/Endpoints';
import { useAuthContext } from '~/hooks/AuthContext';
import useLocalize from '~/hooks/useLocalize';
import { errorKeys } from './copy';
import Loading from './Loading';
import Tree from './Tree';

type Picker = Window & { showDirectoryPicker?: (options: { mode: 'read' }) => Promise<Folder> };
export default function Panel() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const owner = localFilesOwner(user) ?? '';
  const transport = useChatTransport();
  const { conversationId = 'new' } = useParams();
  const entries = useConnections();
  const candidate = entries.get(conversationId);
  const entry = candidate?.owner === owner ? candidate : undefined;
  const { data: startup } = useGetStartupConfig();
  const config = startup?.localFiles;
  const client = useQueryClient();
  const [selected, setSelected] = useState('');
  const [failure, setFailure] = useState<ReturnType<typeof filesystemError>>();
  const supported =
    window.isSecureContext &&
    typeof (window as Picker).showDirectoryPicker === 'function' &&
    !!navigator.locks;
  const remembered = useQuery({
    queryKey: [QueryKeys.localFiles, owner, 'remembered'],
    queryFn: () => recallFolder(owner),
    enabled: !!owner && supported && config?.available === true,
    retry: false,
  });
  const connect = useMutation({
    mutationFn: async ({ folder }: { folder: Folder }) => {
      if (!config?.available || !owner) throw new FilesystemError('UNAVAILABLE');
      let descriptor;
      try {
        descriptor = await registerFolder(owner, folder);
      } catch (error) {
        throw new FilesystemError(filesystemError(error));
      }
      if (entry) disconnect(entry);
      setConnection(conversationId, {
        owner,
        conversationId,
        root: descriptor,
        engine: new Filesystem(folder, config, localJournal(owner)),
        client,
        stop: (id, generationCreatedAt) =>
          transport.abort({ conversationId: id, generationCreatedAt }),
      });
      setSelected('');
      setFailure(undefined);
      await client.invalidateQueries({ queryKey: [QueryKeys.localFiles, owner, 'remembered'] });
    },
    onError: (error) => setFailure(filesystemError(error)),
  });
  const preview = useQuery({
    queryKey: [QueryKeys.localFiles, owner, entry?.root.id, 'preview', selected],
    enabled: !!entry && !!selected,
    queryFn: async () => {
      const result = await entry!.engine.inspect({ operation: 'read', path: selected });
      if (!result.ok) throw new FilesystemError(result.error.code);
      return result.value;
    },
    retry: false,
    refetchOnWindowFocus: false,
    cacheTime: 0,
  });
  const choose = async () => {
    try {
      const folder = await (window as Picker).showDirectoryPicker!({ mode: 'read' });
      connect.mutate({ folder });
    } catch (error) {
      setFailure(filesystemError(error));
    }
  };
  const restore = async () => {
    const saved = remembered.data;
    if (!saved) return;
    try {
      if ((await saved.folder.requestPermission({ mode: 'read' })) !== 'granted')
        throw new FilesystemError('PERMISSION_DENIED');
      connect.mutate(saved);
    } catch (error) {
      setFailure(filesystemError(error));
    }
  };
  const enable = async () => {
    if (!entry || !config) return;
    const engine = new Filesystem(entry.engine.folder, config, localJournal(owner));
    try {
      if (!(await engine.enable())) throw new FilesystemError('PERMISSION_DENIED');
      disconnect(entry);
      setConnection(conversationId, {
        owner,
        conversationId,
        engine,
        root: { ...entry.root, access: 'readwrite' },
        client,
        stop: (id, generationCreatedAt) =>
          transport.abort({ conversationId: id, generationCreatedAt }),
      });
      setFailure(undefined);
    } catch (error) {
      setFailure(filesystemError(error));
    }
  };
  return (
    <section className="flex min-h-0 flex-col gap-3 p-3" aria-label={localize('com_fs_title')}>
      <h2 className="text-lg font-semibold">{localize('com_fs_title')}</h2>
      <p className="text-text-secondary text-sm">{localize('com_fs_description')}</p>
      {!supported && <p role="status">{localize('com_fs_browser')}</p>}
      {supported && !config?.available && (
        <p role="status">{localize('com_fs_approval_disabled')}</p>
      )}
      {supported && config?.available && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={connect.isLoading}
              onClick={() => {
                void choose();
              }}
            >
              {localize('com_fs_choose')}
            </Button>
            {!entry && remembered.data && (
              <Button
                variant="quiet"
                disabled={connect.isLoading}
                onClick={() => {
                  void restore();
                }}
              >
                {localize('com_fs_reconnect')}
              </Button>
            )}
          </div>
          {entry && (
            <>
              <div role="status" className="flex flex-wrap items-center gap-2">
                <bdi>{boundApprovalLabel(entry.root.name, 255).label}</bdi>
                <span className="text-text-secondary text-sm">
                  {localize(
                    entry.root.access === 'read' ? 'com_fs_read_only' : 'com_fs_review_changes',
                  )}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {entry.root.access === 'read' && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      void enable();
                    }}
                  >
                    {localize('com_fs_enable_write')}
                  </Button>
                )}
                <Button
                  variant="quiet"
                  onClick={() => {
                    disconnect(entry);
                    setSelected('');
                  }}
                >
                  {localize('com_fs_disconnect')}
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => {
                    void client.invalidateQueries({
                      queryKey: [QueryKeys.localFiles, owner, entry.root.id],
                    });
                  }}
                >
                  {localize('com_fs_refresh')}
                </Button>
              </div>
              <Tree key={entry.root.id} entry={entry} onOpen={setSelected} />
              {selected && (
                <section className="min-w-0" aria-label={localize('com_fs_preview')}>
                  <h3 className="font-medium break-all">
                    <bdi>{boundApprovalLabel(selected, 4096).label}</bdi>
                  </h3>
                  {preview.isLoading && <Loading />}
                  {preview.isError && (
                    <p role="alert">{localize(errorKeys[filesystemError(preview.error)])}</p>
                  )}
                  {preview.data?.binary && (
                    <>
                      {[
                        'image/jpeg',
                        'image/png',
                        'image/webp',
                        'image/gif',
                        'image/avif',
                      ].includes(preview.data.binary.mime) && (
                        <img
                          src={`data:${preview.data.binary.mime};base64,${preview.data.binary.data}`}
                          alt={localize('com_fs_preview')}
                          className="max-h-96 max-w-full object-contain"
                        />
                      )}
                      <p className="text-text-secondary text-sm">
                        {localize('com_fs_document_preview')}
                      </p>
                    </>
                  )}
                  {preview.data?.content != null && (
                    <pre
                      className="border-border-light max-h-96 overflow-auto rounded-md border p-2 text-sm break-words whitespace-pre-wrap"
                      dir="auto"
                    >
                      {preview.data.content}
                    </pre>
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}
      {failure && <p role="alert">{localize(errorKeys[failure])}</p>}
    </section>
  );
}
