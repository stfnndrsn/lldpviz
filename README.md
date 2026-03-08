# LLDPviz

Network topology visualizer for MikroTik LLDP neighbor data. Paste raw CLI output from your routers and switches to build interactive topology diagrams.

## Quick Start

### With Flask backend (sharing & revisions)

```bash
pip install -r requirements.txt
python server.py
# open http://localhost:5000
```

### Static only (no sharing)

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

### Docker

```bash
docker build -t lldpviz .
docker run -p 5000:5000 -v lldpviz-data:/data lldpviz
```

The SQLite database is stored at `/data/lldpviz.db` inside the container.

## Usage

1. **Create a site** -- enter a name and click "Create"
2. **Collect LLDP data** from a MikroTik device:
   ```
   /ip/neighbor/print detail where discovered-by~"lldp"
   ```
3. **Paste the output** into the textarea and click "Add Neighbors" (source identity is auto-detected from the prompt)
4. **Repeat** for each device to build the full topology
5. **Click nodes** to see device details

### Traverse Mode

Traverse mode guides you through systematic network discovery. It tracks which devices have been scanned, shows pending neighbors with copyable MAC-telnet commands, and lets you mark unreachable devices as dead ends.

While traversing, you can optionally paste extra data per device:

- `/interface/print without-paging` -- interface status
- `/ip/address/print without-paging` -- IP addresses
- `/interface/bridge/vlan/print without-paging` -- VLAN configuration

## View Modes

| Mode | Description |
|------|-------------|
| **Network** | Force-directed graph layout |
| **Tree** | Hierarchical top-down from a chosen root node |
| **Radial** | Concentric circles from a root node |
| **Text** | ASCII tree, copyable for documentation |
| **Table** | Sortable device list, exportable as CSV |
| **Matrix** | N x N connection grid with interface names |
| **Ports** | Switch faceplate view showing port utilization |

## Sharing

Click **Share** to upload a site to the server and get a shareable link. Anyone with the link can view the topology. Click **Save** to store a new revision -- previous revisions remain accessible via the dropdown.

Sharing requires the Flask backend (`server.py`). Without it, the app works fully offline using `localStorage`.

## Node Types

Devices are styled by their LLDP-advertised capabilities:

- **Hexagon (orange)** -- Router + Bridge (L3 switch)
- **Diamond (red)** -- Router only
- **Box (blue)** -- Bridge / Switch
- **Triangle (green)** -- WLAN AP
- **Dot (grey)** -- Other / unknown

## API

The Flask backend exposes a simple REST API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/share` | Create a new shared site, returns `{ uuid, revision }` |
| `GET` | `/api/share/<uuid>` | Get latest revision (or `?rev=N` for specific) |
| `POST` | `/api/share/<uuid>` | Save a new revision |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLDPVIZ_DB` | `lldpviz.db` | Path to the SQLite database file |
| `PORT` | `5000` | Server port |
| `FLASK_DEBUG` | `0` | Set to `1` for debug mode |

## License

[Unlicense](https://unlicense.org) -- public domain. Do whatever you want with it.
