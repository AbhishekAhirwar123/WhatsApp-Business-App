import { describe, expect, it } from "vitest";
import type { Conversation } from "@/types";
import {
  matchesFolder,
  sortConversations,
  withLastSender,
} from "./conversations";

function conv(id: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    user_id: "u1",
    contact_id: `ct-${id}`,
    status: "open",
    unread_count: 0,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...patch,
  };
}

describe("withLastSender", () => {
  it("lifts the newest embedded message and drops the embed", () => {
    const out = withLastSender({
      ...conv("a"),
      latest_message: [
        { sender_type: "agent", created_at: "2026-10-12T10:00:00Z" },
        { sender_type: "customer", created_at: "2026-10-12T11:00:00Z" },
      ],
    } as Conversation & { latest_message: { sender_type: "agent" | "customer"; created_at: string }[] });
    expect(out.last_sender).toBe("customer");
    expect(out.last_sender_at).toBe("2026-10-12T11:00:00Z");
    expect("latest_message" in out).toBe(false);
  });

  it("marks a thread with no messages as having no last sender", () => {
    const out = withLastSender({ ...conv("a"), latest_message: [] } as Conversation & {
      latest_message: never[];
    });
    expect(out.last_sender).toBeNull();
  });
});

describe("matchesFolder", () => {
  it("routes conversations into the DoubleTick-style folders", () => {
    const waiting = conv("w", { last_sender: "customer" });
    const replied = conv("r", { last_sender: "agent", assigned_agent_id: "me" });
    const closedWaiting = conv("c", { status: "closed", last_sender: "customer" });
    const unread = conv("u", { unread_count: 2 });

    expect(matchesFolder(waiting, "awaiting", "me")).toBe(true);
    expect(matchesFolder(replied, "awaiting", "me")).toBe(false);
    expect(matchesFolder(closedWaiting, "awaiting", "me")).toBe(false);
    expect(matchesFolder(closedWaiting, "closed", "me")).toBe(true);
    expect(matchesFolder(unread, "unread", "me")).toBe(true);
    expect(matchesFolder(replied, "mine", "me")).toBe(true);
    expect(matchesFolder(replied, "unassigned", "me")).toBe(false);
    expect(matchesFolder(waiting, "unassigned", "me")).toBe(true);
    expect(matchesFolder(closedWaiting, "all", "me")).toBe(true);
  });
});

describe("sortConversations", () => {
  const a = conv("a", { last_message_at: "2026-10-12T09:00:00Z", last_sender: "agent" });
  const b = conv("b", {
    last_message_at: "2026-10-12T12:00:00Z",
    last_sender: "customer",
    last_sender_at: "2026-10-12T12:00:00Z",
  });
  const c = conv("c", {
    last_message_at: "2026-10-12T08:00:00Z",
    last_sender: "customer",
    last_sender_at: "2026-10-12T08:00:00Z",
  });

  it("newest first by default", () => {
    expect(sortConversations([a, b, c], "newest").map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("puts the longest-waiting customers first", () => {
    expect(sortConversations([a, b, c], "waiting_longest").map((x) => x.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});
