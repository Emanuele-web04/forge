import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";

const VALUES = ["system", "light", "dark"] as const;

function RadioGroupHarness({ onValueChange }: { onValueChange: (value: string) => void }) {
  const radioItemProps = useRadioGroupKeyboardNav({
    values: VALUES,
    value: "system",
    onValueChange,
  });

  return (
    <div role="radiogroup" aria-label="Theme">
      {VALUES.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={value === "system"}
          {...radioItemProps(value)}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("advances from the focused radio during rapid arrow navigation", async () => {
  const onValueChange = vi.fn();
  await render(<RadioGroupHarness onValueChange={onValueChange} />);

  page.getByRole("radio", { name: "system" }).element().focus();
  await userEvent.keyboard("{ArrowRight}{ArrowRight}");

  expect(onValueChange.mock.calls).toEqual([["light"], ["dark"]]);
  expect(document.activeElement).toBe(page.getByRole("radio", { name: "dark" }).element());
});
