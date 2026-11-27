import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  Phone,
  RefreshCw,
  Search,
  Send,
  Settings2,
  UserPlus,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { Avatar } from "../components/Avatar";
import type { BridgeConnectionState } from "../hooks/useDatagramSocket";
import type {
  ChatMessage,
  PeerUser,
  UdpDiagnostics,
  UserProfile,
} from "../types/datagram";

interface ChatDashboardProps {
  currentUser: UserProfile;
  peers: PeerUser[];
  selectedPeer: string | null;
  messages: ChatMessage[];
  loadingMessages: boolean;
  typingPeers: Record<string, boolean>;
  unreadByPeer: Record<string, number>;
  bridgeState: BridgeConnectionState;
  diagnostics: UdpDiagnostics | null;
  lastUdpError: string | null;
  onClearUdpError: () => void;
  onSelectPeer: (username: string) => void;
  onSendMessage: (recipient: string, text: string) => void;
  onSendTyping: (recipient: string, isTyping: boolean) => void;
  onRefreshPeers: () => void;
  onOpenProfile: () => void;
  onOpenDiagnostics: () => void;
  onStartCall: (recipient: string) => void;
  hasActiveCall: boolean;
}

const MAX_MESSAGE_CHARS = 950; // Keeps JSON datagram envelope comfortably under 1400 B MTU limit

