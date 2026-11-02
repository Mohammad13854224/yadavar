"""
Test helper: runs the unmodified Anki backend on a throw-away collection and answers raw backend calls from stdin
(one per line: "service method base64-request" -> "ok base64-response" or "err base64-error").
No network involved; the TypeScript engine is tested against it from Node (tools/engine-test).
"""
import base64
import sys

from anki import generic_pb2
from anki.collection import Collection

col = Collection(sys.argv[1])
backend = col._backend._backend
print("ready", flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    if line == "quit":
        break
    parts = line.split(" ")
    svc, meth, data = parts[0], parts[1], (parts[2] if len(parts) > 2 else "")
    try:
        raw = base64.b64decode(data)
        if (int(svc), int(meth)) == (15, 4):
            # AnkiDroid's RunDbCommand: the desktop library exposes the same thing as a separate entry point
            req = generic_pb2.Json()
            req.ParseFromString(raw)
            out = generic_pb2.Json(json=bytes(backend.db_command(req.json))).SerializeToString()
        else:
            out = backend.command(int(svc), int(meth), raw)
        print("ok " + base64.b64encode(bytes(out)).decode(), flush=True)
    except Exception as e:  # noqa: BLE001
        err = bytes(e.args[0]) if e.args and isinstance(e.args[0], (bytes, bytearray)) else str(e).encode()
        print("err " + base64.b64encode(err).decode(), flush=True)
col.close()
