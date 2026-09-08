"""Compile production input functions against a minimal Wayland seat model.

No compositor is started or contacted. The fixture records which surface a
client's shared pointer/keyboard would deliver each event to.
"""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def definition(source, name, kind="function"):
    pattern = (r"^struct " if kind == "struct" else r"^(?:void|bool|int|double) ")
    pattern += re.escape(name) + (r" \{" if kind == "struct" else r"\([^\n]*\) \{")
    match = re.search(pattern, source, re.MULTILINE)
    if not match:
        raise AssertionError(f"Missing production definition: {name}")
    opening = source.index("{", match.start())
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[match.start():end] + (";" if kind == "struct" else "")


class FocusRegressionTest(unittest.TestCase):
    def test_input_delivery_and_handback(self):
        source = (ROOT / "synarahyprlandplugin.cpp").read_text()
        names = [
            "directPointerLeave", "returnPointerToSeat", "directPointerMotion",
            "clearPointerDelivery", "updatePointerFocus", "onSeatPointerFocusChange",
            "returnKeyboardToSeat", "updateKeyboardFocus",
        ]
        definitions = [definition(source, name) for name in names]
        definitions.append(definition(source, "InputFocusHandback", "struct"))
        for name in ["movePointer", "injectButton", "takeDiscreteSteps", "scrollAxisValue",
                     "scrollValue120", "injectAxis", "injectKey"]:
            definitions.append(definition(source, name))
        fixture = (ROOT / "tests/focus_fixture.cpp").read_text()
        with tempfile.TemporaryDirectory(prefix="synara-focus-test-") as directory:
            cpp = Path(directory) / "focus.cpp"
            cpp.write_text(fixture.replace("// PRODUCTION_DEFINITIONS", "\n\n".join(definitions)))
            binary = Path(directory) / "focus-test"
            subprocess.run(["g++", "-std=c++20", "-Wall", "-Wextra", str(cpp), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
