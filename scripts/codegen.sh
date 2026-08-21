#!/usr/bin/env bash
# Generate gRPC stubs for both languages from the one .proto.
#
# grpc_tools.protoc IS protoc, so it can also drive the ts-proto plugin — which
# avoids installing a separate protoc toolchain just to emit TypeScript.
set -euo pipefail
cd "$(dirname "$0")/.."

PROTO_DIR="packages/schema"
PROTO="extractor.proto"

echo "  python -> apps/extractor/app/gen/"
(cd apps/extractor && uv run --frozen python -m grpc_tools.protoc \
  -I "../../$PROTO_DIR" \
  --python_out=app/gen \
  --pyi_out=app/gen \
  --grpc_python_out=app/gen \
  "$PROTO")

# grpc_python_out emits `import extractor_pb2` — a bare top-level import that
# only resolves if the gen directory is on sys.path. Rewrite it to a package
# relative import so `app.gen` works as an ordinary package.
python3 - <<'PY'
import pathlib, re
p = pathlib.Path("apps/extractor/app/gen/extractor_pb2_grpc.py")
s = p.read_text()
s = re.sub(r"^import extractor_pb2 as", "from . import extractor_pb2 as", s, flags=re.M)
p.write_text(s)
PY
touch apps/extractor/app/gen/__init__.py

echo "  typescript -> packages/schema/src/gen/"
(cd apps/extractor && uv run --frozen python -m grpc_tools.protoc \
  -I "../../$PROTO_DIR" \
  --plugin=protoc-gen-ts_proto="../../packages/schema/node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="../../packages/schema/src/gen" \
  --ts_proto_opt=esModuleInterop=true,outputServices=generic-definitions,useExactTypes=false \
  "$PROTO")

echo "  done"
