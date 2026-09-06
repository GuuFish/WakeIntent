import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ChatMessageConflictError,
  JsonChatMessageStore,
} from "./chat-message-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wakeintent-chat-messages-"));
  temporaryDirectories.push(directory);
  return join(directory, "messages.json");
}

describe("JsonChatMessageStore", () => {
  it("persists one proactive message per contact decision across restart", async () => {
    const filePath = await temporaryFile();
    const input = {
      conversationId: "conversation:study",
      content: "复习计划进行得怎么样？",
      createdAt: "2026-09-06T09:00:00.000Z",
      sourceIntentId: "intent:study",
      sourceDecisionId: "decision:study",
      evidenceRefs: ["event:study"],
    };
    const store = await JsonChatMessageStore.open(filePath);
    const created = await store.appendProactiveMessage(input);
    const duplicate = await store.appendProactiveMessage(input);

    expect(created.outcome).toBe("created");
    expect(duplicate.outcome).toBe("duplicate");
    expect(await JsonChatMessageStore.open(filePath).then((next) =>
      next.listMessages("conversation:study"),
    )).toEqual([created.message]);
  });

  it("rejects reusing a decision for different message content", async () => {
    const store = await JsonChatMessageStore.open(await temporaryFile());
    const input = {
      conversationId: "conversation:study",
      content: "第一条消息",
      createdAt: "2026-09-06T09:00:00.000Z",
      sourceIntentId: "intent:study",
      sourceDecisionId: "decision:study",
      evidenceRefs: ["event:study"],
    };
    await store.appendProactiveMessage(input);
    await expect(
      store.appendProactiveMessage({ ...input, content: "不同的消息" }),
    ).rejects.toBeInstanceOf(ChatMessageConflictError);
  });
});
