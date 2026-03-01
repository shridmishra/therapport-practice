# Kiosk Operations – Pimlico & Kensington

This document explains how the new in/out kiosk and admin presence features work, so the front‑desk team and practice admins can use them day‑to‑day.

## Kiosk tablets

- Each practice has its own kiosk URL:
  - Pimlico: `/kiosk/pimlico`
  - Kensington: `/kiosk/kensington`
- The kiosk is designed for a tablet mounted in the waiting area:
  - Large photo tiles for each practitioner.
  - Simple “In / Out” labels.
  - Scrollable list of therapists with a fixed Home bar at the bottom so navigation is always visible.

### Signing in

1. Therapist arrives at the practice.
2. On the kiosk for that location (Pimlico or Kensington), they find their tile.
3. They tap their tile and confirm “Sign in” when asked.
4. Their tile turns green with an “In” badge, and they appear as “working now” on:
   - The kiosk screen for that location.
   - The admin “Who is in now” boxes on the admin dashboard.

### Signing out

1. When leaving, the therapist finds their tile on the kiosk.
2. They tap their own photo/name.
3. They confirm “Sign out”.
4. Their tile returns to the “Out” state and they disappear from the current‑presence lists.

> Kensington dummy user
> The Kensington kiosk always shows a dummy user (Rober Assogioli) so female practitioners are not shown as lone working. This dummy account is always treated as “In” at Kensington and cannot be signed out from the kiosk. The backend resolves this user by the static email `rober.assogioli@therapport.co.uk`.

## Admin dashboard – who is currently in

On the admin dashboard, there is a “Who is in now” card:

- Two boxes:
  - Pimlico – all practitioners currently signed in at Pimlico.
  - Kensington – all practitioners currently signed in at Kensington (including the dummy user).
- Each entry shows:
  - Initials avatar.
  - Practitioner name.
- The **Refresh** button reloads the data from the server.

These boxes are read‑only snapshots of who is currently “In” on each kiosk, matching the behaviour seen in the existing Laravel admin.

## Admin kiosk logs (Kensington / Pimlico In‑Out)

The **Kiosk Logs** screen under the admin navigation replaces the old “Kensington In/Out” and “Pimlico In/Out” pages:

- Two tabs:
  - Kensington In/Out
  - Pimlico In/Out
- Each tab shows a table:
  - Name – therapist full name.
  - Location – Pimlico or Kensington.
  - Time – date and time of the action.
  - Status – “In” or “Out”.
- Filters:
  - Search by practitioner name.
  - Pagination controls for large histories.

This gives the same operational view as the old app’s attendance pages, but backed by the new `kiosk_logs` table in the Node/Express backend.

