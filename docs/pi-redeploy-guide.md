# Gateway deploy runbook — per-asset script + systemd unit

Every download is now **per-asset and self-contained**: its own script
(`/opt/magmon-gateway-<asset>.py`), its own service
(`nm-magmon-gateway-<asset>.service`), its own lock file, and its own log tag
(`magmon-<asset>`). So this one procedure covers **both** cases:

- a **standalone Raspberry Pi** running a single asset, and
- a **shared server** (e.g. one reaching several sites over a VPN) running many.

The only per-machine difference is the **service user**, which you set in the
admin panel before downloading.

> Each asset's script carries that asset's unique gateway token and its MagMon's
> IP/credentials. Never install one asset's files on the wrong machine. The
> filenames include the asset name to keep them straight.

Legend: replace `<asset>` with the asset name (e.g. `CA1012`), `<user>` with the
login user on the target machine, `<host>` with its address. "**On your Mac**" vs
"**On the machine**" says where each command runs.

---

## 0. Set the service user, then download (On your Mac, in the web app)

1. **Admin → Existing assets →** the asset **→ Get install script**.
2. In the script panel, set **Service user**:
   - `pi` for a standalone Raspberry Pi (the default), or
   - the login user of the shared server (e.g. `Numed`) — check it with `whoami`
     on that machine if unsure.
3. Set the poll interval if needed, click **Regenerate**, then **Download script**
   and **Download systemd unit**. You now have in `~/Downloads`:
   - `nm-magmon-gateway-<asset>.py`
   - `nm-magmon-gateway-<asset>.service`  ← already has the right `User=` and path

Repeat for every asset you're deploying (each is its own pair of files).

## 1. Copy the files over (On your Mac)

```
scp ~/Downloads/nm-magmon-gateway-<asset>.py      <user>@<host>:/home/<user>/
scp ~/Downloads/nm-magmon-gateway-<asset>.service <user>@<host>:/home/<user>/
```

## 2. Connect (On your Mac)

```
ssh <user>@<host>
```

Everything below runs **On the machine**.

## 3. Install the HTTP library — once per machine (not per asset)

```
sudo apt-get update && sudo apt-get install -y python3-requests
```

## 4. Install one asset

The downloaded `.service` is already correct, so there is **no file to edit** —
install, copy, enable:

```
sudo install -o <user> -g "$(id -gn <user>)" -m 700 \
  /home/<user>/nm-magmon-gateway-<asset>.py /opt/magmon-gateway-<asset>.py

sudo cp /home/<user>/nm-magmon-gateway-<asset>.service \
        /etc/systemd/system/nm-magmon-gateway-<asset>.service

sudo systemctl daemon-reload
sudo systemctl enable --now nm-magmon-gateway-<asset>
```

## 5. Verify this asset — all must pass

```
systemctl status nm-magmon-gateway-<asset> --no-pager      # active (running)
journalctl -u nm-magmon-gateway-<asset> -n 30 --no-pager   # "reported OK", no errors
pgrep -c -f magmon-gateway-<asset>                          # prints 1
```

…and the asset flips to **online** in the dashboard within a couple of minutes.

## 6. Tidy up (optional)

```
rm -f /home/<user>/nm-magmon-gateway-<asset>.py /home/<user>/nm-magmon-gateway-<asset>.service
```

---

## Shared server — several assets on one box

Same steps, repeated per asset. Do **step 3 once**, then loop steps 1/4/5 for each
asset. Example for the VPN server hosting CA1012, NM1003, NM1019, NM1027, NM1034,
NM1037 (service user `Numed`):

```
# once
sudo apt-get update && sudo apt-get install -y python3-requests

# per asset — set ASSET and repeat the block for each of the six
ASSET=CA1012
USER=Numed
sudo install -o "$USER" -g "$(id -gn "$USER")" -m 700 \
  /home/$USER/nm-magmon-gateway-$ASSET.py /opt/magmon-gateway-$ASSET.py
sudo cp /home/$USER/nm-magmon-gateway-$ASSET.service \
        /etc/systemd/system/nm-magmon-gateway-$ASSET.service
sudo systemctl daemon-reload
sudo systemctl enable --now nm-magmon-gateway-$ASSET
```

Check the whole box once all six are in:

```
systemctl list-units 'nm-magmon-gateway-*' --no-pager   # six, all running
pgrep -c -f magmon-gateway                              # prints 6
```

**Before you wire up a shared server, confirm routing:** each MagMon must be
reachable *from this server* at a distinct address (the `monitor_host` set on each
asset). If two sites reuse the same private subnet behind the tunnel, they'll
collide — give them distinct routes/NAT first.

---

## Migrating a Pi that already runs the OLD single-name service

Earlier builds installed a fixed `nm-magmon-gateway.service` at
`/opt/magmon-gateway.py`. If a machine still has that, remove it **before**
installing the per-asset version, or you'll run two collectors at once:

```
sudo systemctl disable --now nm-magmon-gateway
sudo rm -f /etc/systemd/system/nm-magmon-gateway.service /opt/magmon-gateway.py
sudo rm -f /var/lock/nm-magmon-gateway-*.lock
sudo systemctl daemon-reload
```

Then follow steps 3–5 above.

---

## If a check fails

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'requests'` | Step 3 skipped | Run step 3, then `sudo systemctl restart nm-magmon-gateway-<asset>` |
| `Permission denied` on `/opt/magmon-gateway-<asset>.py` | Wrong owner/mode | Re-run the `install` in step 4 exactly |
| Service state `217/USER` | The `Service user` you set doesn't exist on this machine | Confirm with `whoami`; re-download with the correct user, or edit `User=` in the unit and re-run steps 4–5 |
| `another copy already holds the lock` (repeating) | A real second copy is running | `pgrep -a -f magmon-gateway-<asset>` → `sudo kill <pids>`; ensure no cron; restart |
| `Cannot reach MagMon at <ip>:<port>` | Wrong/unroutable MagMon IP for this site | Fix the asset's IP in **Admin → Edit**, re-download, redo from step 4 |
| Asset still offline after a few minutes | Token mismatch (e.g. token was rotated) | Re-download the current script for this asset and redo from step 4 |

## Rolling out

Canary **one** asset through step 5 with all checks green **and** the dashboard
showing it online before doing the rest. Keep a checklist: `asset → machine → done ✅`.
Download fresh per asset — never reuse one machine's file on another.
