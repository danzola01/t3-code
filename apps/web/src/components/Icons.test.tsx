import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Gemini } from "./Icons";

describe("Gemini icon", () => {
  it("uses unique paint server ids for every mounted instance", () => {
    const html = renderToStaticMarkup(
      <>
        <Gemini />
        <Gemini />
      </>,
    );
    const ids = Array.from(html.matchAll(/\sid="([^"]+)"/gu), (match) => match[1]);

    expect(ids).toHaveLength(16);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
