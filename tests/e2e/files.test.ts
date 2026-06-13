import { expect, test } from "@playwright/test";

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
});
