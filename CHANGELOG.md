# Changelog

## 1.1.0

- Readiness check before every capture: engine calculation of every object, no visible loading indicator, images loaded, canvas charts drawn, and a stable rendering (canvas pixels included) for about 1.2 s.
- New settings: maximum wait per sheet, and behaviour when a sheet is not ready in time (capture with a warning, or skip).
- Fix: visibility detection when the computed opacity is not a number.

## 1.0.0

- First release: thumbnail generation for the current sheet or for all sheets, upload to the app media library through the QRS API, automatic cleanup of previous thumbnails.
