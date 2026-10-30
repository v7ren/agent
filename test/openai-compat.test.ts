import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkPayload,
  completionPayload,
  contentChunks,
  extractUserText,
  FISHD_MODEL_ID,
  modelsPayload,
} from "../src/web/openai-compat.ts";

test("extractUserText takes the last user string", () => {
  const text = extractUserText([
    { role: "system", content: "ignored" },
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "  今天吃什麼  " },
  ]);
  assert.equal(text, "今天吃什麼");
});

test("extractUserText understands multimodal parts", () => {
  const text = extractUserText([
    {
      role: "user",
      content: [
        { type: "text", text: "這張圖" },
        { type: "image_url", image_url: { url: "data:..." } },
        { type: "text", text: "是什麼" },
      ],
    },
  ]);
  assert.equal(text, "這張圖 是什麼");
});

test("extractUserText returns empty when there is no user message", () => {
  assert.equal(extractUserText([{ role: "assistant", content: "hi" }]), "");
  assert.equal(extractUserText(null), "");
});

test("completionPayload has the OpenAI shape", () => {
  const payload = completionPayload({
    id: "chatcmpl-1",
    model: FISHD_MODEL_ID,
    content: "白飯",
    usage: {
      promptTokens: 10,
      completionTokens: 3,
      cacheHitTokens: 0,
      cacheMissTokens: 10,
    },
  });

  assert.equal(payload.object, "chat.completion");
  assert.equal(payload.choices[0]?.message.content, "白飯");
  assert.equal(payload.usage.total_tokens, 13);
});

test("contentChunks keeps every character and chunkPayload is a delta", () => {
  const text = "一二三四五六七八九十";
  const chunks = contentChunks(text, 3);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length >= 3);

  const payload = chunkPayload({
    id: "chatcmpl-1",
    model: FISHD_MODEL_ID,
    delta: { content: chunks[0] },
  });
  assert.equal(payload.object, "chat.completion.chunk");
  assert.equal(payload.choices[0]?.delta.content, chunks[0]);
});

test("modelsPayload lists the fishd model", () => {
  const payload = modelsPayload(1);
  assert.equal(payload.data[0]?.id, FISHD_MODEL_ID);
});
