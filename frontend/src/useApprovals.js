import { useCallback, useEffect, useRef, useState } from 'react';
import { listApprovals, dismissNotice } from './api.js';
import { APPROVALS_POLL_MS, newApprovals, notificationText } from './approvals.js';

// Polls GET /api/approvals while the page is open, on every view, so the
// count can sit in the tab title and a new request or notice can raise a
// browser notification (only if the person allowed them). No server push.
export default function useApprovals(enabled) {
  const [approvals, setApprovals] = useState([]);
  const [notices, setNotices] = useState([]);
  const seen = useRef(null); // ids already shown; null until the first load
  const [notifyState, setNotifyState] = useState(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    let data;
    try { data = await listApprovals(); } catch { return; }
    const all = [...data.approvals, ...data.notices];
    // The first load only records what is already there: a reload should
    // not raise a notification for everything that was waiting.
    if (seen.current) {
      const fresh = newApprovals(seen.current, all);
      if (fresh.length && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        for (const a of fresh) {
          try { new Notification('mdnest', { body: notificationText(a), tag: `approval-${a.id}` }); } catch { /* ignore */ }
        }
      }
    }
    seen.current = new Set(all.map((a) => a.id));
    const same = (next) => (cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next);
    setApprovals(same(data.approvals));
    setNotices(same(data.notices));
  }, [enabled]);

  useEffect(() => {
    if (!enabled) { setApprovals([]); setNotices([]); return undefined; }
    refresh();
    const t = setInterval(refresh, APPROVALS_POLL_MS);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  const dismiss = useCallback(async (id) => {
    setNotices((cur) => cur.filter((n) => n.id !== id));
    try { await dismissNotice(id); } catch { /* the next poll shows it again */ }
  }, []);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    try { setNotifyState(await Notification.requestPermission()); } catch { /* ignore */ }
  }, []);

  return { approvals, notices, refresh, dismiss, notifyState, enableNotifications };
}
