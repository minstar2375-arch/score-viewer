#!/bin/bash
# 더블클릭하면 악보함을 실행합니다. 끝내려면 이 터미널 창을 닫으세요.
cd "$(dirname "$0")" || exit 1
PORT=8791
(sleep 1; open "http://localhost:$PORT/") &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
