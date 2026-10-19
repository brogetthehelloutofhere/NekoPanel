# NekoPanel — Oracle Edition

NekoPanel is an original self-hosted Minecraft server administration panel built with Node.js and Express, designed for Linux and Oracle Cloud ARM64. It is inspired by the kinds of workflows available in established server panels, but uses its own source, branding, and interface.

> **Status:** v0.2.0 is an early alpha. It is not yet a complete substitute for Crafty Controller and should not be exposed directly to the internet. Test with a disposable server before relying on its backup or file-management features.

## In this release

- Authenticated dark dashboard with responsive navigation
- bcrypt password-hash login, server-side sessions, login throttling
- systemd service start/stop/restart/status and recent journal logs
- Host CPU load, RAM, disk and uptime metrics
- Minecraft RCON command form and player moderation actions (RCON must be configured)
- Server-root file browser, text-file editor, upload/download, folder creation and deletion with path/symlink checks
- Local compressed backups, archive list/download/delete, optional rclone copy; active servers are stopped while the archive is created and then restarted
- Cron-based start/stop/restart/backup jobs with local execution history
- Prometheus-compatible `/api/metrics` endpoint, optionally protected by a bearer token
- Environment configuration overview and setup guidance

## Planned modules for parity with larger panels

This alpha is a foundation, not feature-complete parity. Remaining work includes a web-based server install/import wizard (Java/Bedrock and server software/version selection), multiple server profiles, safe backup restore and retention policies, user/role/permission management, TOTP/passkeys, more detailed JVM/player metrics, status pages, webhooks, and stronger deployment/security hardening (CSRF tokens, persistent session store, audit trail and integration tests).

## Requirements

- Node.js 20+
- Linux with systemd; tested target is Oracle Linux 9 ARM64
- `minecraft.service` managed by systemd and a Minecraft directory, default `/opt/minecraft`
- NekoPanel should run as its own unprivileged `nekopanel` Linux user, not as root
- RCON optional for live Minecraft commands and player management

## Install dependencies and check syntax

```bash
npm install
npm run check
```

## Environment setup

Create a protected environment file at `/etc/nekopanel/nekopanel.env`. Do not commit it. Required values are `PANEL_PASSWORD_HASH` and `SESSION_SECRET` (at least 32 characters). Generate them on the Oracle VM:

```bash
openssl rand -hex 32
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'USE-A-UNIQUE-LONG-PASSWORD'
```

Do not use the example password in production. Set the output hash and session secret in the environment file. Review `.env.example` for the rest of the variables.

Default panel bind is `127.0.0.1:3000`. Access it locally through an SSH tunnel:

```powershell
ssh -N -L 3000:127.0.0.1:3000 -i "$env:USERPROFILE\.ssh\oracle-key" opc@YOUR_VM_IP
```

Open `http://127.0.0.1:3000` on the Windows computer where the tunnel is running.

## Minecraft service permissions

The app deliberately invokes a short, explicit list of `systemctl` and `journalctl` operations rather than accepting arbitrary operating-system commands. Its systemd service example uses the separate `nekopanel` user. Review `deploy/nekopanel.sudoers.example`; install and edit the rules with `sudo visudo -f /etc/sudoers.d/nekopanel`. The sample allows only a specific `minecraft.service` and specific systemd/journalctl commands; change the service name if needed. Do not grant blanket passwordless sudo. The NekoPanel service example includes the `minecraft` supplementary group, but read/write access to world files still requires carefully scoped group/ACL permissions.

The panel file editor can modify live server files. Restrict panel access and keep world backups. Backup creation temporarily stops an active service; if the stop or restart behavior has not been tested for your specific service, run it only against a disposable test instance first.

## RCON

In `server.properties`, enable RCON and choose a long unique RCON password. Keep `RCON_HOST=127.0.0.1`; do not expose the RCON port in Oracle ingress rules. Store the password only in `/etc/nekopanel/nekopanel.env` and restart both relevant services.

## Prometheus

`/api/metrics` emits basic host metrics. Set `METRICS_TOKEN` to a long random value and configure Prometheus with `Authorization: Bearer <token>` if the endpoint is reachable outside the local host. Keep the default localhost bind otherwise.

## Security notes

- Do not publish passwords, `.env` files, SSH private keys, RCON credentials, `rclone.conf`, backups or world files.
- Keep the panel on localhost and use SSH tunneling until HTTPS, CSRF protection, persistent session storage, least-privilege sudoers, auditing and restore testing are complete.
- No API route accepts arbitrary shell commands. The console sends Minecraft commands through RCON only.
- Restore functionality is intentionally not enabled yet. Do not manually extract untrusted archives into a live server directory.
