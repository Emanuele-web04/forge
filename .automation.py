from pathlib import Path

path = Path("apps/server/src/provider/Layers/ProviderHealth.test.ts")
text = path.read_text()
old = "assert.strictEqual(statuses.length, 9);"
new = "assert.strictEqual(statuses.length, 10);"
count = text.count(old)
assert count == 1, f"expected exactly one disabled-provider count, found {count}"
path.write_text(text.replace(old, new))
