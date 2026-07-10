import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  type NotificationRow,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadCount,
} from "../api/hooks.js";
import { Button, Spinner } from "./ui.js";

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const { data: unread } = useUnreadCount();
  const { data: items, isPending } = useNotifications(open);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function onSelect(notification: NotificationRow) {
    if (!notification.readAt) await markRead.mutateAsync(notification.id);
    setOpen(false);
    if (notification.payload.formInstanceId) {
      await navigate({
        to: "/forms/$formInstanceId",
        params: { formInstanceId: notification.payload.formInstanceId },
      });
    }
  }

  const count = unread?.count ?? 0;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label={`Notifications${count > 0 ? ` (${count} unread)` : ""}`}
        className="relative rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-96 rounded-xl border border-zinc-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
            <span className="text-sm font-semibold text-zinc-900">Notifications</span>
            {count > 0 ? (
              <Button variant="ghost" onClick={() => markAll.mutate()}>
                Mark all read
              </Button>
            ) : null}
          </div>
          {isPending ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : items && items.length > 0 ? (
            <ul className="max-h-96 divide-y divide-zinc-100 overflow-y-auto">
              {items.map((notification) => (
                <li key={notification.id}>
                  <button
                    type="button"
                    className={`w-full px-4 py-3 text-left hover:bg-zinc-50 ${
                      notification.readAt ? "opacity-60" : ""
                    }`}
                    onClick={() => onSelect(notification)}
                  >
                    <div className="flex items-center gap-2">
                      {notification.readAt ? null : (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
                      )}
                      <span className="truncate text-sm font-medium text-zinc-900">
                        {notification.title}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-zinc-400">
                        {timeAgo(notification.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">{notification.body}</p>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">No notifications.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
