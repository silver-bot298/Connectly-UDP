import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, MessageSquare, Radio, User } from "lucide-react";
import { BrandMark } from "./components/BrandMark";
import { Avatar } from "./components/Avatar";
import { ProfileModal } from "./components/ProfileModal";
import { VoiceCallBar } from "./components/VoiceCallBar";
import { useDatagramSocket } from "./hooks/useDatagramSocket";
import { AuthPage } from "./pages/AuthPage";
import { ChatDashboard } from "./pages/ChatDashboard";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import { VoiceUdpEngine } from "./services/voiceAudio";
import {
  fetchConversation,
  fetchUsers,
  getAuthToken,
  setAuthToken,
} from "./services/api";
import type {
  AuthResponse,
  ChatMessage,
  MessageStatus,
  PeerUser,
  UserProfile,
  VoiceCallSession,
} from "./types/datagram";

type ActiveView = "chat" | "diagnostics";

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [token, setToken] = useState<string | null>(() => getAuthToken());
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [showProfileModal, setShowProfileModal] = useState(false);

  const [peers, setPeers] = useState<PeerUser[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [messagesByPeer, setMessagesByPeer] = useState<Record<string, ChatMessage[]>>({});
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});

  // Voice Call State
  const [voiceCall, setVoiceCall] = useState<VoiceCallSession | null>(null);
  const voiceCallRef = useRef<VoiceCallSession | null>(null);
  voiceCallRef.current = voiceCall;
  const voiceEngineRef = useRef<VoiceUdpEngine | null>(null);
  const sendVoiceFrameRef = useRef<
    ((recipient: string, callId: string, seq: number, audio: string) => boolean) | null
  >(null);
  const sendCallAnswerRef = useRef<
    ((recipient: string, callId: string, accepted: boolean) => boolean) | null
  >(null);

  const getVoiceEngine = useCallback(() => {
    if (!voiceEngineRef.current) {
      voiceEngineRef.current = new VoiceUdpEngine();
    }
    return voiceEngineRef.current;
  }, []);

  const teardownCall = useCallback(() => {
    voiceEngineRef.current?.stop();
    setVoiceCall(null);
  }, []);

  useEffect(() => {
    return () => {
      voiceEngineRef.current?.stop();
    };
  }, []);

  const refreshPeers = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetchUsers();
      setPeers(res.users);
    } catch {
      // ignore transient errors
    }
  }, [token]);

  useEffect(() => {
    if (!token || !user) return;
    refreshPeers();
    const interval = window.setInterval(refreshPeers, 8000);
    return () => window.clearInterval(interval);
  }, [token, user, refreshPeers]);

  // Load SQLite conversation history when selecting a peer
  useEffect(() => {
    if (!token || !selectedPeer) return;
    let cancelled = false;
    setLoadingMessages(true);
    fetchConversation(selectedPeer)
      .then((res) => {
        if (!cancelled) {
          setMessagesByPeer((prev) => ({
            ...prev,
            [selectedPeer]: res.messages,
          }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });

    setUnreadByPeer((prev) => {
      if (!prev[selectedPeer]) return prev;
      const next = { ...prev };
      delete next[selectedPeer];
      return next;
    });

    return () => {
      cancelled = true;
    };
  }, [token, selectedPeer]);

  const appendOrUpdateMessage = useCallback(
    (peerUsername: string, msg: ChatMessage) => {
      setMessagesByPeer((prev) => {
        const list = prev[peerUsername] || [];
        const existsIdx = list.findIndex((m) => m.message_id === msg.message_id);
        if (existsIdx >= 0) {
          const next = [...list];
          next[existsIdx] = { ...next[existsIdx], ...msg };
          return { ...prev, [peerUsername]: next };
        }
        return { ...prev, [peerUsername]: [...list, msg] };
      });
    },
    []
  );

  const handleIncomingMessage = useCallback(
    (msg: ChatMessage) => {
      const peerUsername = msg.sender;
      appendOrUpdateMessage(peerUsername, msg);

      setPeers((prev) => {
        const found = prev.some((p) => p.username === peerUsername);
        if (!found) {
          refreshPeers();
          return prev;
        }
        return prev.map((p) =>
          p.username === peerUsername
            ? {
                ...p,
                last_message: msg.content,
                last_timestamp: msg.timestamp,
                last_sender: msg.sender,
                last_status: msg.status,
              }
            : p
        );
      });

      if (selectedPeer !== peerUsername || activeView !== "chat") {
        setUnreadByPeer((prev) => ({
          ...prev,
          [peerUsername]: (prev[peerUsername] || 0) + 1,
        }));
      }
    },
    [appendOrUpdateMessage, selectedPeer, activeView, refreshPeers]
  );

  const handleMessageSent = useCallback(
    (msg: ChatMessage) => {
      const peerUsername = msg.recipient;
      appendOrUpdateMessage(peerUsername, msg);
      setPeers((prev) =>
        prev.map((p) =>
          p.username === peerUsername
            ? {
                ...p,
                last_message: msg.content,
                last_timestamp: msg.timestamp,
                last_sender: msg.sender,
                last_status: msg.status,
              }
            : p
        )
      );
    },
    [appendOrUpdateMessage]
  );

  const handleMessageStatus = useCallback(
    (messageId: string, status: MessageStatus, retryCount?: number) => {
      setMessagesByPeer((prev) => {
        let changed = false;
        const next: Record<string, ChatMessage[]> = {};
        for (const [peer, list] of Object.entries(prev)) {
          const idx = list.findIndex((m) => m.message_id === messageId);
          if (idx >= 0) {
            changed = true;
            const updatedList = [...list];
            updatedList[idx] = {
              ...updatedList[idx],
              status,
              retry_count: retryCount ?? updatedList[idx].retry_count,
            };
            next[peer] = updatedList;
          } else {
            next[peer] = list;
          }
        }
        return changed ? next : prev;
      });
    },
    []
  );

  const handlePresenceUpdate = useCallback(
    (onlineList: string[]) => {
      const onlineSet = new Set(onlineList);
      setPeers((prev) => {
        const knownUsernames = new Set(prev.map((p) => p.username));
        const hasNewUnknown = onlineList.some(
          (u) => u !== user?.username && !knownUsernames.has(u)
        );
        if (hasNewUnknown) {
          refreshPeers();
        }
        return prev.map((p) => ({
          ...p,
          online: onlineSet.has(p.username),
        }));
      });
    },
    [user?.username, refreshPeers]
  );

  const beginMediaStream = useCallback(
    async (peerUsername: string, callId: string) => {
      const engine = getVoiceEngine();
      engine.stopRingtone();

      const res = await engine.startCapture((b64, seq, rmsLevel) => {
        const active = voiceCallRef.current;
        if (!active || active.callId !== callId || active.phase !== "active") return;
        sendVoiceFrameRef.current?.(peerUsername, callId, seq, b64);
        setVoiceCall((prev) =>
          prev && prev.callId === callId
            ? { ...prev, txFrames: prev.txFrames + 1, txLevel: rmsLevel }
            : prev
        );
      });

      if (!res.micGranted) {
        setVoiceCall((prev) =>
          prev && prev.callId === callId
            ? { ...prev, micError: res.error || "Microphone unavailable" }
            : prev
        );
      }
    },
    [getVoiceEngine]
  );

  const handleCallInvite = useCallback(
    (sender: string, callId: string) => {
      if (voiceCallRef.current) {
        sendCallAnswerRef.current?.(sender, callId, false);
        return;
      }
      setVoiceCall({
        callId,
        peerUsername: sender,
        phase: "incoming",
        startedAt: null,
        muted: false,
        testTone: false,
        micError: null,
        txFrames: 0,
        rxFrames: 0,
        rxLevel: 0,
        txLevel: 0,
      });
      getVoiceEngine().startRingtone("incoming");
    },
    [getVoiceEngine]
  );

  const handleCallAnswer = useCallback(
    (sender: string, callId: string, accepted: boolean) => {
      const current = voiceCallRef.current;
      if (!current || current.callId !== callId || current.peerUsername !== sender) {
        return;
      }
      if (!accepted) {
        teardownCall();
        return;
      }
      setVoiceCall((prev) =>
        prev && prev.callId === callId
          ? { ...prev, phase: "active", startedAt: Date.now() }
          : prev
      );
      beginMediaStream(sender, callId);
    },
    [beginMediaStream, teardownCall]
  );

  const handleCallEnd = useCallback(
    (sender: string, callId: string) => {
      const current = voiceCallRef.current;
      if (current && current.callId === callId && current.peerUsername === sender) {
        teardownCall();
      }
    },
    [teardownCall]
  );

  const handleVoiceFrame = useCallback(
    (sender: string, callId: string, _seq: number, audio: string) => {
      const current = voiceCallRef.current;
      if (!current || current.callId !== callId || current.peerUsername !== sender) {
        return;
      }
      const rxLevel = getVoiceEngine().playFrame(audio);
      setVoiceCall((prev) =>
        prev && prev.callId === callId
          ? { ...prev, rxFrames: prev.rxFrames + 1, rxLevel }
          : prev
      );
    },
    [getVoiceEngine]
  );

  const {
    bridgeState,
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
  } = useDatagramSocket({
    token,
    username: user?.username ?? null,
    onIncomingMessage: handleIncomingMessage,
    onMessageSent: handleMessageSent,
    onMessageStatus: handleMessageStatus,
    onPresenceUpdate: handlePresenceUpdate,
    onCallInvite: handleCallInvite,
    onCallAnswer: handleCallAnswer,
    onCallEnd: handleCallEnd,
    onVoiceFrame: handleVoiceFrame,
  });

  sendVoiceFrameRef.current = sendVoiceFrame;
  sendCallAnswerRef.current = sendCallAnswer;

  const handleStartCall = useCallback(
    (recipient: string) => {
      if (voiceCallRef.current) return;
      const callId = `call-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      setVoiceCall({
        callId,
        peerUsername: recipient,
        phase: "outgoing",
        startedAt: null,
        muted: false,
        testTone: false,
        micError: null,
        txFrames: 0,
        rxFrames: 0,
        rxLevel: 0,
        txLevel: 0,
      });
      sendCallInvite(recipient, callId);
      getVoiceEngine().startRingtone("outgoing");
    },
    [getVoiceEngine, sendCallInvite]
  );

  const handleAcceptCall = useCallback(() => {
    const current = voiceCallRef.current;
    if (!current || current.phase !== "incoming") return;
    setSelectedPeer(current.peerUsername);
    setActiveView("chat");
    setVoiceCall((prev) =>
      prev ? { ...prev, phase: "active", startedAt: Date.now() } : null
    );
    sendCallAnswer(current.peerUsername, current.callId, true);
    beginMediaStream(current.peerUsername, current.callId);
  }, [beginMediaStream, sendCallAnswer]);

  const handleDeclineCall = useCallback(() => {
    const current = voiceCallRef.current;
    if (!current) return;
    sendCallAnswer(current.peerUsername, current.callId, false);
    teardownCall();
  }, [sendCallAnswer, teardownCall]);

  const handleEndCall = useCallback(() => {
    const current = voiceCallRef.current;
    if (!current) return;
    sendCallEnd(current.peerUsername, current.callId, "hangup");
    teardownCall();
  }, [sendCallEnd, teardownCall]);

  const handleToggleMute = useCallback(() => {
    setVoiceCall((prev) => {
      if (!prev) return null;
      const nextMuted = !prev.muted;
      getVoiceEngine().setMuted(nextMuted);
      return { ...prev, muted: nextMuted };
    });
  }, [getVoiceEngine]);

  const handleToggleTestTone = useCallback(() => {
    setVoiceCall((prev) => {
      if (!prev) return null;
      const nextTone = !prev.testTone;
      getVoiceEngine().setTestTone(nextTone);
      return { ...prev, testTone: nextTone };
    });
  }, [getVoiceEngine]);

  const callPeerObj = useMemo(
    () =>
      voiceCall
        ? peers.find((p) => p.username === voiceCall.peerUsername) || null
        : null,
    [peers, voiceCall]
  );

  const handleAuthenticated = (auth: AuthResponse) => {
    setAuthToken(auth.token);
    setToken(auth.token);
    setUser(auth.user);
    setActiveView("chat");
  };

  const handleLogout = () => {
    if (voiceCallRef.current) {
      sendCallEnd(voiceCallRef.current.peerUsername, voiceCallRef.current.callId, "logout");
    }
    teardownCall();
    setAuthToken(null);
    setToken(null);
    setUser(null);
    setPeers([]);
    setSelectedPeer(null);
    setMessagesByPeer({});
    setUnreadByPeer({});
    setShowProfileModal(false);
  };

  if (!user || !token) {
    return <AuthPage onAuthenticated={handleAuthenticated} />;
  }

  const totalUnread = Object.values(unreadByPeer).reduce((acc, n) => acc + n, 0);

  return (
    <div className="h-screen w-full flex flex-col bg-[#111013] text-[#F5EFE6] overflow-hidden">
      {/* Three-Zone Top Bar */}
      <header className="h-14 px-4 sm:px-6 bg-[#18161A] border-b border-[#F5EFE6]/10 flex items-center justify-between gap-4 sm:gap-8 shrink-0">
        <BrandMark compact />

        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Workspace navigation">
          <button
            type="button"
            onClick={() => setActiveView("chat")}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeView === "chat"
                ? "bg-[#7D1D33] text-[#F5EFE6]"
                : "text-[#B8AFA4] hover:text-[#F5EFE6] hover:bg-[#221E24]"
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Messages</span>
            {totalUnread > 0 && (
              <span className="font-mono-tabular text-[11px] bg-[#111013]/60 px-1.5 rounded">
                {totalUnread}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveView("diagnostics");
              refreshDiagnostics();
            }}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeView === "diagnostics"
                ? "bg-[#7D1D33] text-[#F5EFE6]"
                : "text-[#B8AFA4] hover:text-[#F5EFE6] hover:bg-[#221E24]"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>UDP Diagnostics</span>
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden lg:flex items-center gap-2 text-xs font-mono-tabular">
            <Radio
              className={`w-3.5 h-3.5 ${
                bridgeState === "connected" ? "text-emerald-400" : "text-amber-400"
              }`}
            />
            <span className={bridgeState === "connected" ? "text-emerald-400" : "text-amber-400"}>
              {bridgeState === "connected"
                ? `UDP :${diagnostics?.metrics.client_source_port ?? "—"}`
                : "Reconnecting"}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setShowProfileModal(true)}
            className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-[#221E24] hover:bg-[#2C262E] border border-[#F5EFE6]/10 text-xs font-medium text-[#F5EFE6] transition-colors whitespace-nowrap shrink-0"
          >
            <Avatar
              name={user.full_name}
              username={user.username}
              avatarUrl={user.avatar_url}
              size="sm"
            />
            <span className="hidden sm:inline max-w-[120px] truncate">
              @{user.username}
            </span>
            <User className="w-3.5 h-3.5 text-[#B8AFA4] sm:hidden" />
          </button>
        </div>
      </header>

      {/* Active / Incoming / Outgoing UDP Voice Call Bar */}
      {voiceCall && (
        <VoiceCallBar
          call={voiceCall}
          peer={callPeerObj}
          onAccept={handleAcceptCall}
          onDecline={handleDeclineCall}
          onEnd={handleEndCall}
          onToggleMute={handleToggleMute}
          onToggleTestTone={handleToggleTestTone}
        />
      )}

      {/* Main Workspace */}
      {activeView === "chat" ? (
        <ChatDashboard
          currentUser={user}
          peers={peers}
          selectedPeer={selectedPeer}
          messages={selectedPeer ? messagesByPeer[selectedPeer] || [] : []}
          loadingMessages={loadingMessages}
          typingPeers={typingPeers}
          unreadByPeer={unreadByPeer}
          bridgeState={bridgeState}
          diagnostics={diagnostics}
          lastUdpError={lastUdpError}
          onClearUdpError={clearUdpError}
          onSelectPeer={(uname) => setSelectedPeer(uname || null)}
          onSendMessage={sendMessage}
          onSendTyping={sendTyping}
          onRefreshPeers={refreshPeers}
          onOpenProfile={() => setShowProfileModal(true)}
          onOpenDiagnostics={() => {
            setActiveView("diagnostics");
            refreshDiagnostics();
          }}
          onStartCall={handleStartCall}
          hasActiveCall={Boolean(voiceCall)}
        />
      ) : (
        <DiagnosticsPage
          currentUser={user}
          peers={peers}
          selectedPeer={selectedPeer}
          diagnostics={diagnostics}
          onRefreshDiagnostics={refreshDiagnostics}
          onUpdateConfig={updateConfig}
          onSendDuplicateTest={(recipient) => sendDuplicateTest(recipient)}
          onSendReorderBurst={(recipient) => sendReorderBurst(recipient)}
          onSendOversizedTest={(recipient) => sendOversizedTest(recipient)}
        />
      )}

      {showProfileModal && (
        <ProfileModal
          user={user}
          diagnostics={diagnostics}
          onClose={() => setShowProfileModal(false)}
          onUserUpdated={(updated) => setUser(updated)}
          onLogout={handleLogout}
        />
      )}
    </div>
  );
}
