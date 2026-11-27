import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  DatagramLogEntry,
  MessageStatus,
  UdpConfig,
  UdpDiagnostics,
} from "../types/datagram";

export type BridgeConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

interface UseDatagramSocketOptions {
  token: string | null;
  username: string | null;
  onIncomingMessage: (msg: ChatMessage) => void;
  onMessageSent: (msg: ChatMessage) => void;
  onMessageStatus: (messageId: string, status: MessageStatus, retryCount?: number) => void;
  onPresenceUpdate: (onlineUsers: string[]) => void;
  onCallInvite?: (sender: string, callId: string) => void;
  onCallAnswer?: (sender: string, callId: string, accepted: boolean) => void;
  onCallEnd?: (sender: string, callId: string, reason?: string) => void;
  onVoiceFrame?: (sender: string, callId: string, seq: number, audio: string) => void;
}

export function useDatagramSocket({
  token,
  username,
  onIncomingMessage,
  onMessageSent,
  onMessageStatus,
  onPresenceUpdate,
  onCallInvite,
  onCallAnswer,
  onCallEnd,
  onVoiceFrame,
}: UseDatagramSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const typingTimersRef = useRef<Record<string, number>>({});

  const [bridgeState, setBridgeState] = useState<BridgeConnectionState>("disconnected");
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [typingPeers, setTypingPeers] = useState<Record<string, boolean>>({});
  const [diagnostics, setDiagnostics] = useState<UdpDiagnostics | null>(null);
  const [lastUdpError, setLastUdpError] = useState<string | null>(null);

  // Keep latest callbacks in refs to avoid tearing down WS on state changes
  const callbacksRef = useRef({
    onIncomingMessage,
    onMessageSent,
    onMessageStatus,
    onPresenceUpdate,
    onCallInvite,
    onCallAnswer,
    onCallEnd,
    onVoiceFrame,
  });
  callbacksRef.current = {
    onIncomingMessage,
    onMessageSent,
    onMessageStatus,
    onPresenceUpdate,
    onCallInvite,
    onCallAnswer,
    onCallEnd,
    onVoiceFrame,
  };

  useEffect(() => {
    if (!token || !username) {
      setBridgeState("disconnected");
      setOnlineUsers([]);
      setTypingPeers({});
      setDiagnostics(null);
      return;
    }

    let cancelled = false;
    let attempt = 0;

    const connect = () => {
      if (cancelled) return;
      setBridgeState(attempt === 0 ? "connecting" : "reconnecting");

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) {
          ws.close();
          return;
        }
        attempt = 0;
        setBridgeState("connected");
        setLastUdpError(null);
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          switch (payload.event) {
            case "presence": {
              const online = Array.isArray(payload.online_users) ? payload.online_users : [];
              setOnlineUsers(online);
              callbacksRef.current.onPresenceUpdate(online);
              if (payload.server_stats) {
                setDiagnostics((prev) =>
                  prev
                    ? {
                        ...prev,
                        online_users: online,
                        server_stats: payload.server_stats,
                      }
                    : prev
                );
              }
              break;
            }
            case "chat_message": {
              if (payload.message) {
                const msg = payload.message as ChatMessage;
                callbacksRef.current.onIncomingMessage(msg);
                setTypingPeers((prev) => ({ ...prev, [msg.sender]: false }));
              }
              break;
            }
            case "message_sent": {
              if (payload.message) {
                callbacksRef.current.onMessageSent(payload.message as ChatMessage);
              }
              break;
            }
            case "message_status": {
              if (payload.message_id && payload.status) {
                callbacksRef.current.onMessageStatus(
                  payload.message_id,
                  payload.status as MessageStatus,
                  payload.retry_count
                );
              }
              break;
            }
            case "typing": {
              const sender = String(payload.sender || "");
              const isTyping = Boolean(payload.is_typing);
              if (sender) {
                setTypingPeers((prev) => ({ ...prev, [sender]: isTyping }));
                if (typingTimersRef.current[sender]) {
                  window.clearTimeout(typingTimersRef.current[sender]);
                }
                if (isTyping) {
                  typingTimersRef.current[sender] = window.setTimeout(() => {
                    setTypingPeers((prev) => ({ ...prev, [sender]: false }));
                  }, 3200);
                }
              }
              break;
            }
            case "diagnostics": {
              if (payload.diagnostics) {
                setDiagnostics(payload.diagnostics as UdpDiagnostics);
              }
              break;
            }
            case "datagram_log": {
              if (payload.entry) {
                const entry = payload.entry as DatagramLogEntry;
                setDiagnostics((prev) =>
                  prev
                    ? {
                        ...prev,
                        recent_datagrams: [entry, ...prev.recent_datagrams].slice(0, 80),
                      }
                    : prev
                );
              }
              break;
            }
            case "udp_error": {
              if (payload.message) {
                setLastUdpError(String(payload.message));
              }
              break;
            }
            case "call_invite": {
              if (payload.sender && payload.call_id) {
                callbacksRef.current.onCallInvite?.(
                  String(payload.sender),
                  String(payload.call_id)
                );
              }
              break;
            }
            case "call_answer": {
              if (payload.sender && payload.call_id) {
                callbacksRef.current.onCallAnswer?.(
                  String(payload.sender),
                  String(payload.call_id),
                  Boolean(payload.accepted)
                );
              }
              break;
            }
            case "call_end": {
              if (payload.sender && payload.call_id) {
                callbacksRef.current.onCallEnd?.(
                  String(payload.sender),
                  String(payload.call_id),
                  payload.reason ? String(payload.reason) : undefined
                );
              }
              break;
            }
            case "voice_frame": {
              if (payload.sender && payload.call_id && payload.audio) {
                callbacksRef.current.onVoiceFrame?.(
                  String(payload.sender),
                  String(payload.call_id),
                  Number(payload.seq || 0),
                  String(payload.audio)
                );
              }
              break;
            }
            default:
              break;
          }
        } catch {
          // ignore malformed WS frames
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setBridgeState("reconnecting");
        attempt += 1;
        const delay = Math.min(4000, 600 * attempt);
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      Object.values(typingTimersRef.current).forEach((t) => window.clearTimeout(t));
      typingTimersRef.current = {};
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [token, username]);

  const sendCommand = useCallback((cmd: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
      return true;
    }
    return false;
  }, []);

  const sendMessage = useCallback(
    (recipient: string, message: string) => {
      return sendCommand({ action: "send_message", recipient, message });
    },
    [sendCommand]
  );

  const sendTyping = useCallback(
    (recipient: string, isTyping: boolean) => {
      return sendCommand({ action: "typing", recipient, is_typing: isTyping });
    },
    [sendCommand]
  );

  const updateConfig = useCallback(
    (config: Partial<UdpConfig>) => {
      return sendCommand({ action: "update_config", ...config });
    },
    [sendCommand]
  );

  const sendDuplicateTest = useCallback(
    (recipient: string, message?: string) => {
      return sendCommand({ action: "send_duplicate_test", recipient, message });
    },
    [sendCommand]
  );

  const sendReorderBurst = useCallback(
    (recipient: string) => {
      return sendCommand({ action: "send_reorder_burst", recipient });
    },
    [sendCommand]
  );

  const sendOversizedTest = useCallback(
    (recipient: string) => {
      return sendCommand({ action: "send_oversized_test", recipient });
    },
    [sendCommand]
  );

  const refreshDiagnostics = useCallback(() => {
    return sendCommand({ action: "request_diagnostics" });
  }, [sendCommand]);

  const clearUdpError = useCallback(() => {
    setLastUdpError(null);
  }, []);

  const sendCallInvite = useCallback(
    (recipient: string, callId: string) => {
      return sendCommand({ action: "call_invite", recipient, call_id: callId });
    },
    [sendCommand]
  );

  const sendCallAnswer = useCallback(
    (recipient: string, callId: string, accepted: boolean) => {
      return sendCommand({
        action: "call_answer",
        recipient,
        call_id: callId,
        accepted,
      });
    },
    [sendCommand]
  );

  const sendCallEnd = useCallback(
    (recipient: string, callId: string, reason = "hangup") => {
      return sendCommand({
        action: "call_end",
        recipient,
        call_id: callId,
        reason,
      });
    },
    [sendCommand]
  );

  const sendVoiceFrame = useCallback(
    (recipient: string, callId: string, seq: number, audio: string) => {
      return sendCommand({
        action: "voice_frame",
        recipient,
        call_id: callId,
        seq,
        audio,
      });
    },
    [sendCommand]
  );

  return {
    bridgeState,
    onlineUsers,
    typingPeers,
    diagnostics,
    lastUdpError,
    clearUdpError,
    sendMessage,
    sendTyping,
    updateConfig,
    sendDuplicateTest,
    sendReorderBurst,
    sendOversizedTest,
    refreshDiagnostics,
    sendCallInvite,
    sendCallAnswer,
    sendCallEnd,
    sendVoiceFrame,
  };
}
