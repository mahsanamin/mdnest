import { useCallback, useEffect, useRef, useState } from 'react';
import { listApprovals } from './api.js';
import { APPROVALS_POLL_MS, newApprovals, notificationText } from './approvals.js';

// Polls GET /api/approvals while the page is open, on every view, so the
// count can sit in the tab title and a new request can raise a browser
// notification (only if the person allowed them). No server push.
export default function useApprovals(enabled) {
  const [approvals, setApprovals] = useState([]);
  const seen = useRef(null); // ids already shown; null until the first load
  const [notifyState, setNotifyState] = useState(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    let list;
    try { list = await listApprovals(); } catch { return; }
    // The first load only records what is already there: a reload should
    // not raise a notification for every request that was waiting.
    if (seen.current) {
      const fresh = newApprovals(seen.current, list);
      if (fresh.length && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        for (const a of fresh) {
          try { new Notification('mdnest', { body: notificationText(a), tag: `approval-${a.id}` }); } catch { /* ignore */ }
        }
      }
    }
    seen.current = new Set(list.map((a) => a.id));
    setApprovals((cur) => (JSON.stringify(cur) === JSON.stringify(list) ? cur : list));
  }, [enabled]);

  useEffect(() => {
    if (!enabled) { setApprovals([]); return undefined; }
    refresh();
    const t = setInterval(refresh, APPROVALS_POLL_MS);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    try { setNotifyState(await Notification.requestPermission()); } catch { /* ignore */ }
  }, []);

  return { approvals, refresh, notifyState, enableNotifications };
}
