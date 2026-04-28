#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

MODE="${MODE:-proxy}"
PAC_URL="${PAC_URL:-http://127.0.0.1/proxy.pac}"
ADDRESS="${ADDRESS:-0.0.0.0}"
FORCE_HOST="${FORCE_HOST:-36.248.75.39}"
PORTS="${PORTS:-80:443}"
ACTIVE_ONLY="${ACTIVE_ONLY:-1}"
TRUST_CA="${TRUST_CA:-0}"

HOSTS_BEGIN="# BEGIN UnblockNeteaseMusic"
HOSTS_END="# END UnblockNeteaseMusic"
HOSTS_DOMAINS="music.163.com interface.music.163.com interface3.music.163.com"

SERVER_PID=""
_CLEANED=0

usage() {
  cat <<'EOF'
用法:
  ./run.sh [--mode proxy|hosts|pac]

模式:
  proxy  显式 HTTP/HTTPS 系统代理（推荐网易云 macOS 客户端）
  hosts  写 /etc/hosts 强制域名到本机
  pac    系统 PAC（适合浏览器/网页）

环境变量:
  FORCE_HOST=36.248.75.39
  ADDRESS=0.0.0.0
  PORTS=80:443
  PAC_URL=http://127.0.0.1/proxy.pac
  ACTIVE_ONLY=1
  TRUST_CA=0
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      [ "$#" -ge 2 ] || {
        echo "--mode 需要参数: proxy、hosts 或 pac" >&2
        exit 1
      }
      MODE="$2"
      shift 2
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage
      exit 1
      ;;
  esac
done

case "$MODE" in
  proxy|hosts|pac) ;;
  *)
    echo "--mode 只能是 proxy、hosts 或 pac。" >&2
    exit 1
    ;;
esac

list_services() {
  networksetup -listallnetworkservices \
    | awk 'NR>1 && $0 !~ /^\*/ { print }'
}

default_device() {
  route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}'
}

service_for_device() {
  device="$1"
  [ -n "$device" ] || return 1
  networksetup -listnetworkserviceorder 2>/dev/null \
    | awk -v dev="$device" '
      /^\([0-9]+\)/ {
        line = $0
        sub(/^\([0-9]+\) /, "", line)
        service = line
        sub(/ \(Hardware Port:.*$/, "", service)
      }
      $0 ~ ("Device: " dev "\\)") {
        print service
        exit
      }
    '
}

resolve_services() {
  if [ "$ACTIVE_ONLY" = "1" ]; then
    dev="$(default_device || true)"
    service="$(service_for_device "${dev:-}" || true)"
    [ -n "${service:-}" ] || service="Wi-Fi"
    printf '%s\n' "$service"
  else
    list_services
  fi
}

services="$(resolve_services)"
[ -n "$services" ] || {
  echo "未找到可用网络服务。" >&2
  exit 1
}

check_ca_trust() {
  server_cert="$SCRIPT_DIR/server.crt"
  [ -f "$server_cert" ] || return 0
  security verify-cert -c "$server_cert" -p ssl -s music.163.com >/dev/null 2>&1
}

ensure_ca_trust() {
  ca_cert="$SCRIPT_DIR/ca.crt"
  [ -f "$ca_cert" ] || return 0

  if check_ca_trust; then
    echo "[OK] 证书已受系统 SSL 信任: $ca_cert"
    return 0
  fi

  echo "[WARN] ca.crt 尚未通过系统 SSL 信任校验，macOS 客户端 HTTPS 请求可能失败。"
  if [ "$TRUST_CA" = "1" ]; then
    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$ca_cert"
    echo "[OK] 已安装证书: $ca_cert"
  else
    echo "请先执行："
    echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"$ca_cert\""
    exit 1
  fi
}

flush_dns() {
  sudo dscacheutil -flushcache >/dev/null 2>&1 || true
  sudo killall -HUP mDNSResponder >/dev/null 2>&1 || true
}

install_hosts() {
  tmp="$(mktemp)"
  sudo awk -v begin="$HOSTS_BEGIN" -v end="$HOSTS_END" '
    $0 == begin {skip = 1; next}
    $0 == end {skip = 0; next}
    !skip {print}
  ' /etc/hosts > "$tmp"
  {
    echo "$HOSTS_BEGIN"
    for domain in $HOSTS_DOMAINS; do
      echo "127.0.0.1 $domain"
    done
    echo "$HOSTS_END"
  } >> "$tmp"
  sudo cp "$tmp" /etc/hosts
  rm -f "$tmp"
  flush_dns
}

remove_hosts() {
  tmp="$(mktemp)"
  sudo awk -v begin="$HOSTS_BEGIN" -v end="$HOSTS_END" '
    $0 == begin {skip = 1; next}
    $0 == end {skip = 0; next}
    !skip {print}
  ' /etc/hosts > "$tmp"
  sudo cp "$tmp" /etc/hosts
  rm -f "$tmp"
  flush_dns
}

run_for_services() {
  action="$1"
  runner="$2"
  echo "$services" | while IFS= read -r service; do
    [ -n "$service" ] || continue
    "$runner" "$action" "$service"
  done
}

pac_action() {
  action="$1"
  service="$2"
  case "$action" in
    start)
      networksetup -setautoproxyurl "$service" "$PAC_URL" >/dev/null 2>&1 || {
        echo "[SKIP] 无法开启 PAC: $service"
        return 0
      }
      networksetup -setautoproxystate "$service" on >/dev/null 2>&1 || {
        echo "[SKIP] 无法开启 PAC: $service"
        return 0
      }
      echo "[OK] 已开启 PAC: $service"
      ;;
    stop)
      networksetup -setautoproxystate "$service" off >/dev/null 2>&1 || true
      echo "[OK] 已关闭 PAC: $service"
      ;;
  esac
}

