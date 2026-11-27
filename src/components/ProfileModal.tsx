import { useState, type FormEvent } from "react";
import { LogOut, Radio, Save, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { PRESET_AVATARS, type UdpDiagnostics, type UserProfile } from "../types/datagram";
import { updateProfile } from "../services/api";

interface ProfileModalProps {
  user: UserProfile;
  diagnostics: UdpDiagnostics | null;
  onClose: () => void;
  onUserUpdated: (user: UserProfile) => void;
  onLogout: () => void;
}

export function ProfileModal({
  user,
  diagnostics,
  onClose,
  onUserUpdated,
  onLogout,
}: ProfileModalProps) {
  const [fullName, setFullName] = useState(user.full_name);
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSavedNote(null);
    setSaving(true);
    try {
      const res = await updateProfile({ full_name: fullName, avatar_url: avatarUrl });
      onUserUpdated(res.user);
      setSavedNote("Profile updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-modal-title"
    >
      <div className="w-full max-w-lg rounded-2xl bg-[#18161A] border border-[#F5EFE6]/12 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#F5EFE6]/10">
          <h2 id="profile-modal-title" className="font-display text-lg font-semibold text-[#F5EFE6]">
            User Profile & UDP Endpoint
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close profile dialog"
            className="p-2 rounded-lg text-[#B8AFA4] hover:text-[#F5EFE6] hover:bg-[#221E24] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#992641]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-6">
          <div className="flex items-center gap-4">
            <Avatar
              name={fullName || user.full_name}
              username={user.username}
              avatarUrl={avatarUrl}
              size="lg"
              online={true}
              showPresenceRing={true}
            />
            <div className="min-w-0">
              <div className="font-display text-xl font-semibold text-[#F5EFE6] truncate">
                {user.full_name}
              </div>
              <div className="text-sm text-[#B8AFA4] font-mono-tabular">
                @{user.username}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-emerald-400">
                <Radio className="w-3.5 h-3.5" />
                <span>Online · Active UDP Peer</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-[#111013] border border-[#F5EFE6]/8 px-4 py-3 grid grid-cols-2 gap-4 text-xs">
            <div>
              <div className="text-[#847B73]">UDP Server Target</div>
              <div className="mt-0.5 font-mono-tabular text-[#F5EFE6]">
                {diagnostics
                  ? `${diagnostics.metrics.server_ip}:${diagnostics.metrics.server_port}`
                  : "127.0.0.1:9001"}
              </div>
            </div>
            <div>
              <div className="text-[#847B73]">Local UDP Source Port</div>
              <div className="mt-0.5 font-mono-tabular text-[#F5EFE6]">
                {diagnostics ? `:${diagnostics.metrics.client_source_port}` : "Binding..."}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label
                htmlFor="profile-full-name"
                className="block text-xs font-medium text-[#B8AFA4] mb-1.5"
              >
                Full Name
              </label>
              <input
                id="profile-full-name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                minLength={2}
                maxLength={60}
                className="w-full rounded-xl bg-[#111013] border border-[#F5EFE6]/12 px-3.5 py-2.5 text-sm text-[#F5EFE6] placeholder:text-[#847B73] focus:outline-none focus:border-[#992641]"
              />
            </div>

            <div>
              <span className="block text-xs font-medium text-[#B8AFA4] mb-2">
                Profile Avatar
              </span>
              <div className="grid grid-cols-4 gap-3">
                {PRESET_AVATARS.map((preset) => {
                  const selected = avatarUrl === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setAvatarUrl(preset.id)}
                      className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border transition-colors ${
                        selected
                          ? "border-[#992641] bg-[#7D1D33]/20"
                          : "border-[#F5EFE6]/10 bg-[#111013] hover:border-[#F5EFE6]/25"
                      }`}
                    >
                      <Avatar
                        name={fullName || user.full_name}
                        username={user.username}
                        avatarUrl={preset.id}
                        size="sm"
                      />
                      <span className="text-[11px] text-[#B8AFA4] truncate max-w-full">
                        {preset.id === "monogram" ? "Initials" : preset.label.replace("Studio ", "")}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {error && (
            <p className="text-xs text-rose-400" role="alert">
              {error}
            </p>
          )}
          {savedNote && (
            <p className="text-xs text-emerald-400" role="status">
              {savedNote}
            </p>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-[#F5EFE6]/10">
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium text-rose-300 hover:text-rose-200 hover:bg-rose-500/10 border border-rose-500/20 transition-colors whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-medium text-[#B8AFA4] hover:text-[#F5EFE6] hover:bg-[#221E24] transition-colors whitespace-nowrap shrink-0"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium bg-[#7D1D33] hover:bg-[#992641] disabled:opacity-50 text-[#F5EFE6] transition-colors whitespace-nowrap shrink-0"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
