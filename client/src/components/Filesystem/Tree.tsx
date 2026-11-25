import { useState } from 'react';
import { Button } from '@librechat/client';
import { QueryKeys } from 'librechat-data-provider';
import { boundApprovalLabel } from '@librechat/chat';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronRight, ChevronDown, File, Folder } from 'lucide-react';
import type { Connection } from './connection';
import { FilesystemError, filesystemError } from './engine';
import useLocalize from '~/hooks/useLocalize';
import { errorKeys } from './copy';
import Loading from './Loading';

export default function Tree({
  entry,
  path = '',
  onOpen,
}: {
  entry: Connection;
  path?: string;
  onOpen: (path: string) => void;
}) {
  const localize = useLocalize();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const query = useInfiniteQuery({
    queryKey: [QueryKeys.localFiles, entry.owner, entry.root.id, 'list', path],
    queryFn: async ({ pageParam = 0 }) => {
      const result = await entry.engine.inspect({
        operation: 'list',
        path,
        cursor: Number(pageParam),
      });
      if (!result.ok) throw new FilesystemError(result.error.code);
      return result.value;
    },
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (query.isLoading) return <Loading />;
  if (query.isError) return <p role="alert">{localize(errorKeys[filesystemError(query.error)])}</p>;
  const entries = query.data.pages.flatMap((page) => page.entries ?? []);
  return (
    <div className="min-w-0">
      {entries.length === 0 && (
        <p className="text-text-secondary p-2 text-sm">{localize('com_fs_empty')}</p>
      )}
      <ul aria-label={localize('com_fs_files')} className="min-w-0 ps-2">
        {entries.map((item) => {
          const child = path ? `${path}/${item.name}` : item.name;
          const open = expanded.has(child);
          const directory = item.kind === 'directory';
          return (
            <li key={item.name} className="min-w-0">
              <Button
                variant="quiet"
                size="sm"
                className="w-full justify-start"
                aria-expanded={directory ? open : undefined}
                onClick={() => {
                  if (!directory) {
                    onOpen(child);
                    return;
                  }
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (open) next.delete(child);
                    else next.add(child);
                    return next;
                  });
                }}
              >
                {directory && open && <ChevronDown className="size-4 shrink-0" />}
                {directory && !open && <ChevronRight className="size-4 shrink-0" />}
                {!directory && <File className="size-4 shrink-0" />}
                {directory && <Folder className="size-4 shrink-0" />}
                <bdi className="truncate">{boundApprovalLabel(item.name, 255).label}</bdi>
              </Button>
              {directory && open && <Tree entry={entry} path={child} onOpen={onOpen} />}
            </li>
          );
        })}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          {localize('com_ui_load_more')}
        </Button>
      )}
    </div>
  );
}
