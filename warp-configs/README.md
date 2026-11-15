# WireGuard config pool

Drop your Cloudflare WARP `.conf` files here:

```text
config_01.conf
config_02.conf
config_03.conf
config_04.conf
```

The rotator reads them in natural filename order, hops round-robin, and wraps at the end. Files that
fail to parse are reported in the App Log and skipped.

Required sections/keys:

- `[Interface] PrivateKey`, `Address`
- `[Peer] PublicKey`, `Endpoint`

Optional: `DNS`, `MTU` (default 1280), `AllowedIPs` (default `0.0.0.0/0, ::/0`), `PresharedKey`,
`Reserved`.

`Address` may hold both an IPv4 `/32` and an IPv6 `/128`; both are passed to sing-box.

## Secrets

These files contain WireGuard private keys. `warp-configs/*.conf` is gitignored. The renderer never
receives keys: the pool is parsed in the main process and the UI only gets filenames, addresses,
endpoints, and a fingerprint.

## Example

```ini
[Interface]
PrivateKey = <your private key>
Address = 172.16.0.2/32, 2606:4700:110:8d3e:.../128
DNS = 1.1.1.1, 1.0.0.1
MTU = 1280

[Peer]
PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = engage.cloudflareclient.com:2408
```
