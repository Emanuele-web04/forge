import { describe, expect, it } from "vitest";
import { stripDiagnosticImages } from "./stripDiagnosticImages.ts";

describe("stripDiagnosticImages", () => {
  it("removes MCP and Anthropic image bodies without altering model delivery", () => {
    const data = Buffer.alloc(500 * 1024, 123).toString("base64");
    const image = { type: "image", data, mimeType: "image/png", width: 1280 };
    const anthropic = { type: "image", source: { type: "base64", media_type: "image/png", data } };
    const input = {
      payload: { result: [image, anthropic, { type: "text", text: "Done" }] },
      raw: { image },
    };
    const output = stripDiagnosticImages(input);
    expect(JSON.stringify(output).length).toBeLessThan(1000);
    expect(output.payload.result[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      width: 1280,
      synaraImageOmitted: true,
      encodedLength: data.length,
      byteLength: 500 * 1024,
    });
    expect(output.raw.image).toBe(output.payload.result[0]);
    expect(output.payload.result[2]).toBe(input.payload.result[2]);
    expect(input.raw.image.data).toBe(data);
    expect(stripDiagnosticImages(output)).toBe(output);
  });

  it("keeps ordinary data and artifact paths unchanged", () => {
    const input = {
      data: "aGVsbG8=",
      result: [{ type: "text", text: "data:image/png is a URL prefix" }],
      path: "/images/result.png",
    };
    expect(stripDiagnosticImages(input)).toBe(input);
  });

  it("omits inline image URLs without copying their body", () => {
    const output = stripDiagnosticImages({ image_url: { url: "data:image/png;base64,aGVsbG8=" } });
    expect(output.image_url.url).toEqual({
      synaraImageOmitted: true,
      mimeType: "image/png",
      encodedLength: 30,
    });
  });
});
