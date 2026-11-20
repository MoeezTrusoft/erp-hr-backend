# HR device gateway

Collects punches from biometric devices into HR's existing intake. Same image as the HR API, run as its
own Deployment with `node src/deviceGateway.js`.

| Connector | For | How |
|---|---|---|
| ADMS push (`/iclock/*`) | Devices with a Cloud Server setting (e.g. PECHS TTQ5261300360) | The device calls the gateway. Rows are acknowledged (`OK: n`) only after the intake stored them; on error the device keeps them and retries |
| SDK pull (TCP/UDP 4370) | Old devices without ADMS (Johar, Dalmia) | The gateway connects every `DEVICE_PULL_INTERVAL_SECONDS`, reads the clock and the attendance log, forwards records from the cursor minus 10 minutes. One replica pulls at a time (Redis lease) |

Both feed `receiveCapture` (sources `DEVICE_PUSH` / `DEVICE_LISTENER`), which de-duplicates, so resends are safe.
A device must be registered and active in HR (Capture operations) or it is refused.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DEVICE_GATEWAY_PORT` | `3011` | `/iclock/*`, `/healthz`, `/readyz`, `/metrics` |
| `DEVICE_GATEWAY_PUSH_ENABLED` | `true` | |
| `DEVICE_GATEWAY_PULL_ENABLED` | `false` | |
| `DEVICE_PULL_TARGETS` | `[]` | JSON: `[{"sn":"A8LN181960262","host":"10.x.x.x","port":4370,"transport":"tcp"}]` |
| `DEVICE_COMM_KEYS` | `{}` | JSON `{"<sn>":"<comm key>"}`, from a sealed secret only |
| `DEVICE_PULL_INTERVAL_SECONDS` | `60` | |
| `DEVICE_GATEWAY_COMMANDS_ENABLED` | `false` | When true, the pull connector applies HR's "fix the clock" commands (`CMD_SET_TIME`). Otherwise the gateway never writes to a device |
| `REDIS_URL` | — | Pull lease, ADMS stamps and pull cursors. Without it: per-process state, run one replica |

Plus the HR API's database settings (`DATABASE_URL`, `DATABASE_DIRECT_URL`).

## Device setup

- **ADMS:** Comm → Cloud Server: server address `erp.trusoft.ai`, port 443 with HTTPS where the firmware offers
  it. The first handshake asks for the whole log (the intake drops repeats).
- **Pull:** reach the device over a site VPN, never the open internet. Give the device a fixed IP (DHCP off or a
  router reservation). Close TCP 4370 to the internet at the site.

## Metrics

`hr_device_rows_total{sn,connector,result}`, `hr_device_requests_total{connector,kind,result}`,
`hr_device_last_contact_seconds{sn,connector}`, `hr_device_clock_offset_seconds{sn}`.
