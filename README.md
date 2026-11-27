# DATAGRAM — Real-Time UDP Chat Application

**DATAGRAM** is a standalone multi-user messaging application built on **UDP (User Datagram Protocol, `AF_INET` / `SOCK_DGRAM`)** as its primary transport-layer protocol. It is designed for Data Communication and Networking practical demonstrations to contrast connectionless UDP datagram delivery against TCP-based messaging systems such as Connectly.

---

## 1. Architecture Overview

Browsers cannot open raw OS-level UDP sockets directly. DATAGRAM solves this cleanly without compromising the transport layer:

```text
┌────────────────────┐      HTTP / WebSocket       ┌──────────────────────────┐
│   React + Vite UI  │ ◄─────────────────────────► │   Python Client Bridge   │
│ (Port 3000 Gateway)│   Auth, History, UI Events  │  backend/bridge.py :8765 │
└────────────────────┘                             └────────────┬─────────────┘
                                                                │
                                                      Real IPv4 UDP Socket
                                                      (SOCK_DGRAM, Ephemeral Port)
                                                                │
                                                                ▼
┌────────────────────┐     Real IPv4 UDP Socket    ┌──────────────────────────┐
│  Other UDP Clients │ ◄─────────────────────────► │    Python UDP Server     │
│ (Browser / CLI)    │    JSON Datagrams :9001     │ backend/udp_server.py    │
└────────────────────┘                             └──────────────────────────┘
```

- **No TCP sockets are used for chat transport.** Every chat message, typing signal, heartbeat, presence update, and delivery acknowledgement travels as an independent JSON UDP datagram via `socket.socket(socket.AF_INET, socket.SOCK_DGRAM)`.
- Each connected browser session receives its own dedicated `DatagramUDPClient` instance in `bridge.py`, bound to a distinct OS-assigned ephemeral UDP source port.
- Application-layer features—delivery acknowledgements (`message_ack`), bounded retransmissions, and duplicate `message_id` filtering—are implemented explicitly **on top of UDP** and can be toggled off in the **UDP Diagnostics** page to observe raw unreliable UDP behavior.

---

## 2. Project Structure

```text
datagram/
├── backend/
│   ├── udp_server.py      # IPv4 SOCK_DGRAM server (port 9001), heartbeat reaper, router
│   ├── udp_client.py      # IPv4 SOCK_DGRAM client library + standalone CLI chat client
│   ├── bridge.py          # Asyncio HTTP + RFC 6455 WebSocket bridge (port 8765)
│   ├── database.py        # SQLite persistence (users, messages, datagram_logs)
│   ├── auth.py            # Salted scrypt password hashing & HMAC-SHA256 session tokens
│   └── requirements.txt   # Python 3.10+ environment notes
├── src/
│   ├── components/        # Avatar, BrandMark, ProfileModal
│   ├── hooks/             # useDatagramSocket (WebSocket client hook)
│   ├── pages/             # AuthPage (Login/Register), ChatDashboard, DiagnosticsPage
│   ├── services/          # HTTP API client (in-memory Bearer token)
│   ├── types/             # TypeScript interfaces
│   ├── App.tsx            # Root application shell
│   ├── main.tsx           # React entry point
│   └── index.css          # Tailwind CSS v4 styles
├── server.ts              # Port 3000 Express + WS gateway & Vite middleware
├── index.html
├── package.json
└── README.md
```

---

## 3. Prerequisites (Windows)

- **Python 3.10 or newer** (`python --version`)
- **Node.js 18 or newer** (`node -v` and `npm -v`)
- **Wireshark + Npcap** (optional, for live loopback packet inspection)

No Docker, external database server, or cloud deployment is required.

---

## 4. Installation & Running Locally on Windows

### Step 1: Install dependencies

Open **PowerShell** or **Command Prompt** in the project root:

```powershell
# Install Node.js frontend & gateway dependencies
npm install

# Optional: install Python packages listed in backend/requirements.txt
pip install -r backend\requirements.txt
```

> Note: `udp_server.py`, `udp_client.py`, `bridge.py`, `database.py`, and `auth.py` use Python's standard library (`socket`, `sqlite3`, `asyncio`, `hashlib`, `hmac`, `json`), so they run cleanly even in minimal Python 3.10+ environments.

