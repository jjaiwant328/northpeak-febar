/**
 * Right-side drawer with three tabs. Opens when the user clicks a row in
 * the shortfall table. Auto-refreshes on dataMutated (so when the assistant
 * approves a recovery move, this view reflects it live).
 */
import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@databricks/appkit-ui/react';
import { fetchPosition } from '@/lib/stores';
import { dataMutated } from '@/lib/events';
import { StatusBadge } from '@/shared/badges';
import type { PositionDetail } from '@/shared/types';

import { ShortfallTab } from './tabs/ShortfallTab';
import { StoreTab } from './tabs/StoreTab';
import { ActivityTab } from './tabs/ActivityTab';

type Props = {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMutated: () => void;
};

export function PositionDrawer({ id, open, onOpenChange, onMutated }: Props) {
  const [detail, setDetail] = useState<PositionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    setLoading(true);
    fetchPosition(id)
      .then(setDetail)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    const unsub = dataMutated.subscribe(() => {
      if (id) void fetchPosition(id).then(setDetail).catch(() => {});
    });
    return unsub;
  }, [id]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="!w-full sm:!w-[60vw] sm:!max-w-[60vw] lg:!w-[640px] lg:!max-w-[640px] p-0 flex flex-col"
      >
        {!detail && loading && (
          <div className="p-8 text-muted-foreground">Loading…</div>
        )}
        {error && <div className="p-8 text-destructive">{error}</div>}
        {detail && (
          <>
            <SheetHeader className="px-8 pt-8 pb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <StatusBadge status={detail.position.positionStatus} />
                <span className="font-mono text-xs text-muted-foreground">
                  {detail.position.storeId}
                </span>
              </div>
              <SheetTitle className="display text-2xl">
                {detail.position.productName ?? 'Position'}
              </SheetTitle>
              <SheetDescription className="flex items-center gap-2 flex-wrap">
                <span>{detail.position.storeName ?? '—'}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {detail.position.city ?? ''}
                </span>
                {detail.position.region && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">
                      {detail.position.region}
                    </span>
                  </>
                )}
              </SheetDescription>
            </SheetHeader>
            <Tabs defaultValue="shortfall" className="flex-1 flex flex-col min-h-0">
              <TabsList className="mx-8 mt-4 w-fit">
                <TabsTrigger value="shortfall">Shortfall</TabsTrigger>
                <TabsTrigger value="store">Store</TabsTrigger>
                <TabsTrigger value="activity">
                  <Activity className="size-3.5 mr-1" />
                  Activity{' '}
                  {detail.actions.length > 0 && `(${detail.actions.length})`}
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="shortfall"
                className="flex-1 overflow-y-auto px-8 py-6"
              >
                <ShortfallTab detail={detail} onMutated={onMutated} />
              </TabsContent>
              <TabsContent
                value="store"
                className="flex-1 overflow-y-auto px-8 py-6"
              >
                <StoreTab detail={detail} />
              </TabsContent>
              <TabsContent
                value="activity"
                className="flex-1 overflow-y-auto px-8 py-6"
              >
                <ActivityTab detail={detail} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
