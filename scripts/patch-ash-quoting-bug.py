#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates.

"""Patch the ASH scanner plugins to fix the --skip-path/--exclude quoting bug.

Affects ASH v3.2.1 through at least v3.5.2. Re-run against newer versions to
confirm whether it's still needed; an upstream PR is open against awslabs/
automated-security-helper, so this script (and the workflow step that calls
it) should be removed once the fix ships.

Bug: ASH builds scanner CLI arguments with f-strings that embed literal
double-quotes around the value, e.g.
    f'--skip-path="{item.path}"'   ->   --skip-path="cdk.out"
Because there is no shell in between, the quotes are passed verbatim as part
of the argv value. The downstream tool (checkov, bandit) then compiles a
regex that contains literal `"` characters, which can never match a real file
path. Exclusions silently fail.

Fix: remove the embedded quotes so the value is passed cleanly:
    f'--skip-path={item.path}'   ->   --skip-path=cdk.out

This script is idempotent: it creates a backup once (`*.pre-quoting-patch.bak`)
and exits cleanly if the file has already been patched.

Usage:
    python3 scripts/patch-ash-quoting-bug.py
Exit codes:
    0 - patched successfully, or already patched
    1 - ASH not importable (not installed in the active Python)
    2 - unexpected file contents (patch did not apply cleanly)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCANNERS = ("checkov_scanner.py", "bandit_scanner.py")

REPLACEMENTS = (
    # checkov: both the KNOWN_IGNORE_PATHS loop and the user skip_path loop
    ("f'--skip-path=\"{item}\"'", "f'--skip-path={item}'"),
    ("f'--skip-path=\"{item.path}\"'", "f'--skip-path={item.path}'"),
    # bandit: the --exclude flag that merges KNOWN_IGNORE_PATHS + excluded_paths
    (
        'f\'--exclude="{",".join(bandit_excludes)}"\'',
        "f'--exclude={\",\".join(bandit_excludes)}'",
    ),
)

BACKUP_SUFFIX = ".pre-quoting-patch.bak"


def find_scanner_dir() -> Path:
    spec = importlib.util.find_spec("automated_security_helper")
    if spec is None or spec.origin is None:
        print(
            "ERROR: automated_security_helper is not importable from this Python. "
            "Ensure ASH is installed (`pip install automated-security-helper`) "
            "and you are running this script with the same Python interpreter.",
            file=sys.stderr,
        )
        sys.exit(1)
    return Path(spec.origin).parent / "plugin_modules" / "ash_builtin" / "scanners"


def patch_file(path: Path) -> bool:
    """Patch `path` in place. Returns True if content changed, False if already patched."""
    src = path.read_text()
    original = src
    for old, new in REPLACEMENTS:
        if old in src:
            src = src.replace(old, new)

    if src == original:
        return False

    backup = path.with_suffix(path.suffix + BACKUP_SUFFIX)
    if not backup.exists():
        backup.write_text(original)
    path.write_text(src)
    return True


def main() -> int:
    scanner_dir = find_scanner_dir()
    if not scanner_dir.is_dir():
        print(
            f"ERROR: expected scanner directory not found at {scanner_dir}",
            file=sys.stderr,
        )
        return 2

    print(f"Patching ASH scanners under {scanner_dir}")
    any_changed = False
    for scanner in SCANNERS:
        target = scanner_dir / scanner
        if not target.exists():
            print(f"  skip {scanner}: not present")
            continue
        changed = patch_file(target)
        if changed:
            print(f"  patched {scanner}")
            any_changed = True
        else:
            # Either already patched or patterns not found; verify that at
            # least one pattern is absent (i.e. the replacement is present)
            content = target.read_text()
            if any(new in content for _, new in REPLACEMENTS):
                print(f"  already patched {scanner}")
            else:
                print(
                    f"ERROR: {scanner} contents match neither the original " "nor the patched form; refusing to proceed.",
                    file=sys.stderr,
                )
                return 2

    print("Done." if any_changed else "No changes needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
