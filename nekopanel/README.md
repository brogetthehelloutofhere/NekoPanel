# NekoPanel

A from-scratch Minecraft control-panel starter using Node.js and Express. This is an MVP, not yet a production-hardened replacement for mature panels.

## Included
- bcrypt password-hash login and server-side session
- Allowlisted systemd start/stop/restart actions (no arbitrary shell endpoint)
- Recent journal logs
- Read-only Minecraft directory listing
- Local `.tar.gz` backup and optional `rclone` upload
- Responsive dark dashboard

## Requirements
- Node.js 20+
- Linux with systemd
- Minecraft server managed by `minecraft.service`
- Panel runs as a separate `nekopanel` user; Minecraft runs as `minecraft`

## Configure
Install dependencies with `npm install`. Set environment variables from `.env.example` using your systemd environment file. Generate a bcrypt password hash:

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'choose-a-long-password'
```

Generate a session secret with `openssl rand -hex 32`. Set `PANEL_PASSWORD_HASH` to the generated hash and `SESSION_SECRET` to the random value. Do not commit secrets.

For local testing, export the variables and run `npm start`. The app defaults to `127.0.0.1:3000`; access it through an SSH tunnel:

```powershell
ssh -L 3000:127.0.0.1:3000 -i "$env:USERPROFILE\.ssh\oracle-key" opc@YOUR_VM_IP
```

Then browse to `http://127.0.0.1:3000`.

## Deployment and security notes
- Review both systemd example units before using them.
- Configure a narrow sudoers rule with `visudo` for only required `systemctl` and `journalctl` actions.
- Put an HTTPS reverse proxy in front of the panel before public exposure.
- This MVP has no CSRF protection, rate limiting, password-reset UI, multi-user roles, or interactive stdin/RCON console.
- Backups of a live Minecraft world may be inconsistent. Stop the server or implement a tested save/flush workflow first.
- File management is intentionally read-only; no upload/edit/delete endpoint is included.
- Keep `.env`, SSH private keys, service-account JSON, `rclone.conf`, world files, and backups out of the public repo.
- Add tests, CSRF protection, rate limiting, backup retention and restore tests before relying on it for production.

## Public repository
Choose and add a license before publishing. This starter has no license by default.
