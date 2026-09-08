import { describe, expect, it } from "vitest";
import { stripDiagnosticImages } from "./stripDiagnosticImages.ts";

describe("stripDiagnosticImages", () => {
  it("omits MCP and Anthropic bodies while preserving model input and shared references", () => {
    const data = Buffer.alloc(512 * 1024, 123).toString("base64");
    const image = Object.freeze({ type: "image", data, mimeType: "image/png", width: 1280 });
    const text = Object.freeze({ type: "text", text: "Done" });
    const input = Object.freeze({
      payload: Object.freeze([
        image,
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
        text,
      ]),
      raw: Object.freeze({ image }),
    });
    const output = stripDiagnosticImages(input) as { payload: unknown[]; raw: { image: unknown } };
    expect(JSON.stringify(output).length).toBeLessThan(1000);
    expect(output.payload[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      width: 1280,
      synaraImageOmitted: true,
      encodedLength: data.length,
      byteLength: 512 * 1024,
    });
    expect(output.payload[1]).toMatchObject({
      source: { synaraImageOmitted: true, byteLength: 512 * 1024 },
    });
    expect(output.raw.image).toBe(output.payload[0]);
    expect(output.payload[2]).toBe(text);
    expect(image.data).toBe(data);
    expect(stripDiagnosticImages(output)).toBe(output);
  });

  it("keeps ordinary data, artifact paths and non-JSON objects unchanged", () => {
    const input = {
      data: "aGVsbG8=",
      path: "/images/result.png",
      text: "data:image/png is a URL prefix",
      date: new Date("2026-01-01"),
      bytes: Buffer.from("hello"),
    };
    expect(stripDiagnosticImages(input)).toBe(input);
  });

  it.each(["url", "image_url", "imageUrl"])("omits an inline image in %s", (key) => {
    expect(stripDiagnosticImages({ [key]: "data:image/png;base64,aGVsbG8=" })).toEqual({
      [key]: { synaraImageOmitted: true, mimeType: "image/png", encodedLength: 30 },
    });
  });

  it("preserves sparse array length and holes", () => {
    const input = new Array(4);
    input[1] = { type: "image", data: "aGVsbG8=" };
    const output = stripDiagnosticImages(input) as unknown[];
    expect(output).toHaveLength(4);
    expect(0 in output).toBe(false);
    expect(2 in output).toBe(false);
    expect(3 in output).toBe(false);
    expect(output[1]).toMatchObject({ synaraImageOmitted: true, byteLength: 5 });
  });

  it("does not retain the original image through a cycle or shared child", () => {
    const input: Record<string, unknown> = {};
    const child = { parent: input, image: { type: "image", data: "aGVsbG8=" } };
    input.self = input;
    input.child = child;
    input.alias = child;
    const output = stripDiagnosticImages(input) as Record<string, unknown>;
    const copiedChild = output.child as typeof child;
    expect(output.self).toBe(output);
    expect(output.alias).toBe(copiedChild);
    expect(copiedChild.parent).toBe(output);
    expect(copiedChild.image).toEqual({
      type: "image",
      synaraImageOmitted: true,
      encodedLength: 8,
      byteLength: 5,
    });
    expect(child.image.data).toBe("aGVsbG8=");
  });
});
