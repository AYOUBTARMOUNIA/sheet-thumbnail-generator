# Sheet Thumbnail Generator for Qlik Sense Enterprise on Windows

Generate real sheet thumbnails automatically in Qlik Sense Enterprise on Windows. No more grey placeholder previews, no more manual screenshots.

🇫🇷 [Version française](README.fr.md)

<!-- Add your demo GIF to docs/demo.gif, then remove the comment markers below. -->
<!-- ![Demo](docs/demo.gif) -->

## Why

Since its November 2025 update, Qlik Cloud generates sheet thumbnails automatically from the sheet's actual content. On client-managed Qlik Sense Enterprise on Windows (QSEoW), the official method is still to take a screenshot and upload it to each sheet by hand through the media library.

This extension brings the automatic workflow to QSEoW: drop it on a sheet, click once, and every sheet of the app gets a thumbnail that reflects its real layout.

## Features

- Generate the thumbnail of the current sheet, or of every sheet in a single run.
- Captures the real rendering of each sheet: theme, charts, tables, KPIs.
- Waits until each sheet is fully ready before capturing. Objects must be calculated by the engine, loading indicators gone, canvas charts drawn and the rendering stable (animations included).
- Stores images in the app's media library, exactly like a manual upload.
- Skips sheets you are not allowed to edit and reports it in a progress log.
- Replaces its own previous thumbnails and deletes the old files, with timestamped file names to avoid browser caching issues.
- Works behind a virtual proxy prefix.
- No internet access needed: html2canvas is bundled.

## How it works

1. The sheet is displayed in the Qlik Sense client.
2. The extension checks that the sheet is ready:
   - every object on the sheet has finished calculating (engine `GetLayout`);
   - no loading indicator is visible and all images are loaded;
   - every canvas chart contains a drawing;
   - the visual fingerprint of the sheet, canvas pixels included, stays unchanged for about 1.2 s.
3. The sheet is captured in the browser with [html2canvas](https://html2canvas.hertzen.com).
4. The PNG is uploaded to the app content library through the Qlik Repository Service API (`POST /qrs/appcontent/{appId}/uploadfile`).
5. The sheet's `thumbnail` property is updated and the app is saved.

## Requirements

- Qlik Sense Enterprise on Windows. Qlik Sense Desktop is not supported (no Repository Service).
- A modern browser (Chrome, Edge or Firefox).
- An unpublished app, or a working copy of a published app.
- Permission to upload images to the app's media library (same rights as a manual upload).

## Installation

1. Download `SheetThumbnailGenerator-v1.1.0.zip` from the [Releases](https://github.com/AYOUBTARMOUNIA/sheet-thumbnail-generator/releases) page.
2. In the QMC, open **Extensions** and click **Import**.
3. Select the zip file.

To update, delete the previous version in the QMC, import the new zip, then hard-refresh the browser (Ctrl+F5).

## Usage

1. Open an unpublished app (or a working copy).
2. Create a utility sheet (for example "Tools") and add the **Sheet Thumbnail Generator** object to it.
3. Leave edit mode: the buttons are only active in analysis mode.
4. Click one of the two buttons:
   - **Générer pour cette feuille** generates the thumbnail of the current sheet.
   - **Générer pour toutes les feuilles** visits every sheet, captures it and updates its thumbnail. A progress panel with a stop button appears in the bottom-right corner, and you return to the starting sheet at the end.
5. Delete the utility sheet if you wish, then publish or replace the app.

Keep the browser tab in the foreground during a batch run. Background tabs slow down rendering.

> The user interface is currently in French. English localization is on the roadmap, and contributions are welcome.

## Settings

Available in the property panel, section "Vignettes".

| Setting | Default | Description |
|---|---|---|
| Thumbnail width (px) | 800 | Width of the generated image. The height is proportional. |
| Minimum wait per sheet (ms) | 2500 | Floor delay before capture in batch mode, on top of the readiness check. |
| Maximum wait per sheet (s) | 30 | After this delay the sheet is considered not ready. Increase it for heavy apps. |
| If a sheet is not ready in time | Capture anyway | Either capture with a warning in the log, or skip the sheet. |
| Replace existing thumbnails | Yes | If unchecked, sheets that already have a thumbnail are skipped. |
| Exclude the sheet containing this object | Yes | Avoids generating a thumbnail for the utility sheet. |
| CSS selector of the capture area | empty | Automatic detection when empty. Only set it if the capture is blank or badly framed. |

## Permissions

Base sheets of a published app and approved sheets cannot be modified. The extension skips them and says so in the log.

Uploading to the app content library requires the same rights as uploading an image manually to the media library. The owner of an unpublished app has them with the default security rules. A `QRS 403` error points to a security rule issue.

## Known limitations

- **External content**: a map background or an image served from another domain without CORS headers can block the capture of that sheet. A clear error message is shown.
- **Extended or scrolling sheets**: only the visible area is captured.
- **Rendering fidelity**: html2canvas reproduces most objects faithfully, but some advanced CSS effects may differ slightly. For a thumbnail, the result is more than enough.
- **Client DOM**: the CSS classes of the Qlik Sense client are not an official API and can change between releases. If automatic detection fails after an upgrade, inspect the page (F12) and set the capture-area selector in the properties.
- **Hidden sheets** (show condition): skipped in batch mode when navigation to them fails.
- **Objects that never finish loading** (for example an extension with a permanent animation): the sheet reaches the maximum wait, then it is captured with a warning or skipped, depending on the setting.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Blank or badly framed thumbnail | Set the capture-area CSS selector in the properties (use F12 to find the sheet container). |
| Charts missing on some thumbnails | Increase the minimum and maximum wait. |
| `QRS 403` | Check the security rules for the app content in the QMC. |
| `QRS 404` on `/qrs` | Your virtual proxy may not forward Repository Service calls. |
| Old thumbnail still displayed | Hard-refresh the browser (Ctrl+F5). |

## Contributing

Issues and pull requests are welcome. When reporting a bug, please include your Qlik Sense version, your browser, and any error shown in the browser console (F12).

## License

[MIT](LICENSE). This project bundles html2canvas 1.4.1 (MIT), see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Disclaimer

This is an independent community project. It is not affiliated with, endorsed by, or supported by Qlik. Qlik and Qlik Sense are trademarks of QlikTech International AB.
