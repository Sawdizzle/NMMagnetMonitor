# Pi redeploy runbook — new gateway script + systemd unit

Foolproof, copy-paste steps to move one Raspberry Pi from the old (root) collector
to the new one that runs as the **`pi`** user. Do **one Pi end-to-end as a canary**,
confirm every check is green, then repeat for the rest.

> Each asset has its **own** script — it carries that asset's unique gateway token
> and its MagMon's IP/credentials. Never install one asset's script on a different
> Pi. The filename includes the asset name to keep them straight.

Legend: replace `<asset>` with the asset name (e.g. `CA1012-SETONSW`) and `<pi-ip>`
with the Pi's address. "**On your Mac**" vs "**On the Pi**" tells you where each
command runs.

---

## 0. Download the two files (On your Mac, in the web app)

1. **Admin → Existing assets →** the asset **→ Get install script**.
2. Set the poll interval if needed, then **Download script** and **Download systemd unit**.
3. You now have, in `~/Downloads`:
   - `nm-magmon-gateway-<asset>.py`
   - `nm-magmon-gateway-<asset>.service`

## 1. Copy them to the Pi (On your Mac)

```
scp ~/Downloads/nm-magmon-gateway-<asset>.py      pi@<pi-ip>:/home/pi/
scp ~/Downloads/nm-magmon-gateway-<asset>.service pi@<pi-ip>:/home/pi/
```

(No SSH/scp? Put both files on a USB stick and copy them into `/home/pi/` on the Pi.)

## 2. Connect to the Pi (On your Mac)

```
ssh pi@<pi-ip>
```

Everything below runs **On the Pi**.

## 3. Stop the old collector

```
sudo systemctl stop nm-magmon-gateway
```

## 4. Clear any stale lock (belt-and-suspenders)

The new script self-heals around a leftover root-owned lock, so this is optional —
but it keeps the logs clean:

```
sudo rm -f /var/lock/nm-magmon-gateway-*.lock
```

## 5. Make sure the HTTP library is installed (new apt method)

```
sudo apt-get update && sudo apt-get install -y python3-requests
```

## 6. Install the new script — owned by `pi`, mode 700

```
sudo install -o pi -g pi -m 700 /home/pi/nm-magmon-gateway-<asset>.py /opt/magmon-gateway.py
```

## 7. Install the new systemd unit

It always lands as `nm-magmon-gateway.service`, regardless of the download name:

```
sudo cp /home/pi/nm-magmon-gateway-<asset>.service /etc/systemd/system/nm-magmon-gateway.service
```

## 8. Reload and start

```
sudo systemctl daemon-reload
sudo systemctl enable --now nm-magmon-gateway
```

---

## 9. VERIFY — all four must pass before you move on

```
# a) Service is running (look for "active (running)", not "activating"/"failed")
systemctl status nm-magmon-gateway --no-pager

# b) Logs show a successful report and NO lock complaint
journalctl -u nm-magmon-gateway -n 40 --no-pager
#    WANT: "starting for asset '<asset>'..." then "reported OK: ..."
#    NOT:  "another copy already holds the lock" repeating

# c) Exactly one process
pgrep -c -f nm-magmon-gateway        # must print: 1

# d) It is running as pi, and cron is clean
ps -o user= -p "$(pgrep -f magmon-gateway | head -1)"   # must print: pi
crontab -l 2>/dev/null | grep -i magmon || echo "user cron clean"
sudo crontab -l 2>/dev/null | grep -i magmon || echo "root cron clean"
```

Then check the **web dashboard**: the asset should flip to **online** within a
couple of minutes (its last-seen resets on the first successful report).

## 10. Tidy up (optional)

The token-bearing script now lives at `/opt/magmon-gateway.py` (mode 700). Remove
the copies left in the home directory so there's no world-readable copy of the token:

```
rm -f /home/pi/nm-magmon-gateway-<asset>.py /home/pi/nm-magmon-gateway-<asset>.service
```

---

## If a check fails

| Symptom (in `journalctl` / `status`) | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'requests'` | Step 5 skipped | Run step 5, then `sudo systemctl restart nm-magmon-gateway` |
| `Permission denied` opening `/opt/magmon-gateway.py` | Wrong owner/mode | Re-run step 6 exactly |
| Service state `217/USER` or "user pi does not exist" | This Pi's login user isn't `pi` | Edit `/etc/systemd/system/nm-magmon-gateway.service`: set `User=` and `Group=` to the real user; re-run step 6 with `-o <user> -g <user>`; then steps 8–9 |
| `another copy already holds the lock` (repeating) | A real second copy is running | `pgrep -a -f magmon-gateway` → `sudo kill <pids>`; make sure no cron entry exists; `sudo systemctl restart nm-magmon-gateway` |
| `Cannot reach MagMon at <ip>:<port>` | Wrong MagMon IP/port for this site | Fix the asset's IP in **Admin → Edit**, re-download the script (step 0), redo from step 6 |
| Asset still offline after a few minutes | Token mismatch (e.g. token was rotated) | Re-download the current script for this asset and redo from step 6 |

## Rolling out to the rest

- Canary **one** Pi through step 9 with all checks green **and** the dashboard
  showing it online before touching any others.
- Keep a simple checklist: `asset name → Pi IP → done ✅`.
- Repeat steps 0–10 per Pi. Because each script is asset-specific, download fresh
  per asset — don't reuse one Pi's file on another.
