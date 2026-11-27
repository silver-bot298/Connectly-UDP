import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, Lock, UserCheck } from "lucide-react";
import { BrandMark } from "../components/BrandMark";
import { Avatar } from "../components/Avatar";
import { loginUser, registerUser } from "../services/api";
import {
  HERO_ARTWORK_URL,
  PRESET_AVATARS,
  type AuthResponse,
} from "../types/datagram";

interface AuthPageProps {
  onAuthenticated: (auth: AuthResponse) => void;
}

export function AuthPage({ onAuthenticated }: AuthPageProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [heroImgFailed, setHeroImgFailed] = useState(false);

  // Login & Register fields
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string>(PRESET_AVATARS[0].id);
  const [showPassword, setShowPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (nextMode: "login" | "register") => {
    setMode(nextMode);
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === "register") {
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }
    }

    setSubmitting(true);
    try {
      const auth =
        mode === "login"
          ? await loginUser({ username, password })
          : await registerUser({
              full_name: fullName,
              username,
              password,
              confirm_password: confirmPassword,
              avatar_url: avatarUrl,
            });
      onAuthenticated(auth);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#111013] text-[#F5EFE6] grid lg:grid-cols-12">
      {/* Left Editorial & Protocol Showcase */}
      <section className="relative lg:col-span-6 flex flex-col justify-between p-8 lg:p-14 overflow-hidden border-b lg:border-b-0 lg:border-r border-[#F5EFE6]/10 min-h-[340px]">
        {!heroImgFailed ? (
          <img
            src={HERO_ARTWORK_URL}
            alt="Architectural acoustic waveform representing connectionless UDP datagrams"
            referrerPolicy="no-referrer"
            onError={() => setHeroImgFailed(true)}
            className="absolute inset-0 w-full h-full object-cover opacity-55"
          />
        ) : null}
        <div
          className="absolute inset-0 bg-gradient-to-t from-[#111013] via-[#111013]/80 to-[#221016]/70"
          aria-hidden="true"
        />

        <div className="relative z-10 flex items-center justify-between">
          <BrandMark />
          <span className="text-xs font-mono-tabular text-[#B8AFA4]">
            AF_INET · SOCK_DGRAM · Port 9001
          </span>
        </div>

        <div className="relative z-10 max-w-xl my-10 lg:my-0 space-y-5">
          <p className="text-xs font-medium tracking-wide text-[#D4A7B0]">
            Connectionless Transport Messaging
          </p>
          <h1
            className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-[#F5EFE6] leading-[1.12]"
            style={{ textWrap: "balance" }}
          >
            Real-time messaging built directly on raw UDP datagrams.
          </h1>
          <p className="text-sm sm:text-base text-[#D3C9BD] leading-relaxed max-w-lg">
            DATAGRAM transmits every chat message, typing signal, heartbeat, and
            application-layer acknowledgement as independent JSON datagrams over Python
            UDP sockets—with live packet loss simulation and wire-level diagnostics.
          </p>
        </div>

        <div className="relative z-10 grid sm:grid-cols-3 gap-6 pt-6 border-t border-[#F5EFE6]/12 text-xs">
          <div>
            <div className="font-semibold text-[#F5EFE6]">Zero Handshake</div>
            <p className="mt-1 text-[#B8AFA4] leading-relaxed">
              No TCP 3-way SYN/ACK setup. Peers bind ephemeral ports and transmit immediately.
            </p>
          </div>
          <div>
            <div className="font-semibold text-[#F5EFE6]">App-Layer Reliability</div>
            <p className="mt-1 text-[#B8AFA4] leading-relaxed">
              Toggle custom ACKs, bounded retries, and duplicate detection above UDP.
            </p>
          </div>
          <div>
            <div className="font-semibold text-[#F5EFE6]">Live Wire Telemetry</div>
            <p className="mt-1 text-[#B8AFA4] leading-relaxed">
              Inspect sent datagrams, out-of-order arrivals, and missing ACKs in real time.
            </p>
          </div>
        </div>
      </section>

      {/* Right Authentication Form */}
      <section className="lg:col-span-6 flex items-center justify-center p-6 sm:p-10 lg:p-14 bg-[#111013]">
        <div className="w-full max-w-md space-y-7">
          <div className="space-y-2">
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-[#F5EFE6]">
              {mode === "login" ? "Sign in to Datagram" : "Create your account"}
            </h2>
            <p className="text-sm text-[#B8AFA4]">
              {mode === "login"
                ? "Connect your local Python client bridge to the UDP server."
                : "Register a new peer identity stored securely with salted scrypt hashing."}
            </p>
          </div>

          {/* Segmented Mode Control */}
          <div
            className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#18161A] border border-[#F5EFE6]/10"
            role="tablist"
            aria-label="Authentication mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              onClick={() => switchMode("login")}
              className={`py-2 px-4 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                mode === "login"
                  ? "bg-[#7D1D33] text-[#F5EFE6]"
                  : "text-[#B8AFA4] hover:text-[#F5EFE6]"
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              onClick={() => switchMode("register")}
              className={`py-2 px-4 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                mode === "register"
                  ? "bg-[#7D1D33] text-[#F5EFE6]"
                  : "text-[#B8AFA4] hover:text-[#F5EFE6]"
              }`}
            >
              Create Account
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "register" && (
              <>
                <div>
                  <label
                    htmlFor="auth-fullname"
                    className="block text-xs font-medium text-[#B8AFA4] mb-1.5"
                  >
                    Full Name
                  </label>
                  <input
                    id="auth-fullname"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Grace Agorson"
                    required
                    minLength={2}
                    maxLength={60}
                    autoComplete="name"
                    className="w-full rounded-xl bg-[#18161A] border border-[#F5EFE6]/12 px-4 py-3 text-sm text-[#F5EFE6] placeholder:text-[#847B73] focus:outline-none focus:border-[#992641] transition-colors"
                  />
                </div>

                <div>
                  <span className="block text-xs font-medium text-[#B8AFA4] mb-2">
                    Select Avatar
                  </span>
                  <div className="grid grid-cols-4 gap-2.5">
                    {PRESET_AVATARS.map((preset) => {
                      const active = avatarUrl === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => setAvatarUrl(preset.id)}
                          className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border transition-colors ${
                            active
                              ? "border-[#992641] bg-[#7D1D33]/20"
                              : "border-[#F5EFE6]/10 bg-[#18161A] hover:border-[#F5EFE6]/25"
                          }`}
                        >
                          <Avatar
                            name={fullName || username || "DG"}
                            username={username || "peer"}
                            avatarUrl={preset.id}
                            size="sm"
                          />
                          <span className="text-[11px] text-[#B8AFA4] truncate max-w-full">
                            {preset.id === "monogram"
                              ? "Initials"
                              : preset.label.replace("Studio ", "")}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            <div>
              <label
                htmlFor="auth-username"
                className="block text-xs font-medium text-[#B8AFA4] mb-1.5"
              >
                Username
              </label>
              <input
                id="auth-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="grace"
                required
                minLength={3}
                maxLength={24}
                autoComplete="username"
                className="w-full rounded-xl bg-[#18161A] border border-[#F5EFE6]/12 px-4 py-3 text-sm text-[#F5EFE6] placeholder:text-[#847B73] focus:outline-none focus:border-[#992641] transition-colors font-mono"
              />
            </div>

            <div>
              <label
                htmlFor="auth-password"
                className="block text-xs font-medium text-[#B8AFA4] mb-1.5"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  minLength={6}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="w-full rounded-xl bg-[#18161A] border border-[#F5EFE6]/12 pl-4 pr-11 py-3 text-sm text-[#F5EFE6] placeholder:text-[#847B73] focus:outline-none focus:border-[#992641] transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-[#847B73] hover:text-[#F5EFE6] transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {mode === "register" && (
              <div>
                <label
                  htmlFor="auth-confirm-password"
                  className="block text-xs font-medium text-[#B8AFA4] mb-1.5"
                >
                  Confirm Password
                </label>
                <input
                  id="auth-confirm-password"
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  className="w-full rounded-xl bg-[#18161A] border border-[#F5EFE6]/12 px-4 py-3 text-sm text-[#F5EFE6] placeholder:text-[#847B73] focus:outline-none focus:border-[#992641] transition-colors"
                />
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="rounded-xl bg-rose-500/10 border border-rose-500/25 px-4 py-3 text-xs text-rose-300"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#7D1D33] to-[#631528] hover:from-[#992641] hover:to-[#7D1D33] disabled:opacity-60 px-5 py-3.5 text-sm font-semibold text-[#F5EFE6] transition-all whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5EFE6]"
            >
              {mode === "login" ? (
                <>
                  <Lock className="w-4 h-4" />
                  {submitting ? "Connecting UDP Socket..." : "Sign In & Bind UDP Socket"}
                  <ArrowRight className="w-4 h-4" />
                </>
              ) : (
                <>
                  <UserCheck className="w-4 h-4" />
                  {submitting ? "Creating Account..." : "Create Account & Connect"}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <p className="text-xs text-[#847B73] leading-relaxed pt-2 border-t border-[#F5EFE6]/8">
            Tip for multi-user UDP testing: open a second browser window or run{" "}
            <code className="font-mono text-[#B8AFA4]">
              python backend/udp_client.py --username john --peer grace
            </code>{" "}
            to observe live datagram routing across independent source ports.
          </p>
        </div>
      </section>
    </div>
  );
}