proxy_action() {
  action="$1"
  service="$2"
  http_port="${PORTS%%:*}"
  case "$action" in
    start)
      networksetup -setwebproxy "$service" 127.0.0.1 "$http_port" off >/dev/null 2>&1 || {
        echo "[SKIP] 无法开启 HTTP 代理: $service"
        return 0
      }
      networksetup -setsecurewebproxy "$service" 127.0.0.1 "$http_port" off >/dev/null 2>&1 || {
        echo "[SKIP] 无法开启 HTTPS 代理: $service"
        return 0
      }
      networksetup -setwebproxystate "$service" on >/dev/null 2>&1 || true
      networksetup -setsecurewebproxystate "$service" on >/dev/null 2>&1 || true
      echo "[OK] 已开启显式代理: $service"
      ;;
    stop)
      networksetup -setwebproxystate "$service" off >/dev/null 2>&1 || true
      networksetup -setsecurewebproxystate "$service" off >/dev/null 2>&1 || true
      echo "[OK] 已关闭显式代理: $service"
      ;;
  esac
}

print_diag() {
  echo
  echo "==> 诊断"
  echo "MODE=$MODE"
  echo "PAC_URL=$PAC_URL"
  echo "ADDRESS=$ADDRESS"
  echo "FORCE_HOST=$FORCE_HOST"
  echo "SERVICES:"
  echo "$services" | sed 's/^/  /'
  echo
  echo "$services" | while IFS= read -r service; do
    [ -n "$service" ] || continue
    echo "-- $service"
    networksetup -getautoproxyurl "$service" 2>/dev/null || true
    networksetup -getwebproxy "$service" 2>/dev/null || true
    networksetup -getsecurewebproxy "$service" 2>/dev/null || true
  done
}

wait_for_service() {
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -fsS --noproxy '*' "$PAC_URL" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.2
  done
  echo "UNM 未能在预期时间内就绪，请确认端口 $PORTS 未被占用。" >&2
  return 1
}

cleanup() {
  [ "$_CLEANED" -eq 1 ] && return 0
  _CLEANED=1

  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo
    echo "==> 正在停止 UNM..."
    kill "$SERVER_PID" 2>/dev/null || true
  fi

  echo
  echo "==> 正在恢复网络设置..."
  run_for_services stop proxy_action
  run_for_services stop pac_action
  if [ "$MODE" = "hosts" ]; then
    remove_hosts
    echo "[OK] 已清理 hosts"
  fi
}

echo "MODE=$MODE"
echo "PAC_URL=$PAC_URL"
echo "ADDRESS=$ADDRESS"
echo "FORCE_HOST=$FORCE_HOST"
echo

ensure_ca_trust
trap cleanup INT TERM EXIT

echo "==> 准备 sudo 权限..."
sudo -v

echo "==> 启动前清理旧代理状态..."
run_for_services stop proxy_action
run_for_services stop pac_action

if [ "$MODE" = "hosts" ]; then
  echo "==> 写入 hosts..."
  install_hosts
fi

echo
echo "==> 启动 UNM: sudo node app.js -a $ADDRESS -p $PORTS -f $FORCE_HOST"
(
  cd "$SCRIPT_DIR"
  sudo node app.js -a "$ADDRESS" -p "$PORTS" -f "$FORCE_HOST"
) &
SERVER_PID="$!"

echo "==> 等待 UNM 服务就绪..."
wait_for_service

case "$MODE" in
  pac)
    echo "==> 开启 PAC..."
    run_for_services start pac_action
    ;;
  proxy)
    echo "==> 开启显式 HTTP/HTTPS 代理..."
    run_for_services start proxy_action
    ;;
  hosts)
    echo "==> hosts 已启用，保持系统代理关闭。"
    ;;
esac

print_diag
echo
wait "$SERVER_PID"
