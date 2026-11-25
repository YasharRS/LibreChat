import { Spinner } from '@librechat/client';
import useLocalize from '~/hooks/useLocalize';

export default function Loading() {
  const localize = useLocalize();
  return (
    <div role="status" className="flex items-center gap-2">
      <Spinner size={16} />
      <span className="sr-only">{localize('com_ui_loading')}</span>
    </div>
  );
}
