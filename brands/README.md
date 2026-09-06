# Brand assets

The HACS card icon and the Home Assistant "Devices & Services" icon are **not**
served from this repo. Both clients load them from the external
[`home-assistant/brands`](https://github.com/home-assistant/brands) repo at
`https://brands.home-assistant.io/life180/icon.png`. Until `life180` is added
there, HACS and HA show a generic fallback icon.

## Files here

`custom_integrations/life180/` mirrors the target path in the brands repo:

| file | size | purpose |
| --- | --- | --- |
| `icon.png` | 256×256 | the `@` mark, brand blue `#00A0E3`, transparent |
| `icon@2x.png` | 512×512 | hi-dpi variant |

They match `www/favicon.png` and the `mdi:at` sidebar icon.

## How to ship it

1. Fork `home-assistant/brands`.
2. Copy `custom_integrations/life180/` from here into the fork at the same path.
3. Open a PR. The brands CI runs `python3 -m script.hassfest` and an image
   check; if it flags optimization, run the PNGs through `oxipng`/`pngquant`.
4. Once merged, the icon propagates to `brands.home-assistant.io` and both HACS
   and HA pick it up (may take a cache cycle).

This integration registers no HA devices or entities, so there is no
per-device icon to set beyond the brands icon.
