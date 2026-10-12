"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Number of conversations with an inbound message the CURRENT USER has
 * not read yet (per-user read cursors, migration 044). Drives the green
 * dot on the Inbox nav entry.
 *
 * Uses the same `inbox_counts` RPC as the inbox badges, so the dot and
 * the Unread queue always agree. Refreshes (debounced) on realtime
 * conversation/message changes and when the inbox marks a chat read.
 * Falls back to the legacy account-level `unread_count` if the RPC is
 * unavailable (migration not applied yet).
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = async () => {
      const { data, error } = await supabase.rpc("inbox_counts", { p_filters: {} });
      if (cancelled) return;
      if (!error && data && typeof (data as Record<string, unknown>)["all:unread"] === "number") {
        setTotal((data as Record<string, number>)["all:unread"]);
        return;
      }
      // Legacy fallback: shared counter.
      const { data: rows } = await supabase.from("conversations").select("unread_count").gt("unread_count", 0);
      if (!cancelled) setTotal(rows?.length ?? 0);
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 1500);
    };

    refresh();

    const channel = supabase
      .channel("total-unread-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, schedule)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, schedule)
      .subscribe();
    window.addEventListener("wacrm:inbox-read", schedule);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("wacrm:inbox-read", schedule);
      supabase.removeChannel(channel);
    };
  }, []);

  return total;
}
