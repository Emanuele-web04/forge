import type { BrowserUploadTarget } from "@synara/contracts";

/** Only schema-validated values enter generated host snippets. */
export function betterwrightLocator(target: BrowserUploadTarget): string {
  if ("selector" in target) return `page.locator(${JSON.stringify(target.selector)})`;
  const locator = target.locator;
  switch (locator.kind) {
    case "role":
      return `page.getByRole(${JSON.stringify(locator.role)},${JSON.stringify({ name: locator.name, exact: locator.exact ?? true })})`;
    case "testId":
      return `page.getByTestId(${JSON.stringify(locator.value)})`;
    case "text":
    case "label":
    case "placeholder": {
      const method = { text: "getByText", label: "getByLabel", placeholder: "getByPlaceholder" }[
        locator.kind
      ];
      return `page.${method}(${JSON.stringify(locator.text)},${JSON.stringify({ exact: locator.exact ?? true })})`;
    }
  }
}
