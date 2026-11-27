import { useState } from "react";
import {
  AlertTriangle,
  CopyCheck,
  RefreshCw,
  Send,
  ShieldAlert,
  Shuffle,
  Sliders,
  Terminal,
} from "lucide-react";
import type {
  PeerUser,
  UdpConfig,
  UdpDiagnostics,
  UserProfile,
} from "../types/datagram";

interface DiagnosticsPageProps {
  currentUser: UserProfile;
  peers: PeerUser[];
  selectedPeer: string | null;
  diagnostics: UdpDiagnostics | null;
  onRefreshDiagnostics: () => void;
  onUpdateConfig: (cfg: Partial<UdpConfig>) => void;
  onSendDuplicateTest: (recipient: string) => void;
  onSendReorderBurst: (recipient: string) => void;
  onSendOversizedTest: (recipient: string) => void;
}

export function DiagnosticsPage({
  currentUser,
  peers,
  selectedPeer,
  diagnostics,
  onRefreshDiagnostics,
  onUpdateConfig,
  onSendDuplicateTest,
  onSendReorderBurst,
  onSendOversizedTest,
}: DiagnosticsPageProps) {
  const [logFilter, setLogFilter] = useState<"all" | "chat" | "ack" | "control">("all");
  const [testTarget, setTestTarget] = useState<string>(
    selectedPeer || peers[0]?.username || currentUser.username
  );
  const [testFeedback, setTestFeedback] = useState<string | null>(null);

  const metrics = diagnostics?.metrics;
  const config = diagnostics?.config;
  const serverStats = diagnostics?.server_stats;
  const logs = diagnostics?.recent_datagrams ?? [];

  const filteredLogs = logs.filter((entry) => {
    if (logFilter === "all") return true;
    if (logFilter === "chat") return entry.type === "chat_message";
    if (logFilter === "ack") return entry.type === "message_ack";
    return entry.type !== "chat_message" && entry.type !== "message_ack";
  });

  const targetUser =
    testTarget || selectedPeer || peers[0]?.username || currentUser.username;

  const triggerTest = (label: string, fn: () => void) => {
    fn();
    setTestFeedback(`${label} transmitted via UDP socket.`);
    window.setTimeout(() => setTestFeedback(null), 4000);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#111013] text-[#F5EFE6]">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 py-8 space-y-10">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-6 border-b border-[#F5EFE6]/10">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-[#D4A7B0]">
              Transport-Layer Telemetry & Protocol Experiments
            </p>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#F5EFE6]">
              UDP Socket Diagnostics
            </h1>
            <p className="text-sm text-[#B8AFA4] max-w-2xl">
              Live socket metrics from your Python <code className="font-mono text-[#F5EFE6]">SOCK_DGRAM</code>{" "}
              client bridge. Application-layer ACKs, bounded retries, and duplicate filters are
              implemented above UDP to contrast with TCP’s built-in stream guarantees.
            </p>
          </div>

          <button
            type="button"
            onClick={onRefreshDiagnostics}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#18161A] hover:bg-[#221E24] border border-[#F5EFE6]/12 text-xs font-medium text-[#F5EFE6] transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh Telemetry
          </button>
        </div>

        {/* Live Metrics Grid */}
        <section aria-label="Live UDP Socket Metrics" className="space-y-4">
          <h2 className="font-display text-lg font-semibold text-[#F5EFE6]">
            Live Endpoint & Datagram Counters
          </h2>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-xl bg-[#18161A] border border-[#F5EFE6]/10 p-4 space-y-1">
              <div className="text-xs text-[#847B73]">UDP Server Endpoint</div>
              <div className="font-mono-tabular text-lg font-semibold text-[#F5EFE6]">
                {metrics ? `${metrics.server_ip}:${metrics.server_port}` : "127.0.0.1:9001"}
              </div>
              <div className="text-[11px] text-[#B8AFA4]">
                IPv4 · SOCK_DGRAM · {serverStats?.active_peers ?? 0} active peers
              </div>
            </div>

            <div className="rounded-xl bg-[#18161A] border border-[#F5EFE6]/10 p-4 space-y-1">
              <div className="text-xs text-[#847B73]">Client Source Port</div>
              <div className="font-mono-tabular text-lg font-semibold text-[#F5EFE6]">
                {metrics ? `:${metrics.client_source_port}` : "—"}
              </div>
              <div className="text-[11px] text-[#B8AFA4]">
                OS-assigned ephemeral UDP port
              </div>
            </div>

            <div className="rounded-xl bg-[#18161A] border border-[#F5EFE6]/10 p-4 space-y-1">
              <div className="text-xs text-[#847B73]">Datagrams Sent / Received</div>
              <div className="font-mono-tabular text-lg font-semibold text-[#F5EFE6]">
                {metrics?.datagrams_sent ?? 0}{" "}
                <span className="text-[#847B73] font-normal">/</span>{" "}
                {metrics?.datagrams_received ?? 0}
              </div>
              <div className="text-[11px] text-[#B8AFA4]">
                Server total rx: {serverStats?.datagrams_received ?? 0}
              </div>
            </div>

            <div className="rounded-xl bg-[#18161A] border border-[#F5EFE6]/10 p-4 space-y-1">
              <div className="text-xs text-[#847B73]">Acknowledgements (Rx / Tx)</div>
              <div className="font-mono-tabular text-lg font-semibold text-emerald-400">
                {metrics?.acks_received ?? 0}{" "}
                <span className="text-[#847B73] font-normal">/</span>{" "}
                {metrics?.acks_sent ?? 0}
              </div>
              <div className="text-[11px] text-[#B8AFA4]">
                App-layer <code className="font-mono">message_ack</code> count
              </div>
            </div>

            <div className="rounded-xl bg-[#18161A] border border-[#F5EFE6]/10 p-4 space-y-1">
              <div className="text-xs text-[#847B73]">Duplicates Detected</div>
              <div className="font-mono-tabular text-lg font-semibold text-[#F5EFE6]">
                {metrics?.duplicates_detected ?? 0}
              </div>
              <div className="text-[11px] text-[#B8AFA4]">
                Filtered by <code className="font-mono">message_id</code> cache
              </div>
            </div>

            <div className="rounded-xl bg-[#18161A] border border-[#F5EFE6]/10 p-4 space-y-1">
              <div className="text-xs text-[#847B73]">Missing Acknowledgements</div>
              <div className="font-mono-tabular text-lg font-semibold text-rose-400">
                {metrics?.missing_acks ?? 0}
              </div>
              <div className="text-[11px] text-[#B8AFA4]">
                Retries exhausted without ACK
              </div>
            </div>

            <div className="rounded-xl bg-[#18161A] border border-[#F5EFE6]/10 p-4 space-y-1">
              <div className="text-xs text-[#847B73]">Out-of-Order Arrivals</div>
              <div className="font-mono-tabular text-lg font-semibold text-amber-400">
                {metrics?.out_of_order_count ?? 0}
              </div>
              <div className="text-[11px] text-[#B8AFA4]">
                Retransmissions: {metrics?.retransmissions ?? 0}
              </div>
            </div>

            <div className="rounded-xl bg-[#18161A] border border-[#F5EFE6]/10 p-4 space-y-1">
              <div className="text-xs text-[#847B73]">Voice Frames (Tx / Rx)</div>
              <div className="font-mono-tabular text-lg font-semibold text-[#F5EFE6]">
                {metrics?.voice_frames_sent ?? 0}{" "}
                <span className="text-[#847B73] font-normal">/</span>{" "}
                {metrics?.voice_frames_received ?? 0}
              </div>
              <div className="text-[11px] text-[#B8AFA4]">
                Voice OOO: {metrics?.voice_out_of_order ?? 0} · Drops:{" "}
                {metrics?.simulated_losses ?? 0}
              </div>
            </div>
          </div>
        </section>

        {/* Interactive Protocol Controls & Experiments */}
        <section className="grid lg:grid-cols-12 gap-6">
          {/* Application-Layer Reliability & Loss Controls */}
          <div className="lg:col-span-6 rounded-2xl bg-[#18161A] border border-[#F5EFE6]/10 p-6 space-y-6">
            <div className="flex items-center gap-2.5">
              <Sliders className="w-4 h-4 text-[#D4A7B0]" />
              <h2 className="font-display text-lg font-semibold text-[#F5EFE6]">
                Application-Layer Reliability & Loss Simulation
              </h2>
            </div>

            <div className="space-y-5">
              {/* Packet Loss Slider */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="loss-slider" className="font-medium text-[#F5EFE6]">
                    Simulated UDP Packet Loss Rate
                  </label>
                  <span className="font-mono-tabular font-semibold text-[#D4A7B0]">
                    {Math.round((config?.packet_loss_rate ?? 0) * 100)}%
                  </span>
                </div>
                <input
                  id="loss-slider"
                  type="range"
                  min={0}
                  max={80}
                  step={10}
                  value={Math.round((config?.packet_loss_rate ?? 0) * 100)}
                  onChange={(e) =>
                    onUpdateConfig({ packet_loss_rate: Number(e.target.value) / 100 })
                  }
                  className="w-full accent-[#992641] cursor-pointer"
                />
                <p className="text-xs text-[#847B73]">
                  Randomly drops outbound and inbound UDP datagrams on your local socket to
                  demonstrate unreliability when ACKs or retries are disabled.
                </p>
              </div>

              {/* Application ACK Toggle */}
              <div className="flex items-center justify-between gap-4 pt-4 border-t border-[#F5EFE6]/8">
                <div>
                  <div className="text-xs font-medium text-[#F5EFE6]">
                    Application-Layer Delivery ACKs
                  </div>
                  <p className="text-xs text-[#847B73] mt-0.5">
                    Disable to run pure fire-and-forget UDP with zero delivery confirmation.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={config?.ack_enabled ?? true}
                  onClick={() =>
                    onUpdateConfig({ ack_enabled: !(config?.ack_enabled ?? true) })
                  }
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    config?.ack_enabled ?? true
                      ? "bg-[#7D1D33] text-[#F5EFE6]"
                      : "bg-[#221E24] text-[#B8AFA4] border border-[#F5EFE6]/12"
                  }`}
                >
                  {config?.ack_enabled ?? true ? "ACKs Enabled" : "ACKs Disabled"}
                </button>
              </div>

              {/* Retry Policy */}
              <div className="flex items-center justify-between gap-4 pt-4 border-t border-[#F5EFE6]/8">
                <div>
                  <div className="text-xs font-medium text-[#F5EFE6]">
                    Bounded Retransmission Retries
                  </div>
                  <p className="text-xs text-[#847B73] mt-0.5">
                    UDP does not retransmit lost packets; enable app-layer retries (0–3).
                  </p>
                </div>
                <div className="flex items-center gap-1 p-1 rounded-lg bg-[#111013] border border-[#F5EFE6]/10">
                  {[0, 1, 2, 3].map((count) => {
                    const active =
                      count === 0
                        ? !(config?.retry_enabled ?? true) || config?.max_retries === 0
                        : (config?.retry_enabled ?? true) && config?.max_retries === count;
                    return (
                      <button
                        key={count}
                        type="button"
                        onClick={() =>
                          onUpdateConfig({
                            retry_enabled: count > 0,
                            max_retries: count,
                          })
                        }
                        className={`px-2.5 py-1 rounded-md text-xs font-mono-tabular transition-colors ${
                          active
                            ? "bg-[#7D1D33] text-[#F5EFE6]"
                            : "text-[#B8AFA4] hover:text-[#F5EFE6]"
                        }`}
                      >
                        {count}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* One-Click UDP Anomaly Demonstrations */}
          <div className="lg:col-span-6 rounded-2xl bg-[#18161A] border border-[#F5EFE6]/10 p-6 space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <Terminal className="w-4 h-4 text-[#D4A7B0]" />
                <h2 className="font-display text-lg font-semibold text-[#F5EFE6]">
                  Live Wire Experiments
                </h2>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="test-target" className="text-xs text-[#847B73]">
                  Target:
                </label>
                <select
                  id="test-target"
                  value={targetUser}
                  onChange={(e) => setTestTarget(e.target.value)}
                  className="rounded-lg bg-[#111013] border border-[#F5EFE6]/12 px-2.5 py-1.5 text-xs font-mono text-[#F5EFE6] focus:outline-none focus:border-[#992641]"
                >
                  <option value={currentUser.username}>@{currentUser.username} (Self)</option>
                  {peers.map((p) => (
                    <option key={p.username} value={p.username}>
                      @{p.username} ({p.online ? "Online" : "Offline"})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <p className="text-xs text-[#B8AFA4] leading-relaxed">
              Trigger genuine UDP wire anomalies against the selected peer (or loopback to
              yourself) to verify duplicate detection, out-of-order sequencing, and MTU bounds.
            </p>

            <div className="space-y-3">
              <button
                type="button"
                onClick={() =>
                  triggerTest("Duplicate datagram pair", () =>
                    onSendDuplicateTest(targetUser)
                  )
                }
                className="w-full flex items-center justify-between gap-4 p-3.5 rounded-xl bg-[#111013] hover:bg-[#221E24] border border-[#F5EFE6]/10 text-left transition-colors"
              >
                <div>
                  <div className="text-xs font-semibold text-[#F5EFE6]">
                    Send Duplicate Datagram Pair
                  </div>
                  <div className="text-[11px] text-[#847B73] mt-0.5">
                    Transmits the exact same <code className="font-mono">message_id</code>{" "}
                    twice; receiver increments Duplicates Detected.
                  </div>
                </div>
                <CopyCheck className="w-4 h-4 text-[#D4A7B0] shrink-0" />
              </button>

              <button
                type="button"
                onClick={() =>
                  triggerTest("Out-of-order burst", () => onSendReorderBurst(targetUser))
                }
                className="w-full flex items-center justify-between gap-4 p-3.5 rounded-xl bg-[#111013] hover:bg-[#221E24] border border-[#F5EFE6]/10 text-left transition-colors"
              >
                <div>
                  <div className="text-xs font-semibold text-[#F5EFE6]">
                    Simulate Out-of-Order Datagram Burst
                  </div>
                  <div className="text-[11px] text-[#847B73] mt-0.5">
                    Sends <code className="font-mono">seq N+1</code> before delayed{" "}
                    <code className="font-mono">seq N</code> to demonstrate unsequenced UDP delivery.
                  </div>
                </div>
                <Shuffle className="w-4 h-4 text-amber-400 shrink-0" />
              </button>

              <button
                type="button"
                onClick={() =>
                  triggerTest("Oversized MTU test datagram", () =>
                    onSendOversizedTest(targetUser)
                  )
                }
                className="w-full flex items-center justify-between gap-4 p-3.5 rounded-xl bg-[#111013] hover:bg-[#221E24] border border-[#F5EFE6]/10 text-left transition-colors"
              >
                <div>
                  <div className="text-xs font-semibold text-[#F5EFE6]">
                    Test Oversized Datagram (&gt; 1400 B Limit)
                  </div>
                  <div className="text-[11px] text-[#847B73] mt-0.5">
                    Sends a ~1.7 KB payload to verify server MTU rejection and{" "}
                    <code className="font-mono">error</code> datagram response.
                  </div>
                </div>
                <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
              </button>
            </div>

            {testFeedback && (
              <div className="text-xs text-emerald-400 flex items-center gap-2 pt-1">
                <Send className="w-3.5 h-3.5" />
                <span>{testFeedback}</span>
              </div>
            )}
          </div>
        </section>

        {/* Live Datagram Wire Log */}
        <section className="rounded-2xl bg-[#18161A] border border-[#F5EFE6]/10 overflow-hidden">
          <div className="px-6 py-4 border-b border-[#F5EFE6]/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#F5EFE6]">
                Live Datagram Inspector
              </h2>
              <p className="text-xs text-[#847B73]">
                Real JSON datagrams transmitted and received by your local{" "}
                <code className="font-mono text-[#B8AFA4]">SOCK_DGRAM</code> socket
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 rounded-lg bg-[#111013] border border-[#F5EFE6]/10 self-start sm:self-auto">
              {(["all", "chat", "ack", "control"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setLogFilter(tab)}
                  className={`px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
                    logFilter === tab
                      ? "bg-[#7D1D33] text-[#F5EFE6]"
                      : "text-[#B8AFA4] hover:text-[#F5EFE6]"
                  }`}
                >
                  {tab === "ack" ? "ACKs" : tab}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#F5EFE6]/10 text-[#847B73] font-medium">
                  <th className="py-3 px-4">Direction</th>
                  <th className="py-3 px-4">Type</th>
                  <th className="py-3 px-4">Peer</th>
                  <th className="py-3 px-4">Ports (Src → Dst)</th>
                  <th className="py-3 px-4 text-right">Bytes</th>
                  <th className="py-3 px-4">Message ID</th>
                  <th className="py-3 px-4">Status / Note</th>
                  <th className="py-3 px-4 text-right">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F5EFE6]/6 font-mono-tabular">
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-[#847B73] font-sans">
                      No datagrams captured for this filter yet. Send a message or trigger a test above.
                    </td>
                  </tr>
                ) : (
                  filteredLogs.slice(0, 35).map((entry) => {
                    const isLost = entry.direction.includes("LOST");
                    const isOut = entry.direction.startsWith("OUT");
                    return (
                      <tr key={entry.id} className="hover:bg-[#221E24]/60 transition-colors">
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <span
                            className={
                              isLost
                                ? "text-rose-400 font-semibold"
                                : isOut
                                ? "text-[#E598A8]"
                                : "text-emerald-400"
                            }
                          >
                            {entry.direction}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-[#F5EFE6] whitespace-nowrap">
                          {entry.type}
                        </td>
                        <td className="py-2.5 px-4 text-[#B8AFA4] whitespace-nowrap">
                          {entry.peer || "—"}
                        </td>
                        <td className="py-2.5 px-4 text-[#B8AFA4] whitespace-nowrap">
                          :{entry.src_port} → :{entry.dst_port}
                        </td>
                        <td className="py-2.5 px-4 text-right text-[#F5EFE6] whitespace-nowrap">
                          {entry.bytes} B
                        </td>
                        <td className="py-2.5 px-4 text-[#847B73] whitespace-nowrap">
                          {entry.message_id || "—"}
                        </td>
                        <td className="py-2.5 px-4 text-[#B8AFA4] font-sans">
                          {entry.note || entry.status}
                        </td>
                        <td className="py-2.5 px-4 text-right text-[#847B73] whitespace-nowrap">
                          {new Date(entry.timestamp).toLocaleTimeString([], {
                            hour12: false,
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Academic Demonstration & Wireshark Guide */}
        <section className="space-y-4 pb-6">
          <h2 className="font-display text-lg font-semibold text-[#F5EFE6]">
            Academic Demonstration & Wireshark Reference
          </h2>

          <div className="grid md:grid-cols-2 gap-6">
            <div className="rounded-2xl bg-[#18161A] border border-[#F5EFE6]/10 p-6 space-y-3">
              <h3 className="font-display text-base font-semibold text-[#F5EFE6]">
                1. Wireshark Capture Instructions (Windows)
              </h3>
              <ol className="list-decimal list-inside space-y-2 text-xs text-[#B8AFA4] leading-relaxed">
                <li>
                  Open Wireshark on Windows and select{" "}
                  <strong className="text-[#F5EFE6]">Adapter for loopback traffic capture</strong>{" "}
                  (installed with Npcap) to inspect <code className="font-mono text-[#F5EFE6]">127.0.0.1</code> traffic, or your LAN Wi-Fi/Ethernet adapter when testing across two machines.
                </li>
                <li>
                  Apply the general UDP display filter:{" "}
                  <code className="font-mono text-[#F5EFE6] bg-[#111013] px-1.5 py-0.5 rounded">
                    udp
                  </code>
                </li>
                <li>
                  Isolate Datagram server traffic with port filter:{" "}
                  <code className="font-mono text-[#F5EFE6] bg-[#111013] px-1.5 py-0.5 rounded">
                    udp.port == 9001
                  </code>
                </li>
                <li>
                  Inspect the 8-byte UDP header (<code className="font-mono text-[#F5EFE6]">Source Port</code>,{" "}
                  <code className="font-mono text-[#F5EFE6]">Destination Port: 9001</code>,{" "}
                  <code className="font-mono text-[#F5EFE6]">Length</code>,{" "}
                  <code className="font-mono text-[#F5EFE6]">Checksum</code>) and expand{" "}
                  <code className="font-mono text-[#F5EFE6]">Data</code> to read the raw JSON payload.
                </li>
              </ol>
            </div>

            <div className="rounded-2xl bg-[#18161A] border border-[#F5EFE6]/10 p-6 space-y-3">
              <h3 className="font-display text-base font-semibold text-[#F5EFE6]">
                2. Source & Destination Ports Explained
              </h3>
              <p className="text-xs text-[#B8AFA4] leading-relaxed">
                The UDP server binds explicitly to well-known port{" "}
                <code className="font-mono text-[#F5EFE6]">9001</code> (the destination port for
                client-to-server datagrams). Each client bridge calls{" "}
                <code className="font-mono text-[#F5EFE6]">sock.bind(("0.0.0.0", 0))</code>, letting
                the OS assign a unique ephemeral source port (currently{" "}
                <code className="font-mono text-[#F5EFE6]">
                  :{metrics?.client_source_port ?? "—"}
                </code>
                ). The server uses <code className="font-mono text-[#F5EFE6]">recvfrom()</code> to
                learn each peer’s <code className="font-mono text-[#F5EFE6]">(IP, port)</code> tuple
                and route return datagrams without maintaining a TCP connection state machine.
              </p>
            </div>

            <div className="rounded-2xl bg-[#18161A] border border-[#F5EFE6]/10 p-6 space-y-3">
              <h3 className="font-display text-base font-semibold text-[#F5EFE6]">
                3. Why UDP Has No Three-Way Handshake
              </h3>
              <p className="text-xs text-[#B8AFA4] leading-relaxed">
                Unlike TCP (used by Connectly), which exchanges{" "}
                <code className="font-mono text-[#F5EFE6]">SYN → SYN-ACK → ACK</code> before
                sending application data and tracks byte-stream sequence numbers in the kernel,
                UDP is connectionless. A client immediately transmits an independent datagram via{" "}
                <code className="font-mono text-[#F5EFE6]">sendto()</code>. Online presence in
                Datagram therefore relies on periodic <code className="font-mono text-[#F5EFE6]">heartbeat</code>{" "}
                datagrams and server-side inactivity timeouts rather than a socket disconnect event.
              </p>
            </div>

            <div className="rounded-2xl bg-[#18161A] border border-[#F5EFE6]/10 p-6 space-y-3">
              <h3 className="font-display text-base font-semibold text-[#F5EFE6]">
                4. Demonstrating Packet Loss & Reliability Trade-offs
              </h3>
              <div className="flex items-start gap-2 text-xs text-[#B8AFA4] leading-relaxed">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p>
                  Set <strong className="text-[#F5EFE6]">Simulated Packet Loss</strong> to{" "}
                  <code className="font-mono text-[#F5EFE6]">50%</code> and toggle{" "}
                  <strong className="text-[#F5EFE6]">Application ACKs</strong> off to observe raw
                  UDP loss—messages vanish silently with zero retransmission. Then re-enable ACKs
                  with <code className="font-mono text-[#F5EFE6]">3</code> retries to see how
                  application-level recovery restores delivery on top of an unreliable transport.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
