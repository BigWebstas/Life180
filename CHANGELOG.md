# Changelog 

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).


## [0.0.36] - 2025-10-

### Changes
- The URL to connect to the Home Assistant server from a browser window is: https://HOST_1/life180/index.html and accepts 3 parameters:
  - debug=1: to avoid using minified JavaScript
  - haUrl=HOST_2: In case you need to connect to a host other than "HOST_1"
  - token=ll_token: Where "ll_token" is a long-lived token
  Example: http://HOST_1/custom_components/life180/www/index.html?debug=1&haUrl=HOST_2&token=ll_token
- Important: If there are multiple devices associated with a person, Life180 takes the first one #36

### Fixed
- Centering elements on the map on large screens


## [0.0.35] - 2025-10-12

### Changes
- In the filter screen we take the chart out of the positions tab and move it to its own tab

### Fixed
- Centering map elements for large screens
- If one of the last positions in the filter screen was selected, the scroll would move when changing tabs.


## [0.0.34] - 2025-10-09

### Changes
- 3D Map
  - When using a mouse, you need to right-click to rotate and tilt. On a smartphone, you can use two fingers.
  - It has the following buttons:
    - Zoom
    - Reset bearing to north
    - Search for locations
    - Switch between layers (OpenStreetMap, Esri, and OpenFreeMap)
- Traccar Server Integration #31

### Fixed
- Map closing after a few seconds on the filter screen
- Filter window closing after a few seconds


## [0.0.33] - 2025-10-02

### Changes
- Zone, on/off, and speed graph below the leaderboard on the Filter screen
- Implementation of an Anti-Spike System
- At the stops we adjust the coordinates to the center of the positions that form it
- Average speed only in motion and without stops
- If stopped the speed is 0
- Changing the /config/www/life180 folder to /config/custom_components/life180/www
- We have released the possibility of downloading MacroDroid
- Removed the ability to download GpsLogger and OwnTracks configurations
- Configured GpsLogger, OwnTracks, and Traccar Webhook URLs in Life180 options
- Updated translations
- Updated Readme.md

### Fixed
- Filter calendar on small screens
- Distance traveled by zone in the Filter screen summary


## [0.0.32] - 2025-09-21

### Changes
- Possibility to hide zones on the map of both Life180 and Home Assistant #29
- Possibility to change the color of Home Assistant zones
- Added Map and Type columns to the Zones screen
- The GPS accuracy in meters is configurable in the options
- The maximum speed of the positions is configurable in the options
- Some device trackers send negative speeds. We set them to 0.
- We round the battery level since some tracker devices send decimals.

### Fixed
- Calculating "Stopped Time" on the Summary tab of the Filter screen


## [0.0.31] - 2025-09-18

### Changes
- Removed the antispike 
- Modified the way stops are calculated
- Added "Open Location" to the Pop-Ups on the Zone and Filter screens

### Fixed
- DB accessed without Recorder executor when querying past location history #28
- Refresh the radius in zones when moving it
- Calculating "Total Time" and "Time per Zone" in the Zones screen summary


## [0.0.30] - 2025-09-15

### Changes
- Added a Custom Card #22
- Life180 GPT for ChatGPT (beta version)
- Added a blueprint for creating automations
- Integration with OnwTracks and GPSLogger as device trackers
- Integration with MacroDroid to resolve the issue of OwnTracks starting after rebooting the phone.
- In options, the name used in the URL to download the properties of the OnwTracks and GPSLogger integrations to the mobile
- Column with stops on the Positions tab of the Filter screen
- Column with Auto Filter on the Positions tab of the Filter screen
- The route with the filter positions on the map appears in green at the start and blue at the end.
- Measure distance on the Summary tab of the Filter screen
- Added a link in the user popup to show the position on Google Maps
- On the map you can search for places
- On the filter screen there are three buttons to filter positions for today, yesterday or custom between two dates and times
- Changed the way to obtain the Home Assistant token for panels and cards
- Minified Javascript in the dist/life180.js file
- Automatic versioning in index.html, styles.css and life180.js 
- Geocoding is now done on the server that caches the addresses
- Changed the default Alert, Confirm and Prompt windows
- Changed the date/time picker in the filter window 
- Zones can be assigned a color that will be used when drawing them on the map and as a background on table lines
- The name of the zones must be unique and its size must be less than 30 characters
- Possibility of exporting filters to various file formats
- Do not show users without device tracker #26
- Updated README.md with all the changes in this version

