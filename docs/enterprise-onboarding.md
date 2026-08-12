# Enterprise onboarding — Numed / Microsoft 365

Internal prep for the Numed conversation. A shareable one-page version is
published as an Artifact; this is the version-controlled source of the same
content.

**Recommended stance:** keep the app running free on **Vercel + Supabase**, and
integrate deeply with **Microsoft 365** for identity, email, and Teams — so it
reads as a Numed-owned system **without re-platforming into Azure**.

> "Put it in 365" hides two independent questions: *where it runs* and *which
> Microsoft services it plugs into*. The full integration can happen without
> moving the infrastructure.

## Architecture at a glance

| Zone | Pieces | Status |
|------|--------|--------|
| **Data** | Pi gateways at each site → Supabase Postgres (telemetry, 7-day retention) | stays |
| **App** | Vercel (Next.js: dashboard, TV mode, admin) + Supabase Edge (alert evaluator + notifier) | stays, $0 hosting |
| **Microsoft 365** | Entra ID (SSO), Graph API (email as numedinc.com), Teams (alerts + embedded tab) | integrate |

## The "numedified" layer

All four are HTTPS/OAuth integrations that run fine from Vercel + Supabase — none
require Azure hosting. The first three depend on **one Entra app registration**
that Numed IT creates and grants admin consent to.

1. **Microsoft sign-in (Entra ID SSO) — the keystone.** Staff sign in with their
   Numed accounts; IT manages access from the directory; MFA/conditional access
   come for free. Supabase supports Entra as a login provider, so it's a swap,
   not a rebuild. **Replaces the PIN login and closes the PIN brute-force gap
   (architecture review F-4).** Effort: medium.
2. **Email via Microsoft Graph.** Alerts sent through Numed's own M365, *from* a
   real numedinc.com mailbox — best deliverability, no third-party sender, no
   domain to verify. The notifier we built swaps its send call for Graph
   `sendMail`. Replaces Resend. Uses existing M365 (no new cost). Effort: low–med.
3. **Teams alerts & dashboard tab.** Post alerts to a channel via a Power Automate
   **Workflow** (the current replacement for retired webhooks), and pin the live
   dashboard as a **Teams tab**. Additive; SSO makes the tab seamless. Effort: medium.
4. **SharePoint & records (optional, later).** Weekly reports / incident exports
   can land in a governed SharePoint library through the same Graph app. Not
   needed for launch. Effort: low.

## Stays / changes / must-harden

- **Stays:** Vercel + Supabase hosting and data pipeline; Pi collection; the
  dashboard, TV mode, forecasting, and alert engine already built; $0 core hosting.
- **Changes / integrates:** PIN login → Entra SSO; Resend → Graph email; add Teams;
  roles map from Entra groups.
- **Must be hardened first (regardless of the Microsoft pieces):** telemetry is
  currently readable with the public anon key (architecture review **F-1**) — fine
  for today's single-site rollout, **not** for a corporate system. Lock it down so
  data is readable only to signed-in Numed users. This **pairs naturally with the
  SSO work**.

## Cost reality

Runs free today and can keep running free. But a *sanctioned, commercial*
deployment usually nudges two services onto paid tiers — not because it won't
work, but because IT/licensing generally require it. Even then it's negligible.

| Service | Role | Today | Formalized | Why it might change |
|---------|------|-------|------------|---------------------|
| Vercel | Frontend hosting | $0 | ~$20/mo | Hobby tier is **non-commercial**; a company deployment needs Pro |
| Supabase | Database + logic | $0 | ~$25/mo | Pro adds daily backups & removes the inactivity-pause risk |
| Microsoft Graph | Email / Teams / SSO | — | $0* | Included in Numed's existing Microsoft 365 |
| Resend | Email (interim) | $0 | dropped | Superseded by Graph |
| **Realistic sanctioned run-rate** | | **$0** | **~$45/mo** | *no incremental Microsoft cost |

## Decisions to get from Numed

1. **Hosting (the big one).** Accept Vercel + Supabase (US-hosted), or must the app
   live inside Numed's Azure tenant? This decides whether the whole plan holds or
   becomes a re-platform.
2. **Identity.** Entra ID SSO — almost certainly yes. Who creates the app
   registration and grants admin consent?
3. **Email.** Which numedinc.com mailbox / display name should alerts come from?
4. **Security & data.** Who signs off on the security review, and are there
   data-residency rules affecting where Supabase lives?

## A sensible sequence (assuming "keep it on Vercel + Supabase")

Each phase is independently shippable.

1. **Entra SSO + data lockdown** — swap PIN login for Microsoft sign-in and, in the
   same pass, make telemetry readable only to signed-in Numed users. Identity +
   security hardening together.
2. **Graph email** — point the notifier at Microsoft Graph; alerts arrive from
   numedinc.com. Retire Resend.
3. **Teams** — channel alerts via a Workflow + the dashboard as a Teams tab.
4. **Optional polish** — SharePoint exports, per-site access scoping, whatever IT
   asks for during review.

---

*Figures are planning estimates; Microsoft costs assume existing Microsoft 365
licensing. See also `docs/alerting-plan.md` and the architecture review findings
(F-1 public-read RLS, F-4 PIN auth).*