function formatTime(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function renderStatusMeta(msg: ChatMessage) {
  switch (msg.status) {
    case "delivered":
      return (
        <span className="inline-flex items-center gap-1 text-emerald-400">
          <CheckCheck className="w-3.5 h-3.5" />
          <span>Delivered (ACK)</span>
        </span>
      );
    case "retrying":
      return (
        <span className="inline-flex items-center gap-1 text-amber-400">
          <Clock className="w-3.5 h-3.5" />
          <span>Retrying ({msg.retry_count})</span>
        </span>
      );
    case "unacknowledged":
      return (
        <span className="inline-flex items-center gap-1 text-rose-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>Missing ACK</span>
        </span>
      );
    case "dropped_sim":
      return (
        <span className="inline-flex items-center gap-1 text-rose-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>Packet Lost (Sim)</span>
        </span>
      );
    case "received_no_ack":
      return (
        <span className="inline-flex items-center gap-1 text-[#B8AFA4]">
          <span>Received · No ACK Mode</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-[#B8AFA4]">
          <Check className="w-3.5 h-3.5" />
          <span>Sent via UDP</span>
        </span>
      );
  }
}

export function ChatDashboard({
  currentUser,
  peers,
  selectedPeer,
  messages,
  loadingMessages,
  typingPeers,
  unreadByPeer,
  bridgeState,
  diagnostics,
  lastUdpError,
  onClearUdpError,
  onSelectPeer,
  onSendMessage,
  onSendTyping,
  onRefreshPeers,
  onOpenProfile,
  onOpenDiagnostics,
  onStartCall,
  hasActiveCall,
}: ChatDashboardProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [draft, setDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const isTypingRef = useRef(false);

  const activePeerObj = useMemo(
    () => peers.find((p) => p.username === selectedPeer) || null,
    [peers, selectedPeer]
  );

  const filteredPeers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = q
      ? peers.filter(
          (p) =>
            p.username.toLowerCase().includes(q) ||
            p.full_name.toLowerCase().includes(q)
        )
      : peers;

    // Sort: online first, then recent timestamp, then alphabetical
    return [...list].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      if (a.last_timestamp && b.last_timestamp) {
        return b.last_timestamp.localeCompare(a.last_timestamp);
      }
      if (a.last_timestamp) return -1;
      if (b.last_timestamp) return 1;
      return a.full_name.localeCompare(b.full_name);
    });
  }, [peers, searchQuery]);

  const onlinePeers = useMemo(
    () => filteredPeers.filter((p) => p.online),
    [filteredPeers]
  );
  const offlinePeers = useMemo(
    () => filteredPeers.filter((p) => !p.online),
    [filteredPeers]
  );

  // Auto-scroll chat feed
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, selectedPeer, typingPeers[selectedPeer || ""]]);

  const draftUtf8Bytes = useMemo(() => {
    return new TextEncoder().encode(draft).length;
  }, [draft]);

  const estimatedDatagramBytes = draftUtf8Bytes + 175;

  const handleDraftChange = (val: string) => {
    setDraft(val);
    if (!selectedPeer) return;

    if (val.trim().length > 0) {
      if (!isTypingRef.current) {
        isTypingRef.current = true;
        onSendTyping(selectedPeer, true);
      }
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
      }
      typingTimeoutRef.current = window.setTimeout(() => {
        isTypingRef.current = false;
        onSendTyping(selectedPeer, false);
      }, 1800);
    } else if (isTypingRef.current) {
      isTypingRef.current = false;
      onSendTyping(selectedPeer, false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedPeer) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (estimatedDatagramBytes > 1400) return;

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    if (isTypingRef.current) {
      isTypingRef.current = false;
      onSendTyping(selectedPeer, false);
    }

    onSendMessage(selectedPeer, trimmed);
    setDraft("");
  };

  const simLossActive = (diagnostics?.config.packet_loss_rate ?? 0) > 0;
  const ackDisabled = diagnostics ? !diagnostics.config.ack_enabled : false;

  const renderPeerRow = (peer: PeerUser) => {
    const isSelected = peer.username === selectedPeer;
    const isTyping = Boolean(typingPeers[peer.username]);
    const unread = unreadByPeer[peer.username] || 0;

    return (
      <button
        key={peer.username}
        type="button"
        onClick={() => onSelectPeer(peer.username)}
        className={`w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-left transition-colors ${
          isSelected
            ? "bg-gradient-to-r from-[#7D1D33]/35 to-[#4E1120]/20 border border-[#992641]/45"
            : "hover:bg-[#221E24] border border-transparent"
        }`}
      >
        <Avatar
          name={peer.full_name}
          username={peer.username}
          avatarUrl={peer.avatar_url}
          size="md"
          online={peer.online}
          showPresenceRing={true}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm text-[#F5EFE6] truncate">
              {peer.full_name}
            </span>
            <span className="text-[11px] font-mono-tabular text-[#847B73] shrink-0">
              {formatTime(peer.last_timestamp)}
            </span>
          </div>

          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span
              className={`text-xs truncate ${
                isTyping ? "text-[#E598A8] font-medium" : "text-[#B8AFA4]"
              }`}
            >
              {isTyping
                ? "typing over UDP..."
                : peer.last_message || `@${peer.username} · ${peer.online ? "Online" : "Offline"}`}
            </span>

            {unread > 0 && (
              <span className="text-[11px] font-mono-tabular font-semibold text-[#F5EFE6] bg-[#7D1D33] px-1.5 py-0.5 rounded-md shrink-0">
                {unread}
              </span>
            )}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex bg-[#111013]">
      {/* Left Sidebar: Profile, Search, Online & Recent Peers */}
      <aside
        className={`${
          selectedPeer ? "hidden md:flex" : "flex"
        } w-full md:w-80 lg:w-[340px] shrink-0 flex-col bg-[#18161A] border-r border-[#F5EFE6]/10 min-h-0`}
      >
        {/* User Profile Header */}
        <div className="p-4 border-b border-[#F5EFE6]/10 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onOpenProfile}
            className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-xl p-1.5 -m-1.5 hover:bg-[#221E24] transition-colors"
          >
            <Avatar
              name={currentUser.full_name}
              username={currentUser.username}
              avatarUrl={currentUser.avatar_url}
              size="md"
              online={bridgeState === "connected"}
              showPresenceRing={true}
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#F5EFE6] truncate">
                {currentUser.full_name}
              </div>
              <div className="text-xs text-[#B8AFA4] font-mono-tabular truncate">
                @{currentUser.username} ·{" "}
                {diagnostics
                  ? `UDP :${diagnostics.metrics.client_source_port}`
                  : bridgeState === "connected"
                  ? "UDP Bound"
                  : "Connecting..."}
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={onOpenProfile}
            aria-label="Open profile settings"
            className="p-2 rounded-lg text-[#B8AFA4] hover:text-[#F5EFE6] hover:bg-[#221E24] transition-colors shrink-0"
          >
            <Settings2 className="w-4 h-4" />
          </button>
        </div>

        {/* Search & Refresh */}
        <div className="p-3.5 border-b border-[#F5EFE6]/8 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-[#847B73] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search peers..."
              aria-label="Search conversations"
              className="w-full rounded-xl bg-[#111013] border border-[#F5EFE6]/10 pl-9 pr-3 py-2 text-xs text-[#F5EFE6] placeholder:text-[#847B73] focus:outline-none focus:border-[#992641]"
            />
          </div>
          <button
            type="button"
            onClick={onRefreshPeers}
            title="Refresh peer directory"
            aria-label="Refresh peer directory"
            className="p-2 rounded-xl bg-[#111013] border border-[#F5EFE6]/10 text-[#B8AFA4] hover:text-[#F5EFE6] hover:border-[#F5EFE6]/25 transition-colors shrink-0"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-5">
          {filteredPeers.length === 0 ? (
            <div className="px-4 py-10 text-center space-y-3">
              <div className="w-10 h-10 rounded-xl bg-[#221E24] border border-[#F5EFE6]/10 mx-auto flex items-center justify-center text-[#B8AFA4]">
                <UserPlus className="w-5 h-5" />
              </div>
              <div className="text-sm font-medium text-[#F5EFE6]">No peers available yet</div>
              <p className="text-xs text-[#847B73] leading-relaxed">
                Register another account in a second browser window or connect a CLI client
                using <code className="font-mono text-[#B8AFA4]">python backend/udp_client.py</code>{" "}
                to start sending UDP datagrams.
              </p>
            </div>
          ) : (
            <>
              {onlinePeers.length > 0 && (
                <div className="space-y-1">
                  <div className="px-3 py-1 flex items-center justify-between text-[11px] font-medium text-[#B8AFA4]">
                    <span>Online UDP Peers</span>
                    <span className="font-mono-tabular text-emerald-400">
                      {onlinePeers.length} Online
                    </span>
                  </div>
                  {onlinePeers.map(renderPeerRow)}
                </div>
              )}

              {offlinePeers.length > 0 && (
                <div className="space-y-1">
                  <div className="px-3 py-1 flex items-center justify-between text-[11px] font-medium text-[#847B73]">
                    <span>Recent & Offline Peers</span>
                    <span className="font-mono-tabular">{offlinePeers.length}</span>
                  </div>
                  {offlinePeers.map(renderPeerRow)}
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Main Chat Window */}
      <main
        className={`${
          selectedPeer ? "flex" : "hidden md:flex"
        } flex-1 flex-col min-w-0 min-h-0 bg-[#111013]`}
      >
        {!activePeerObj ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="max-w-md space-y-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#7D1D33]/40 to-[#221E24] border border-[#992641]/30 mx-auto flex items-center justify-center text-[#F5EFE6]">
                <Activity className="w-6 h-6" />
              </div>
              <h2 className="font-display text-2xl font-bold text-[#F5EFE6]">
                Select a peer to begin UDP messaging
              </h2>
              <p className="text-sm text-[#B8AFA4] leading-relaxed">
                Every message is serialized as a compact JSON datagram and routed by the
                Python <code className="font-mono text-[#F5EFE6]">SOCK_DGRAM</code> server
                on port <code className="font-mono text-[#F5EFE6]">9001</code> without a
                TCP handshake.
              </p>
              <div className="pt-2 flex flex-wrap items-center justify-center gap-3 text-xs text-[#847B73] font-mono-tabular">
                <span>
                  Bridge: {bridgeState === "connected" ? "Connected" : bridgeState}
                </span>
                <span>·</span>
                <span>
                  Local Source Port:{" "}
                  {diagnostics ? `:${diagnostics.metrics.client_source_port}` : "Pending"}
                </span>
                <span>·</span>
                <span>Sent: {diagnostics?.metrics.datagrams_sent ?? 0}</span>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Conversation Header */}
            <header className="px-5 py-3.5 bg-[#18161A] border-b border-[#F5EFE6]/10 flex items-center justify-between gap-4 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => onSelectPeer("")}
                  aria-label="Back to conversations"
                  className="md:hidden p-2 -ml-2 rounded-lg text-[#B8AFA4] hover:text-[#F5EFE6] hover:bg-[#221E24]"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>

                <Avatar
                  name={activePeerObj.full_name}
                  username={activePeerObj.username}
                  avatarUrl={activePeerObj.avatar_url}
                  size="md"
                  online={activePeerObj.online}
                  showPresenceRing={true}
                />

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="font-display text-base font-semibold text-[#F5EFE6] truncate">
                      {activePeerObj.full_name}
                    </h2>
                    <span className="text-xs font-mono-tabular text-[#847B73] truncate">
                      @{activePeerObj.username}
                    </span>
                  </div>

                  <div className="mt-0.5 flex items-center gap-2 text-xs">
                    {typingPeers[activePeerObj.username] ? (
                      <span className="text-[#E598A8] font-medium">
                        Typing over UDP...
                      </span>
                    ) : activePeerObj.online ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-400">
                        <Wifi className="w-3.5 h-3.5" />
                        <span>Online · Active UDP Peer</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[#847B73]">
                        <WifiOff className="w-3.5 h-3.5" />
                        <span>Offline · No Live UDP Route</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onStartCall(activePeerObj.username)}
                  disabled={!activePeerObj.online || hasActiveCall || bridgeState !== "connected"}
                  title={
                    !activePeerObj.online
                      ? "Peer is offline — UDP voice call requires an active peer"
                      : hasActiveCall
                      ? "A voice call is already active"
                      : "Start real-time UDP voice call"
                  }
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-[#7D1D33] hover:bg-[#992641] disabled:opacity-45 disabled:hover:bg-[#7D1D33] text-[#F5EFE6] transition-colors whitespace-nowrap shrink-0"
                >
                  <Phone className="w-3.5 h-3.5" />
                  <span>Voice Call</span>
                </button>

                <button
                  type="button"
                  onClick={onOpenDiagnostics}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium bg-[#221E24] hover:bg-[#2C262E] border border-[#F5EFE6]/10 text-[#F5EFE6] transition-colors whitespace-nowrap shrink-0"
                >
                  <Activity className="w-3.5 h-3.5 text-[#D4A7B0]" />
                  <span className="hidden sm:inline">Inspect UDP Wire</span>
                </button>
              </div>
            </header>

            {/* Simulation Warning Banner (only shown when loss simulation or no-ACK mode is enabled) */}
            {(simLossActive || ackDisabled) && (
              <div className="px-5 py-2 bg-[#7D1D33]/20 border-b border-[#992641]/30 flex items-center justify-between gap-4 text-xs text-[#F5EFE6]">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>
                    UDP Simulation Active:{" "}
                    {simLossActive
                      ? `${Math.round((diagnostics?.config.packet_loss_rate ?? 0) * 100)}% packet loss`
                      : ""}
                    {simLossActive && ackDisabled ? " · " : ""}
                    {ackDisabled ? "Application ACKs disabled (raw fire-and-forget)" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onOpenDiagnostics}
                  className="text-[#E598A8] hover:underline whitespace-nowrap shrink-0"
                >
                  Adjust in Diagnostics
                </button>
              </div>
            )}

            {/* Live UDP Error Banner */}
            {lastUdpError && (
              <div
                role="alert"
                className="px-5 py-2.5 bg-rose-500/10 border-b border-rose-500/25 flex items-center justify-between gap-4 text-xs text-rose-200"
              >
                <span>UDP Error Datagram: {lastUdpError}</span>
                <button
                  type="button"
                  onClick={onClearUdpError}
                  aria-label="Dismiss UDP error"
                  className="p-1 rounded hover:bg-rose-500/20"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Message Feed */}
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-4">
              {loadingMessages ? (
                <div className="space-y-3 py-4">
                  {[1, 2, 3].map((n) => (
                    <div
                      key={n}
                      className={`h-14 w-64 rounded-2xl bg-[#18161A] animate-pulse ${
                        n % 2 === 0 ? "ml-auto" : ""
                      }`}
                    />
                  ))}
                </div>
              ) : messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-12 space-y-2">
                  <p className="text-sm font-medium text-[#F5EFE6]">
                    No datagrams exchanged with @{activePeerObj.username} yet
                  </p>
                  <p className="text-xs text-[#847B73] max-w-sm">
                    Send your first message below. It will be transmitted as a connectionless
                    JSON UDP packet via <code className="font-mono text-[#B8AFA4]">SOCK_DGRAM</code>.
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isMine = msg.sender === currentUser.username;
                  return (
                    <div
                      key={msg.message_id}
                      className={`flex flex-col ${isMine ? "items-end" : "items-start"}`}
                    >
                      <div
                        className={`max-w-[82%] sm:max-w-[70%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words ${
                          isMine
                            ? "bg-gradient-to-br from-[#7D1D33] to-[#561323] text-[#F5EFE6] rounded-br-sm"
                            : "bg-[#221E24] border border-[#F5EFE6]/8 text-[#F5EFE6] rounded-bl-sm"
                        }`}
                      >
                        {msg.content}
                      </div>

                      <div className="mt-1 px-1 flex flex-wrap items-center gap-1.5 text-[11px] font-mono-tabular text-[#847B73]">
                        <span>{formatTime(msg.timestamp)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{msg.datagram_bytes || 0} B</span>
                        {msg.seq_num > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>#{msg.seq_num}</span>
                          </>
                        )}
                        {msg.out_of_order && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-400">Out of order</span>
                          </>
                        )}
                        {isMine && (
                          <>
                            <span aria-hidden="true">·</span>
                            {renderStatusMeta(msg)}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <form
              onSubmit={handleSubmit}
              className="p-4 bg-[#18161A] border-t border-[#F5EFE6]/10 shrink-0 space-y-2"
            >
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => handleDraftChange(e.target.value)}
                  maxLength={MAX_MESSAGE_CHARS}
                  placeholder={`Message @${activePeerObj.username} over UDP...`}
                  aria-label="Message input"
                  className="flex-1 rounded-xl bg-[#111013] border border-[#F5EFE6]/12 px-4 py-3 text-sm text-[#F5EFE6] placeholder:text-[#847B73] focus:outline-none focus:border-[#992641] transition-colors"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || estimatedDatagramBytes > 1400 || bridgeState !== "connected"}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#7D1D33] hover:bg-[#992641] disabled:opacity-45 disabled:hover:bg-[#7D1D33] px-5 py-3 text-sm font-semibold text-[#F5EFE6] transition-colors whitespace-nowrap shrink-0"
                >
                  <Send className="w-4 h-4" />
                  <span className="hidden sm:inline">Send</span>
                </button>
              </div>

              <div className="flex items-center justify-between text-[11px] font-mono-tabular text-[#847B73] px-1">
                <span>
                  Transport: UDP (SOCK_DGRAM) · No TCP Handshake
                </span>
                <span
                  className={
                    estimatedDatagramBytes > 1300
                      ? "text-amber-400"
                      : "text-[#847B73]"
                  }
                >
                  Est. Datagram: {estimatedDatagramBytes} / 1400 B MTU limit
                </span>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
