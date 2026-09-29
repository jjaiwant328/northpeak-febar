/**
 * Position-drawer state, shared with the ChatDock so the dock can:
 *  - shift left of the drawer instead of overlapping it, and
 *  - tailor its "Suggested next" chip to the store/SKU being analyzed.
 * Mirrors the dockController pub/sub pattern.
 */
export type DrawerContext = { storeId: string; productId: string } | null;

type Listener = (open: boolean, ctx: DrawerContext) => void;

let open = false;
let ctx: DrawerContext = null;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((fn) => fn(open, ctx));
}

export const drawerState = {
  setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    if (!next) ctx = null;
    emit();
  },
  setContext(next: DrawerContext) {
    ctx = next;
    emit();
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    fn(open, ctx);
    return () => listeners.delete(fn);
  },
};
