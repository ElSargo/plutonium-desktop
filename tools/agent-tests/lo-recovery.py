#!/usr/bin/env python3
"""The Flatpak LibreOffice's crash recovery list, which the tests share with
the user (one profile per user). run.sh kills the tester's LibreOffice with
unsaved documents, and the next run would open them recovered.

  lo-recovery.py list              the entries, one per line: name, title, file
  lo-recovery.py drop-new BEFORE   drop the entries not named in BEFORE (the
                                   output of list before the run), and their
                                   backup files

Only edit while LibreOffice isn't running: it writes the file back on exit.
"""
import os
import re
import subprocess
import sys
from urllib.parse import unquote, urlparse

USER = os.path.expanduser("~/.var/app/org.libreoffice.LibreOffice/config/libreoffice/4/user")
XCU = os.path.join(USER, "registrymodifications.xcu")
ITEM = '<item oor:path="/org.openoffice.Office.Recovery/RecoveryList">'


def entries(lines):
    for i, line in enumerate(lines):
        if not line.startswith(ITEM):
            continue
        name = re.search(r'<node oor:name="([^"]+)"', line)
        title = re.search(r'oor:name="Title"[^>]*><value>([^<]*)', line)
        temp = re.search(r'oor:name="TempURL"[^>]*><value>([^<]*)', line)
        yield i, name and name[1], title and title[1], temp and temp[1]


def running():
    return subprocess.run(["pgrep", "-x", "soffice.bin"], capture_output=True).returncode == 0


def main():
    if not os.path.exists(XCU):
        return
    lines = open(XCU, encoding="utf-8").read().split("\n")
    if sys.argv[1:2] == ["list"]:
        for _, name, title, temp in entries(lines):
            print(f"{name}\t{title}\t{temp}")
    elif sys.argv[1:2] == ["drop-new"] and len(sys.argv) == 3:
        if running():
            sys.exit("LibreOffice is running; not touching its recovery list")
        before = {line.split("\t")[0] for line in open(sys.argv[2], encoding="utf-8") if line.strip()}
        drop = [(i, name, title, temp) for i, name, title, temp in entries(lines) if name not in before]
        for _, name, title, temp in drop:
            path = temp and unquote(urlparse(temp).path)
            if path and os.path.dirname(path) == os.path.join(USER, "backup") and os.path.exists(path):
                os.remove(path)
            print(f"dropped LibreOffice recovery entry {name} ({title})")
        if drop:
            gone = {i for i, *_ in drop}
            tmp = XCU + ".agent-tests"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(line for i, line in enumerate(lines) if i not in gone))
            os.replace(tmp, XCU)
    else:
        sys.exit(__doc__)


main()
