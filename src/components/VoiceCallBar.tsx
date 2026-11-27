import { useEffect, useState } from "react";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Radio,
  Volume2,
  Waves,
} from "lucide-react";
import { Avatar } from "./Avatar";
import type { PeerUser, VoiceCallSession } from "../types/datagram";

interface VoiceCallBarProps {
  call: VoiceCallSession;
  peer: PeerUser | null;
  onAccept: () => void;
  onDecline: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
  onToggleTestTone: () => void;
}

function formatDuration(startedAt: number | null, nowMs: number): string {
  if (!startedAt) return "00:00";
  const totalSec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function VoiceCallBar({
  call,
  peer,
  onAccept,
  onDecline,
  onEnd,
  onToggleMute,
  onToggleTestTone,
}: VoiceCallBarProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (call.phase !== "active" || !call.startedAt) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [call.phase, call.startedAt]);

  const displayName = peer?.full_name || `@${call.peerUsername}`;
  const avatarUrl = peer?.avatar_url || "monogram";

  if (call.phase === "incoming") {
    return (
      <div
        role="alertdialog"
        aria-label="Incoming UDP voice call"
        className="px-4 sm:px-6 py-3 bg-gradient-to-r from-[#4E1120] via-[#2A131A] to-[#18161A] border-b border-[#992641]/45 flex flex-wrap items-center justify-between gap-4 shrink-0"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Avatar
            name={displayName}
            username={call.peerUsername}
            avatarUrl={avatarUrl}
            size="md"
            online={true}
            showPresenceRing={true}
          />
          <div className="min-w-0">
            <div className="font-display text-sm font-semibold text-[#F5EFE6] truncate">
              Incoming UDP Voice Call from {displayName}
            </div>
            <div className="text-xs text-[#D4A7B0] font-mono-tabular">
              @{call.peerUsername} · 8 kHz μ-law over SOCK_DGRAM
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onDecline}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-[#221E24] hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition-colors whitespace-nowrap shrink-0"
          >
            <PhoneOff className="w-3.5 h-3.5" />
            Decline
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <Phone className="w-3.5 h-3.5" />
            Accept Call
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 py-3 bg-gradient-to-r from-[#2B1219] via-[#1C161A] to-[#18161A] border-b border-[#992641]/40 flex flex-wrap items-center justify-between gap-4 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <Avatar
          name={displayName}
          username={call.peerUsername}
          avatarUrl={avatarUrl}
          size="md"
          online={true}
          showPresenceRing={true}
        />

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-sm font-semibold text-[#F5EFE6] truncate">
              {displayName}
            </span>
            <span className="text-xs font-mono-tabular text-[#D4A7B0]">
              {call.phase === "outgoing"
                ? "Ringing over UDP..."
                : formatDuration(call.startedAt, nowMs)}
            </span>
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] font-mono-tabular text-[#B8AFA4]">
            <span className="inline-flex items-center gap-1 text-emerald-400">
              <Radio className="w-3 h-3" />
              UDP Voice (No ACKs)
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Tx {call.txFrames} / Rx {call.rxFrames} pkts
            </span>
            {call.phase === "active" && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <Volume2 className="w-3 h-3 text-[#D4A7B0]" />
                  Rx {Math.min(100, Math.round(call.rxLevel * 400))}%
                </span>
              </>
            )}
          </div>

          {call.micError && (
            <div className="mt-1 text-[11px] text-amber-300">
              Mic unavailable ({call.micError}). Use “Test Tone” to stream audio over UDP.
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {call.phase === "active" && (
          <>
            <button
              type="button"
              onClick={onToggleMute}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                call.muted
                  ? "bg-amber-500/15 border-amber-500/35 text-amber-300"
                  : "bg-[#221E24] hover:bg-[#2C262E] border-[#F5EFE6]/12 text-[#F5EFE6]"
              }`}
            >
              {call.muted ? (
                <>
                  <MicOff className="w-3.5 h-3.5" />
                  Muted
                </>
              ) : (
                <>
                  <Mic className="w-3.5 h-3.5" />
                  Mute
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onToggleTestTone}
              title="Transmit a gentle 440Hz tone over UDP when testing without a microphone"
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                call.testTone
                  ? "bg-[#7D1D33] border-[#992641] text-[#F5EFE6]"
                  : "bg-[#221E24] hover:bg-[#2C262E] border-[#F5EFE6]/12 text-[#B8AFA4]"
              }`}
            >
              <Waves className="w-3.5 h-3.5" />
              {call.testTone ? "Tone On" : "Test Tone"}
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onEnd}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white transition-colors whitespace-nowrap shrink-0"
        >
          <PhoneOff className="w-3.5 h-3.5" />
          End Call
        </button>
      </div>
    </div>
  );
}
