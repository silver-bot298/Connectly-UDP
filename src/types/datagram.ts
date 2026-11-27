export const PRESET_AVATARS = [
  {
    id: "/src/assets/images/avatar_portrait_one_1795788836099.jpg",
    label: "Studio Portrait I",
  },
  {
    id: "/src/assets/images/avatar_portrait_two_1795788838122.jpg",
    label: "Studio Portrait II",
  },
  {
    id: "/src/assets/images/avatar_portrait_three_1795788838243.jpg",
    label: "Studio Portrait III",
  },
  {
    id: "monogram",
    label: "Initials Monogram",
  },
] as const;

export const HERO_ARTWORK_URL = "/src/assets/images/datagram_hero_mesh_1795788836148.jpg";

export interface UserProfile {
  username: string;
  full_name: string;
  avatar_url: string;
  created_at: string;
}

export interface PeerUser extends UserProfile {
  online: boolean;
  last_message: string | null;
  last_timestamp: string | null;
  last_sender: string | null;
  last_status: string | null;
  unread_count?: number;
}

export type MessageStatus =
  | "sent"
  | "retrying"
  | "delivered"
  | "unacknowledged"
  | "dropped_sim"
  | "received_no_ack";

export interface ChatMessage {
  message_id: string;
  sender: string;
  recipient: string;
  content: string;
  timestamp: string;
  status: MessageStatus;
  retry_count: number;
  datagram_bytes: number;
  seq_num: number;
  out_of_order?: boolean;
}

export interface DatagramLogEntry {
  id: string;
  direction: "OUT" | "IN" | "OUT_LOST" | "IN_LOST";
  type: string;
  peer: string;
  src_port: number;
  dst_port: number;
  bytes: number;
  message_id: string;
  status: string;
  note: string;
  timestamp: string;
}

export interface UdpMetrics {
  server_ip: string;
  server_port: number;
  client_source_port: number;
  datagrams_sent: number;
  datagrams_received: number;
  acks_sent: number;
  acks_received: number;
  duplicates_detected: number;
  missing_acks: number;
  retransmissions: number;
  simulated_losses: number;
  out_of_order_count: number;
  voice_frames_sent?: number;
  voice_frames_received?: number;
  voice_out_of_order?: number;
}

export interface UdpConfig {
  ack_enabled: boolean;
  retry_enabled: boolean;
  max_retries: number;
  packet_loss_rate: number;
}

export interface UdpServerStats {
  datagrams_received?: number;
  datagrams_sent?: number;
  malformed_packets?: number;
  oversized_packets?: number;
  voice_frames_routed?: number;
  active_peers?: number;
  bind_host?: string;
  bind_port?: number;
  started_at?: string;
}

export interface UdpDiagnostics {
  metrics: UdpMetrics;
  config: UdpConfig;
  server_stats: UdpServerStats;
  online_users: string[];
  recent_datagrams: DatagramLogEntry[];
}

export interface AuthResponse {
  token: string;
  user: UserProfile;
}

export type CallPhase = "outgoing" | "incoming" | "active";

export interface VoiceCallSession {
  callId: string;
  peerUsername: string;
  phase: CallPhase;
  startedAt: number | null;
  muted: boolean;
  testTone: boolean;
  micError: string | null;
  txFrames: number;
  rxFrames: number;
  rxLevel: number;
  txLevel: number;
}
