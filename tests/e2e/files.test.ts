import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.describe("Protected file API", () => {
  test("uploads, reads, and deletes a text knowledge file", async ({
    request,
  }) => {
    const content =
      "Redis stores short-lived stream state. PostgreSQL stores durable file chunks.";
    const uploadResponse = await request.post("/api/files/upload", {
      multipart: {
        file: {
          name: `knowledge-${Date.now()}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from(content, "utf8"),
        },
      },
    });

    expect(uploadResponse.ok()).toBe(true);

    const uploaded = await uploadResponse.json();

    expect(uploaded.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(uploaded.url).toBe(`/api/files/${uploaded.id}`);
    expect(uploaded.parseStatus).toBe("parsed");
    expect(uploaded.textPreview).toContain("Redis stores short-lived");

    const fileResponse = await request.get(uploaded.url);

    expect(fileResponse.ok()).toBe(true);
    expect(fileResponse.headers()["content-type"]).toContain("text/plain");
    expect(await fileResponse.text()).toBe(content);

    const deleteResponse = await request.delete(uploaded.url);

    expect(deleteResponse.ok()).toBe(true);
    expect(await deleteResponse.json()).toMatchObject({
      id: uploaded.id,
      deleted: true,
    });

    const deletedFileResponse = await request.get(uploaded.url);

    expect(deletedFileResponse.status()).toBe(404);
  });

  test("uploads a large text file with chunked upload", async ({ request }) => {
    const chunkSize = 4 * 1024 * 1024;
    const content = Buffer.alloc(21 * 1024 * 1024, "a");
    content.write("chunked upload knowledge marker", 0, "utf8");

    const initiateResponse = await request.post("/api/files/chunked/initiate", {
      data: JSON.stringify({
        filename: `large-knowledge-${Date.now()}.txt`,
        contentType: "text/plain",
        size: content.byteLength,
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(initiateResponse.ok()).toBe(true);

    const uploadSession = await initiateResponse.json();

    expect(uploadSession.chunkSize).toBe(chunkSize);
    expect(uploadSession.totalChunks).toBeGreaterThan(1);

    for (
      let chunkIndex = 0;
      chunkIndex < uploadSession.totalChunks;
      chunkIndex += 1
    ) {
      const start = chunkIndex * uploadSession.chunkSize;
      const end = Math.min(start + uploadSession.chunkSize, content.byteLength);
      const chunkResponse = await request.post("/api/files/chunked/chunk", {
        multipart: {
          uploadId: uploadSession.uploadId,
          chunkIndex: String(chunkIndex),
          chunk: {
            name: `${chunkIndex}.part`,
            mimeType: "application/octet-stream",
            buffer: content.subarray(start, end),
          },
        },
      });

      expect(chunkResponse.ok()).toBe(true);
    }

    const completeResponse = await request.post("/api/files/chunked/complete", {
      data: JSON.stringify({ uploadId: uploadSession.uploadId }),
      headers: { "Content-Type": "application/json" },
    });

    expect(completeResponse.ok()).toBe(true);

    const uploaded = await completeResponse.json();

    expect(uploaded.url).toBe(`/api/files/${uploaded.id}`);
    expect(uploaded.parseStatus).toBe("parsed");
    expect(uploaded.textPreview).toContain("chunked upload knowledge marker");

    const fileResponse = await request.get(uploaded.url);

    expect(fileResponse.ok()).toBe(true);
    expect((await fileResponse.body()).byteLength).toBe(content.byteLength);

    await request.delete(uploaded.url);
  });

  test("can cancel a failed chunked upload session", async ({ request }) => {
    const content = Buffer.alloc(6 * 1024 * 1024, "b");
    const initiateResponse = await request.post("/api/files/chunked/initiate", {
      data: JSON.stringify({
        filename: `cancelled-upload-${Date.now()}.txt`,
        contentType: "text/plain",
        size: content.byteLength,
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(initiateResponse.ok()).toBe(true);

    const uploadSession = await initiateResponse.json();
    const firstChunkResponse = await request.post("/api/files/chunked/chunk", {
      multipart: {
        uploadId: uploadSession.uploadId,
        chunkIndex: "0",
        chunk: {
          name: "0.part",
          mimeType: "application/octet-stream",
          buffer: content.subarray(0, uploadSession.chunkSize),
        },
      },
    });

    expect(firstChunkResponse.ok()).toBe(true);

    const cancelResponse = await request.delete("/api/files/chunked/initiate", {
      data: JSON.stringify({ uploadId: uploadSession.uploadId }),
      headers: { "Content-Type": "application/json" },
    });

    expect(cancelResponse.ok()).toBe(true);
    expect(await cancelResponse.json()).toMatchObject({
      uploadId: uploadSession.uploadId,
      deleted: true,
    });

    const completeResponse = await request.post("/api/files/chunked/complete", {
      data: JSON.stringify({ uploadId: uploadSession.uploadId }),
      headers: { "Content-Type": "application/json" },
    });

    expect(completeResponse.status()).toBe(404);
  });

  test("stores oversized images without blocking on OCR", async ({
    request,
  }) => {
    const imageBuffer = Buffer.alloc(6 * 1024 * 1024, 1);
    const uploadResponse = await request.post("/api/files/upload", {
      multipart: {
        file: {
          name: `large-preview-${Date.now()}.png`,
          mimeType: "image/png",
          buffer: imageBuffer,
        },
      },
    });

    expect(uploadResponse.ok()).toBe(true);

    const uploaded = await uploadResponse.json();

    expect(uploaded.url).toBe(`/api/files/${uploaded.id}`);
    expect(uploaded.parseStatus).toBe("unsupported");
    expect(uploaded.textPreview).toBeNull();

    const fileResponse = await request.get(uploaded.url);

    expect(fileResponse.ok()).toBe(true);
    expect(fileResponse.headers()["content-type"]).toContain("image/png");
    expect((await fileResponse.body()).byteLength).toBe(imageBuffer.byteLength);

    await request.delete(uploaded.url);
  });

  test("deleting a chat also removes its uploaded files", async ({
    request,
  }) => {
    const chatId = randomUUID();
    const chatResponse = await request.post("/api/chat", {
      data: JSON.stringify({
        conversationId: chatId,
        selectedChatModel: "deepseek-v4-flash",
        selectedVisibilityType: "private",
        message: {
          role: "user",
          parts: [{ type: "text", text: "create chat for file cleanup" }],
        },
        stream: false,
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(chatResponse.ok()).toBe(true);

    const content = "file should be removed when its chat is deleted";
    const uploadResponse = await request.post("/api/files/upload", {
      multipart: {
        chatId,
        file: {
          name: `chat-bound-${Date.now()}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from(content, "utf8"),
        },
      },
    });

    expect(uploadResponse.ok()).toBe(true);

    const uploaded = await uploadResponse.json();
    const fileResponse = await request.get(uploaded.url);

    expect(fileResponse.ok()).toBe(true);

    const deleteChatResponse = await request.delete(`/api/chat?id=${chatId}`);

    expect(deleteChatResponse.ok()).toBe(true);
    expect(await deleteChatResponse.json()).toMatchObject({
      id: chatId,
      deletedFiles: 1,
      failedFileDeletes: 0,
    });

    const deletedFileResponse = await request.get(uploaded.url);

    expect(deletedFileResponse.status()).toBe(404);
  });
});
