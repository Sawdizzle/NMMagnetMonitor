#!/bin/bash
# Deploy a regenerated MagMon collector to ONE host, whatever it runs.
#
#   ./deploy-collector.sh <user>@<host>            # deploy
#   ./deploy-collector.sh <user>@<host> --dry-run  # look, change nothing
#
# Put the generated nm-magmon-gateway-<ASSET>.py files (one per asset, from
# Admin -> Get install script, or generated in bulk) in the SAME DIRECTORY as
# this script. It deploys whichever of them that host turns out to run.
#
# Written for the 2026-09-04 parser rollout and kept because every awkward
# thing it works around cost an hour to find. See the comments inline: sudo
# tickets are per-terminal, scp is not available everywhere it looks like it
# should be, and a password prompt inside a pipe is invisible.
#
# It asks the HOST which assets it runs rather than trusting a list, so a Pi
# that turns out to run two collectors gets both, and a host that runs none says
# so instead of having a script pushed at it. A shared server is the same
# command as a standalone Pi.
#
# It touches exactly three things per asset: /opt/magmon-gateway-<ASSET>.py, a
# .bak beside it, and a systemctl restart. It does NOT touch cron, legacy
# magmon_collect_* scripts, the systemd unit file, or the environmental
# collector — leave those alone.
#
# One password prompt per host: the first connection is kept open and reused.

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-}"
MODE="${2:-}"
[ -z "$TARGET" ] && { echo "usage: $0 <user>@<host> [--dry-run]"; exit 2; }

SSH_USER="${TARGET%@*}"
CTL="/tmp/nmdeploy-$$"
SSHO="-o ControlMaster=auto -o ControlPath=$CTL -o ControlPersist=10m -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"

cleanup() { ssh -O exit -o ControlPath="$CTL" "$TARGET" 2>/dev/null; }
trap cleanup EXIT

echo "=== $TARGET ==="
ssh $SSHO "$TARGET" true || { echo "  cannot connect — skipping this host"; exit 1; }

SERVICES=$(ssh $SSHO "$TARGET" \
  "systemctl list-unit-files 'nm-magmon-gateway-*.service' --no-pager --plain --no-legend 2>/dev/null | awk '{print \$1}' | sed 's/\.service\$//'")

if [ -z "$SERVICES" ]; then
  echo "  no MagMon collector services installed here — nothing to do"
  exit 0
fi

for svc in $SERVICES; do
  asset="${svc#nm-magmon-gateway-}"
  src="$DIR/nm-magmon-gateway-$asset.py"

  if [ ! -f "$src" ]; then
    echo "  $asset: SKIP — no script staged for it (already current, or not an MRI unit)"
    continue
  fi

  before=$(ssh $SSHO "$TARGET" \
    "grep -m1 '^COLLECTOR_VERSION' /opt/magmon-gateway-$asset.py 2>/dev/null | cut -d'\"' -f2")
  # The unit is the authority on which account the collector runs as; the login
  # user is not always the same account.
  svcuser=$(ssh $SSHO "$TARGET" \
    "systemctl cat $svc 2>/dev/null | grep -m1 '^User=' | cut -d= -f2")
  [ -z "$svcuser" ] && svcuser="$SSH_USER"

  if [ "$MODE" = "--dry-run" ]; then
    echo "  $asset: would deploy (running ${before:-unknown}, service user $svcuser)"
    continue
  fi

  echo "  $asset: deploying (was ${before:-unknown}) ..."

  # TWO calls, split by what each one needs, because sudo caches its credential
  # PER TERMINAL: a `sudo -v` on one pty does nothing for a later pty-less
  # session, which is what made every install here fail with "a terminal is
  # required to read the password".
  #
  # 1. THE COPY needs stdin and no privileges. No pty — a pty would translate
  #    newlines and corrupt the Python file arriving on stdin. BatchMode so a
  #    connection problem fails immediately instead of waiting on a password
  #    prompt that has nowhere to appear. Sent with cat rather than scp: scp
  #    speaks an SFTP subsystem the shared server would not write to the login
  #    home with (owned by uid 777, not the login user) and then hung on /tmp.
  if ! ssh $SSHO -o BatchMode=yes "$TARGET" \
       "umask 077 && cat > /tmp/nm-magmon-gateway-$asset.py" < "$src"; then
    echo "  $asset: FAILED — copy did not complete, nothing changed"
    continue
  fi

  # 2. THE INSTALL needs sudo and therefore a terminal. Deliberately NOT piped
  #    through sed: piping hides the password prompt, and an invisible prompt is
  #    what "it just hung" looks like from the outside. Expect one prompt per
  #    asset — sudo's ticket does not survive across ptys.
  ssh -t $SSHO "$TARGET" "
    set -e
    sudo cp -n /opt/magmon-gateway-$asset.py /opt/magmon-gateway-$asset.py.bak 2>/dev/null || true
    sudo install -o $svcuser -g \"\$(id -gn $svcuser)\" -m 700 \
      /tmp/nm-magmon-gateway-$asset.py /opt/magmon-gateway-$asset.py
    sudo systemctl restart $svc
    sleep 12
    systemctl is-active $svc
    journalctl -u $svc -n 4 --no-pager | grep -E 'starting for asset|reported|Traceback|Error' | tail -2
    rm -f /tmp/nm-magmon-gateway-$asset.py
  "
  if [ "$?" != "0" ]; then
    echo "  $asset: FAILED — see above. The .bak (if any) is untouched at /opt/magmon-gateway-$asset.py.bak"
  fi
done

cat <<EOM

  Done with $TARGET.
  Each asset should show 'active' and a startup line reading v2026.09.04-1.
  The first cycle after a restart reports 1 sample by design; the SECOND one,
  five minutes later, should report about 5.
  To undo one:  sudo cp /opt/magmon-gateway-<ASSET>.py.bak /opt/magmon-gateway-<ASSET>.py && sudo systemctl restart nm-magmon-gateway-<ASSET>
EOM
