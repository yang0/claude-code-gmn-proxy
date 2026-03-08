# systemd User Service

The bridge does not require systemd to work. `claude-codex` can start the proxy on demand.

If you want the proxy to stay available in the background, install the user service:

```bash
cloud-code-proxy-install-service
```

Check status:

```bash
cloud-code-proxy-status
```

Stop it:

```bash
cloud-code-proxy-stop
```

The generated unit file is installed to:

```text
~/.config/systemd/user/claude-code-gmn-proxy.service
```
