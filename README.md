# Life180

A [Home Assistant](https://www.home-assistant.io/) custom integration that shows
your registered people on a map and lets you review where they have been.

- **Live map** of every Home Assistant `person` that has a device tracker.
- **Zones** you can draw, move, resize, and colour on the map (they become
  real Home Assistant zones).
- **Position filter**: pick a person and a date range to get their track,
  automatic stop detection, and a per-zone summary. Export to CSV, XLSX, KML,
  or PDF.
- Ships a sidebar **panel**, a Lovelace **card**, and an automation
  **blueprint** for zone enter/leave alerts.

Positions come from Home Assistant itself — install and configure a device
tracker (the Home Assistant companion app, OwnTracks, GPSLogger, Traccar, …)
and assign its device to a person.

## Install

1. Add this repository to [HACS](https://hacs.xyz/) as a custom integration
   repository, then install **Life180**.
2. Restart Home Assistant.
3. **Settings → Devices & Services → Add Integration → Life180**, adjust the
   options, and submit.

Open it from the sidebar, or at `https://<your-ha-host>/life180/index.html`.

## Notes

- All distances are in **feet** and speeds in **mph**.
- Requires Home Assistant to be reachable over **HTTPS**.
- This is a fork of [ha-tracker](https://github.com/vgcouso/ha-tracker) by
  Víctor González Couso, rebranded and reworked.
