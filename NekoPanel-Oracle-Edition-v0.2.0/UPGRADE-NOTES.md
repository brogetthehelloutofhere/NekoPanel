# NekoPanel Oracle Edition — upgrade notes

This bundle preserves the GitHub repository's existing layout: the repo-level `LICENSE` stays at the root, and the application files live in `nekopanel/`.

## GitHub upload path

Upload the contents of this bundle into the repository root so the existing `nekopanel/` directory is updated. Do not upload any server `.env` or secrets. If committing from a local Git clone, replace the existing `nekopanel/` directory with the one in this bundle and commit the changes.

## Oracle deployment note

Do not replace files directly under the currently running app while expecting the old process to hot-reload; restart NekoPanel after replacing files and installing the updated dependencies. Keep a copy of the current project directory first.

## Compatibility warning

v0.2.0 changes the API and user interface and adds `multer`, `node-cron` and `rcon-client` dependencies. Run `npm install` and `npm run check` before restarting the panel. The UI modules for RCON and player control require the RCON environment variables, and filesystem features require the NekoPanel process user to have appropriately scoped permissions on the Minecraft directory. Restore, server installation/import, multi-server management, multiple users/roles and MFA are not implemented in this alpha.