### Step 2A: Three-Terminal Academic Demo Mode (Recommended)

Running each layer in its own terminal lets you observe live incoming/outgoing datagram logs directly alongside the UI:

**Terminal 1 — Start the UDP Server (Port 9001):**
```powershell
python backend\udp_server.py --host 0.0.0.0 --port 9001
```

**Terminal 2 — Start the Python Client Bridge (Port 8765):**
```powershell
python backend\bridge.py --host 127.0.0.1 --port 8765 --udp-host 127.0.0.1 --udp-port 9001
```

**Terminal 3 — Start the Web Gateway & Frontend (Port 3000):**
```powershell
npm run dev
```

Open your browser to **http://localhost:3000**.

### Step 2B: Single-Command Mode

If you run `npm run dev` directly, `server.ts` automatically checks whether `127.0.0.1:8765` is already listening and spawns `backend/udp_server.py` and `backend/bridge.py` if needed.

### Step 3: Optional Standalone CLI UDP Client

You can also connect a pure terminal UDP client to chat with a browser user:

```powershell
# First register the username via the web UI (so the account exists), then connect via CLI:
python backend\udp_client.py --username john --peer grace
```

---

## 5. UDP JSON Message Protocol

All datagrams are UTF-8 JSON objects kept under `1400` bytes (below Ethernet MTU fragmentation limits).

Supported message `type` values:
- `register`: Announces a peer's username and `(IP, port)` tuple to the UDP server.
- `heartbeat`: Sent every 4 seconds; peers timing out after 14 seconds are marked offline.
- `chat_message`: Peer-to-peer message routed via the UDP server with `message_id`, `seq_num`, and `timestamp`.
- `message_ack`: Application-layer delivery confirmation returned by the receiving client.
- `typing`: Ephemeral fire-and-forget typing indicator.
- `disconnect`: Explicit departure datagram sent when a client closes its session.
- `presence`: Server broadcast listing currently active UDP peers and server counters.
- `error`: Server error datagram (e.g., oversized payload, malformed JSON, or offline recipient).

Example `chat_message` datagram:
```json
{
  "type": "chat_message",
  "sender": "grace",
  "recipient": "john",
  "message": "Hello!",
  "message_id": "a1b2c3d4e5f6",
  "seq_num": 4,
  "retry_count": 0,
  "timestamp": "2026-11-27T12:00:00Z"
}
```

---

## 6. Testing & Wireshark Demonstration Guide

1. **Multi-User Chat**:
   - Open `http://localhost:3000` in Window 1 and register/sign in as `grace`.
   - Open `http://localhost:3000` in an Incognito/Private Window 2 and register/sign in as `john`.
   - Notice in **UDP Diagnostics** that each session has its own OS-assigned ephemeral `Client Source Port`.
2. **Wireshark Capture**:
   - Capture on **Adapter for loopback traffic capture** (Windows Npcap).
   - General UDP filter: `udp`
   - Datagram server filter: `udp.port == 9001`
   - Observe the 8-byte UDP header and immediate data transmission without a `SYN / SYN-ACK / ACK` 3-way handshake.
3. **Packet Loss & Reliability Experiments (UDP Diagnostics tab)**:
   - Set **Simulated UDP Packet Loss** to `50%` and toggle **Application ACKs** OFF to demonstrate silent packet loss in raw UDP.
   - Re-enable **Application ACKs** and set **Retries** to `3` to demonstrate application-layer recovery.
   - Trigger **Send Duplicate Datagram Pair**, **Simulate Out-of-Order Datagram Burst**, and **Test Oversized Datagram (> 1400 B)** to observe live telemetry updates.

---

## 7. Troubleshooting

- **Port 9001 or 8765 already in use**: Stop older Python terminals (`Ctrl+C`) or pass `--port` and set `DATAGRAM_UDP_PORT` / `DATAGRAM_BRIDGE_PORT`.
- **SQLite database locked**: Ensure only one `udp_server.py` and `bridge.py` pair accesses `backend/datagram.db`. Deleting `backend/datagram.db` resets all accounts and chat history cleanly.
- **No Wireshark packets on localhost**: Ensure Npcap was installed with *"Support loopback traffic"* enabled, and select the loopback adapter in Wireshark.
