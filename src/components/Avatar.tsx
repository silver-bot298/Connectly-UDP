import { useState } from "react";

interface AvatarProps {
  name: string;
  username: string;
  avatarUrl: string;
  size?: "sm" | "md" | "lg";
  online?: boolean;
  showPresenceRing?: boolean;
}

const SIZE_CLASSES = {
  sm: "w-9 h-9 text-xs",
  md: "w-11 h-11 text-sm",
  lg: "w-16 h-16 text-lg",
};

function getInitials(name: string, username: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return (name.trim() || username).slice(0, 2).toUpperCase();
}

export function Avatar({
  name,
  username,
  avatarUrl,
  size = "md",
  online,
  showPresenceRing = false,
}: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = Boolean(avatarUrl && avatarUrl !== "monogram" && !imgFailed);

  return (
    <div className="relative inline-flex shrink-0">
      <div
        className={`${SIZE_CLASSES[size]} rounded-xl overflow-hidden flex items-center justify-center bg-gradient-to-br from-[#6E182D] to-[#30121B] border border-[#F5EFE6]/12 text-[#F5EFE6] font-display font-semibold`}
      >
        {showImage ? (
          <img
            src={avatarUrl}
            alt={`${name} (@${username})`}
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <span>{getInitials(name, username)}</span>
        )}
      </div>

      {showPresenceRing && typeof online === "boolean" && (
        <span
          title={online ? "Online via UDP" : "Offline"}
          aria-label={online ? "Online" : "Offline"}
          className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#18161A] ${
            online ? "bg-emerald-400" : "bg-[#574F4A]"
          }`}
        />
      )}
    </div>
  );
}
