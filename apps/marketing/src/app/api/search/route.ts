import { createFromSource } from "fumadocs-core/search/server";
import { docsSource } from "@/lib/docs";

export const { GET } = createFromSource(docsSource, {
  language: "english",
});
