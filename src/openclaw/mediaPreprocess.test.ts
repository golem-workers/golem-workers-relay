import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { prepareChatMedia } from "./mediaPreprocess.js";

function image(data: Buffer) {
  return { type: "image" as const, dataB64: data.toString("base64"), contentType: "image/png", fileName: "test.png" };
}

describe("bounded vision image decoding", () => {
  it.each(["png", "jpeg", "gif", "tiff", "avif"] as const)("normalizes %s to a 640x480 PNG", async (format) => {
    const input = await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).toFormat(format).toBuffer();
    const result = await prepareChatMedia({ messageText: "picture", media: [image(input)] });
    const metadata = await sharp(Buffer.from(result.visionMedia[0].dataB64, "base64")).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 640, height: 480 });
    expect(result.uploadMedia).toEqual(result.visionMedia);
  });

  it("rejects oversized SVG dimensions before rasterization", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"><rect width="100%" height="100%" fill="red"/></svg>');
    await expect(prepareChatMedia({ messageText: "", media: [image(svg)] })).rejects.toThrow(/pixel limit/i);
  });

  it("rejects encoded input larger than 20 MiB before decoding", async () => {
    const item = { ...image(Buffer.alloc(0)), dataB64: "A".repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 4) };
    await expect(prepareChatMedia({ messageText: "", media: [item] })).rejects.toThrow("20 MiB");
  });

  it("rejects corrupt image bytes", async () => {
    await expect(prepareChatMedia({ messageText: "", media: [image(Buffer.from("not an image"))] })).rejects.toThrow();
  });
});