### Fixed
- If Life180 is not active, it does not update to save resources.
- Excessive page reloads in Life180 panel. Now not reload
- Notifications with: "Login attempt or request with invalid authentication..."
- Problems with some characters in zone names when creating and modifying zones
- OpenStreetMaps not showing tiles anymore, only message: https://wiki.openstreetmap.org/wiki/Blocked_tiles #27


## [0.0.29] - 2025-06-30

### Changes
- Changed the README.md file to update the update from HACS


## [0.0.28] - 2025-06-26

### Changes
- version for HACS


## [0.0.27] - 2025-06-26

### Changes
- version for HACS


## [0.0.26] - 2025-06-26

### Changes
- version for HACS


## [0.0.25] - 2025-06-07

### Fixed
- Reload of panel
- If the website is not active, it does not update to save resources.


## [0.0.24] - 2025-05-25

### Added
- If the website is not active, it does not update to save resources.
- Default Filter settings #8
- Use default theme colors #2
- Make the integration accessible only by admin or selected users  #7
- Dashboard menu integration #3
- Measurement unit options: imperial or metric #11

### Fixed
- Speed value is metres per second and not km/hr #14
- Support users with multiple trackers #12


## [0.0.23] - 2025-02-21

### Fixed
- No Users in the normal Person menu #6
- Object NoneType can't be used in 'await' expression #5


## [0.0.22] - 2025-02-20

### Fixed
- Life180 won't load after creating new zones #4
  (Zones with non-alphanumeric names)


## [0.0.21] - 2025-02-15

### Added
- Remove non-relevant positions when filtering.

### Fixed
- Installation from Home Assistant integration
- Register zones in Home assistant when integrating and unregister when uninstalled
- Token renewal


## [0.0.20] - 2025-02-08

### Added
- Version for HACS


## [0.0.19] - 2025-02-08

### Fixed
- Some bugs in instalation files


## [0.0.18] - 2025-02-08

### Fixed
- Some bugs in translations and instalation files


## [0.0.17] - 2025-02-08

### Added
- Files removed when integration is uninstalled
- Add Life180 Dashboard after installing the integration

### Fixed
- Getting addresses on the user screen


## [0.0.16] - 2025-02-06

### Added
- Sorting in tables.
- Installation from: "Settings &rarr; Devices and Services &rarr; Add Integration". 
- Icon in HACS and in Integrations
- Translations for the options configuration screen.
- Changed the installation process in README.md


## [0.0.15] - 2025-02-01

### Added
- We get the address from: https://nominatim.openstreetmap.org

### Fixed
- Installing the application


## [0.0.14] - 2025-01-31

### Added
- Battery on the user screen and popups
- Address on the user screen
- Changes in README.md
- Changes in css
- Changes in translations

### Fixed
- Every time Life180 was updated, the zones were deleted
- zIndex of the markers


## [0.0.13] - 2025-01-30

### Added
- New screen with Home Assistant users
- Adjust map zoom on startup
- We changed the text of the filter and popups with the users
- Added translations
- Changes in css

### Fixed
- Check the connection with Home Assistant
- The line **life180** of `configuration.yaml` in README.md


## [0.0.12] - 2025-01-27

### Added
- Added translations
- Changes in css

### Fixed
- Text in popups
- Images in README.md


## [0.0.11] - 2025-01-27

### Added
- Support for multiple languages
- Visual improvements

### Fixed
- Installation


## [0.0.1] - 2025-01-25

### Added
- First version of the project.
- Initial user interface with support for zones and filters.
- API for devices, filters and zones in Home Assistant.
