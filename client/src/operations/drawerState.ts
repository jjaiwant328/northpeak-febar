/**
 * Position-drawer open state, shared with the ChatDock so the dock can shift
 * left of the drawer instead of overlapping it (both visible at once).
 * Mirrors the dockController pub/sub pattern.
 */
type Listener = (open: boolean) => void;

let open = false;
const listeners = new Set<Listener>();

export const drawerState = {
  setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    listeners.forEach((fn) => fn(open));
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    fn(open);
    return () => listeners.delete(fn);
  },
};
